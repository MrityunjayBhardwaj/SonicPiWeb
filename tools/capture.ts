/**
 * Browser capture tool — runs Sonic Pi code in the real app via Playwright,
 * captures everything the browser produces, dumps it to .captures/ for
 * Claude to read and diagnose.
 *
 * This is an observation tool, not a test. Zero assertions.
 * It captures what IS, not what should be.
 *
 * Usage:
 *   npx tsx tools/capture.ts                          # run default example
 *   npx tsx tools/capture.ts "play 60; sleep 1"       # run inline code
 *   npx tsx tools/capture.ts --file path/to/code.rb   # run from file
 *   npx tsx tools/capture.ts --example "Minimal Techno"  # run built-in example
 *   npx tsx tools/capture.ts --all-examples            # run all built-in examples
 *   npx tsx tools/capture.ts --batch tests/book-examples/community  # batch a fixture dir
 *   npx tsx tools/capture.ts --duration 15000          # run for 15 seconds
 */

import { chromium, firefox, type Browser } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync, statSync, readdirSync } from 'fs'
import { resolve, dirname, basename, extname, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const DEFAULT_DURATION = 8000

// ---------------------------------------------------------------------------
// Capture everything the browser produces
// ---------------------------------------------------------------------------

interface CaptureResult {
  timestamp: string
  code: string
  duration: number
  url: string
  browser: string

  // Everything from the browser
  console: { type: string; text: string; time: number }[]
  pageErrors: { message: string; time: number }[]
  networkErrors: { url: string; status: number; time: number }[]
  appConsoleText: string
  appFullText: string

  // Engine-level captures (issue #221) — hooked via __spw_engine setter
  // BEFORE Run click, so we capture every puts/cue/warning from app start
  // without depending on Console ring-buffer scrollback or DOM textContent
  // slicing. `warnings` is the SP95-loud channel (#350/#351 build-time
  // limitations + future lints) — a real user sees these in `.spw-console`
  // via the theme.warning hue; this array is the headless / dashboard view.
  puts: { t: number; msg: string }[]
  cues: { t: number; name: string; audioTime: number }[]
  warnings: { t: number; title: string; msg: string }[]

  // Screenshots
  screenshotBefore: string  // path
  screenshotAfter: string   // path

  // Audio capture (WAV file)
  audioPath: string | null
  // Diagnostic — populated when audioPath is null. Lets downstream consumers
  // (the comparator) distinguish "engine produced no audio" from "capture
  // tool failed to resolve the blob in time" — see #358.
  audioPathReason: string | null
  audioStats: { duration: number; peak: number; rms: number; clipping: number } | null

  // Derived
  errorSummary: string[]
  warningsSummary: string[]
}

async function captureRun(
  browser: Browser,
  code: string,
  opts: { duration?: number; name?: string; wrapRecordingSec?: number } = {}
): Promise<CaptureResult> {
  const duration = opts.duration ?? DEFAULT_DURATION
  const name = opts.name ?? 'capture'
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = `${ts}_${safeName}`

  if (opts.wrapRecordingSec !== undefined && opts.wrapRecordingSec > 0) {
    // Wrap user code so recording is DSL-driven on this side too — matches
    // tools/capture-desktop.ts so both sides record from the same virtual
    // t=0 to t=duration. Recording calls (start/stop/save) must stay BARE at
    // top level — the transpiler wraps them into a single __run_once whose
    // main thread controls the recording window. (Earlier attempt with
    // recording_stop/save INSIDE in_thread broke: recording state isn't
    // visible across thread boundaries — issue #266.)
    const dur = opts.wrapRecordingSec
    // Only wrap in `in_thread` when user code might block the main thread
    // long enough that recording_stop never fires. Code containing top-level
    // `live_loop` or `in_thread` is already async-by-construction (registration
    // returns immediately, scheduler runs the body), so wrapping it adds no
    // benefit AND breaks `with_fx` semantics: when the transpiler sees
    // `with_fx ... do live_loop ... end end` inside `in_thread`, it emits
    // `__b.with_fx` and `__b.live_loop` (builder-method path), which doesn't
    // wire the FX bus to the loop's outBus the way the top-level
    // `topLevelWithFx` / `fxAwareWrappedLiveLoop` path does. Result: dry
    // signal in the capture even though desktop hears the FX.
    //
    // Heuristic: regex-detect `live_loop` or `in_thread` as standalone
    // identifiers at column-zero-ish positions. Strings/comments containing
    // these words are rare in test snippets; false positives just degrade
    // to "skipped wrap" which is safe for short snippets too.
    const alreadyAsync = /^[ \t]*(?:live_loop|in_thread)\b/m.test(code)
    // with_bpm 60 around the sleep so a user's `use_bpm 120` (or any other
    // tempo set inside <code>) doesn't shrink/expand the recording window.
    // At 60 BPM, sleep N == N real seconds.
    if (alreadyAsync) {
      // User code returns immediately (live_loop registers + exits, in_thread
      // detaches). Run at top level so with_fx → topLevelWithFx and live_loop
      // → fxAwareWrappedLiveLoop fire correctly.
      code =
        `recording_stop\n` +
        `recording_start\n` +
        `${code}\n` +
        `with_bpm 60 do\n` +
        `  sleep ${dur}\n` +
        `end\n` +
        `recording_stop\n` +
        `recording_save "spw_capture_${ts}.wav"\n`
    } else {
      // User code may block the main thread (e.g., `100.times do play; sleep`).
      // Push it into `in_thread` so the recording-window timeline is
      // independent. with_fx parity isn't a concern here — there's no
      // top-level live_loop registration to break.
      code =
        `recording_stop\n` +
        `recording_start\n` +
        `in_thread do\n` +
        `${code}\n` +
        `end\n` +
        `with_bpm 60 do\n` +
        `  sleep ${dur}\n` +
        `end\n` +
        `recording_stop\n` +
        `recording_save "spw_capture_${ts}.wav"\n`
    }
  }

  const context = await browser.newContext({
    acceptDownloads: true,
  })
  // #358 fix: install the URL.createObjectURL / anchor-click patch via
  // addInitScript so it runs BEFORE any page script on every navigation.
  // Previous attempt used page.evaluate after page.goto, which (a) could miss
  // a createObjectURL call from module-level code, and (b) the patched globals
  // could be wiped if the page navigates / Vite HMR refreshes after Run.
  // addInitScript is the bulletproof way to monkey-patch globals in Playwright.
  await context.addInitScript(() => {
    ;(window as any).__capturedWavBlob = null
    ;(window as any).__captureDiag = {
      createObjectURLCalls: 0,
      blobsTracked: 0,
      anchorClicksTotal: 0,
      anchorClicksWavBlob: 0,
      blobLookupHits: 0,
      blobLookupMisses: 0,
      initScriptRan: true,
    }
    const blobMap: Map<string, Blob> = new Map()
    const origCreate = URL.createObjectURL.bind(URL)
    const origRevoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = function (obj: Blob | MediaSource): string {
      const url = origCreate(obj)
      ;(window as any).__captureDiag.createObjectURLCalls++
      if (obj instanceof Blob) {
        blobMap.set(url, obj)
        ;(window as any).__captureDiag.blobsTracked++
      }
      return url
    }
    URL.revokeObjectURL = function (url: string): void {
      origRevoke(url)
      // Side-map entry kept alive — Recorder.ts:223 revokes synchronously after
      // a.click(); the click interceptor still needs to resolve the Blob.
    }
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      ;(window as any).__captureDiag.anchorClicksTotal++
      if (this.href?.startsWith('blob:') && this.download?.endsWith('.wav')) {
        ;(window as any).__captureDiag.anchorClicksWavBlob++
        const blob = blobMap.get(this.href)
        if (blob) {
          ;(window as any).__captureDiag.blobLookupHits++
          ;(window as any).__capturedWavBlob = blob
        } else {
          ;(window as any).__captureDiag.blobLookupMisses++
          // Fallback — should not fire when the createObjectURL patch is live.
          fetch(this.href).then(r => r.blob()).then(b => { (window as any).__capturedWavBlob = b }).catch(() => {})
        }
      } else {
        origClick.call(this)
      }
    }
  })
  const page = await context.newPage()

  const consoleLog: CaptureResult['console'] = []
  const pageErrors: CaptureResult['pageErrors'] = []
  const networkErrors: CaptureResult['networkErrors'] = []
  const t0 = Date.now()

  // Capture ALL console messages (not just errors)
  page.on('console', (msg) => {
    consoleLog.push({
      type: msg.type(),
      text: msg.text(),
      time: Date.now() - t0,
    })
  })

  // Capture uncaught page errors
  page.on('pageerror', (err) => {
    pageErrors.push({
      message: err.message,
      time: Date.now() - t0,
    })
  })

  // Capture failed network requests
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      networkErrors.push({
        url: resp.url(),
        status: resp.status(),
        time: Date.now() - t0,
      })
    }
  })

  // Load app
  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  // Sanity-check: the dev server at BASE_URL is actually SonicPi.js (not some
  // other app on the same port). The app's root mount is `#app`; a foreign
  // app mounted at `#root` will time out the editor selector below with a
  // confusing "locator timed out" message. Issue #214.
  const isSonicPi = await page.evaluate(() => Boolean(document.querySelector('#app')))
  if (!isSonicPi) {
    const title = await page.title()
    throw new Error(
      `[capture] ${BASE_URL} is not serving the SonicPi.js app (page title: "${title}", no #app mount node). ` +
      `Set BASE_URL=http://localhost:PORT (or run \`npm run dev\` in this repo first) and retry.`
    )
  }

  // Screenshot before running
  const beforePath = resolve(CAPTURES_DIR, `${prefix}_before.png`)
  await page.screenshot({ path: beforePath, fullPage: true })

  // Paste code into editor
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  // Engine-level hook (issue #221) — install BEFORE Run click. The App
  // exposes `__spw_engine` after init; intercept the assignment so we can
  // chain into the App's already-installed printHandler/cueHandler.
  // Captures every puts/cue regardless of Console ring-buffer pruning.
  // Passed as a string to side-step tsx's __name closure rewriting that
  // otherwise breaks page.evaluate of arrow-function source.
  await page.evaluate(`(function() {
    var _engine = null;
    window.__capturedPuts = [];
    window.__capturedCues = [];
    window.__capturedWarnings = [];
    window.__capturedStartedAt = Date.now();
    Object.defineProperty(window, '__spw_engine', {
      configurable: true,
      get: function() { return _engine; },
      set: function(e) {
        _engine = e;
        var origPrint = e.printHandler;
        e.printHandler = function(msg) {
          window.__capturedPuts.push({ t: Date.now() - window.__capturedStartedAt, msg: msg });
          if (origPrint) origPrint(msg);
        };
        var origCue = e.cueHandler;
        e.cueHandler = function(name, audioTime) {
          window.__capturedCues.push({ t: Date.now() - window.__capturedStartedAt, name: name, audioTime: audioTime });
          if (origCue) origCue(name, audioTime);
        };
        // SP95-loud: capture build-time warnings (#350/#351) symmetrically
        // with puts/cues so the dashboard/comparator can see them, not just
        // the user via the editor console. Without this hook the real user
        // sees the warning in the spw-console DOM but the captured report
        // misses it -- capture.ts builds its sections from these intercept
        // arrays, not from DOM textContent (issue #221 design rationale).
        var origWarn = e.warningHandler;
        e.warningHandler = function(title, msg) {
          window.__capturedWarnings.push({ t: Date.now() - window.__capturedStartedAt, title: title, msg: msg });
          if (origWarn) origWarn(title, msg);
        };
      }
    });
  })()`)

  // Click Run and wait for audio engine to be ready
  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()
  // Wait for "Audio engine ready" in the app text
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 10000 }
  ).catch(() => {})
  await page.waitForTimeout(500)

  // Start audio recording via Rec button (Chromium captures real audio)
  let audioPath: string | null = null
  // Diagnostic — set when audioPath stays null so the report can distinguish
  // "engine produced no audio" from "tool failed to resolve the blob in time".
  // Surfaced by the comparator as TOOL-FAIL vs INVALID (#358).
  let audioPathReason: string | null = null
  const isChromium = browser.browserType().name() === 'chromium'
  if (isChromium) {
    // #358: blob interception is now installed via context.addInitScript above —
    // bulletproof against ordering / hot-reload. No per-run page.evaluate needed.
    const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
    const hasRec = await recBtn.count()
    // If the user code itself drives recording (recording_start / _stop /
    // _save — issue #228), the blob hits __capturedWavBlob without any
    // UI clicks. Detect that path so we skip the Rec/Save button dance.
    const codeDrivesRecording = /\brecording_(start|save)\b/.test(code)
    if (hasRec > 0 && !codeDrivesRecording) {
      await recBtn.click()
      await page.waitForTimeout(duration)
      // Stop recording — button now says "Save"
      const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
      const hasSave = await saveBtn.count()
      if (hasSave > 0) {
        await saveBtn.click()
      } else {
        await recBtn.click()
      }
      await page.waitForTimeout(1500) // blob flush margin (matches desktop capture-desktop.ts +2500 minus blob-extract overhead)
    } else {
      // DSL-driven recording (#228 + #358 + #360): the user code's
      // `recording_stop` / `recording_save` fires at the END of live_loop
      // `:__run_once`'s virtual timeline — NOT at real-time t=duration.
      //
      // The #360 trap: a fixed `duration + Npoll` budget assumes the
      // recording window ≈ the `--wrap-recording` arg. That is false for
      // bare-sequential snippets. `bach.rb`'s top-level music is
      // `2.times do … play_pattern_timed … end` (bare code — the `in_thread`s
      // are nested INSIDE it), so ALL of it transpiles into one sequential
      // `:__run_once`. The wrap appends `with_bpm 60 { sleep 15 }` AFTER it,
      // so the real recording window = whole piece (~57s) + 15s ≈ 72s. The
      // engine reaches `recording_save` correctly — it just does so at
      // virtual t≈72s ≈ real ≈75s, far past the old 45s budget (15s duration
      // + 30s poll). Bumping the fixed poll cannot fix this: the true window
      // is unknowable in advance and unrelated to `--duration`. Verified by
      // controlled A/B — identical bach code, only the budget differs:
      // 75s wait ⇒ valid 72s WAV; 45s wait ⇒ TOOL-FAIL anchorClicks=0.
      //
      // Fix: drive the wait by ENGINE LIVENESS, not a fixed clock. Poll for
      // the blob; keep the deadline alive as long as the engine is still
      // emitting cues (every live_loop iteration auto-cues `:name`, so a
      // growing `window.__capturedCues` proves the recording window is still
      // open). Give up only after the engine has been quiet for IDLE_GRACE
      // with still no blob (recording_save genuinely isn't coming), bounded
      // by a hard ceiling so a pathological hang still terminates the sweep.
      await page.waitForTimeout(duration)
      const startPoll = Date.now()
      const POLL_INTERVAL_MS = 1000
      // Liveness signal must be DENSE and must NOT plateau:
      //   - `__capturedCues` is too SPARSE — bach only cues at `in_thread`
      //     boundaries (~every 8s, then a 24s gap through the final section),
      //     so a 12s cue-idle grace gave up mid-render.
      //   - `.spw-console` text LENGTH plateaus once the Console ring buffer
      //     caps (~500 lines; bach emits 1400+ /s_new), so length also goes
      //     falsely "idle".
      // The ring buffer's TAIL keeps changing on every new /s_new even after
      // the cap, so we hash the last 200 chars of the console pane — dense
      // for the whole musical span, cheap to transfer (200 chars, not the
      // full DOM).
      //
      // The trailing `with_bpm 60 { sleep ${wrapRecordingSec} }` the wrap
      // injects is SILENT — no cues, no /s_new — for its full duration before
      // `recording_stop`/`recording_save` fire. No output-passive signal can
      // observe it, so the idle grace must be long enough to span that known
      // sleep PLUS the recording_stop tail-wait + WAV encode + save. We KNOW
      // that sleep length (`wrapRecordingSec`), so derive the grace from it
      // rather than guessing a fixed budget (the #360 root cause).
      const trailingSilentMs = (opts.wrapRecordingSec ?? 0) * 1000
      const IDLE_GRACE_MS = trailingSilentMs + 12000  // sleep + encode/save margin
      // Absolute safety net: a page that never goes idle (e.g. a runaway
      // loop) still bounds comparator wall-time before TOOL-FAIL reports.
      const HARD_CEILING_MS = 180000
      const probeActivity = () =>
        page.evaluate(() => {
          const blob = (window as any).__capturedWavBlob != null
          const cues = ((window as any).__capturedCues?.length ?? 0) as number
          const pane =
            document.querySelector('.spw-console') ?? document.querySelector('#app')
          const txt = pane?.textContent ?? ''
          return { blob, cues, tail: txt.slice(-200) }
        })
      let blobReady = false
      let last = await probeActivity()
      let lastActivityTs = Date.now()
      while (true) {
        const probe = await probeActivity()
        if (probe.blob) { blobReady = true; break }
        if (probe.cues > last.cues || probe.tail !== last.tail) {
          lastActivityTs = Date.now()  // engine still emitting → window still open
        }
        last = probe
        const now = Date.now()
        if (now - lastActivityTs > IDLE_GRACE_MS) break          // engine idle, no blob
        if (now - startPoll > HARD_CEILING_MS) break              // pathological hang
        await page.waitForTimeout(POLL_INTERVAL_MS)
      }
      if (!blobReady) {
        const diag = await page.evaluate(() => (window as any).__captureDiag ?? null)
        const diagStr = diag
          ? `[diag] createObjectURL=${diag.createObjectURLCalls} blobsTracked=${diag.blobsTracked} anchorClicks=${diag.anchorClicksTotal} wavBlobClicks=${diag.anchorClicksWavBlob} lookupHits=${diag.blobLookupHits} lookupMisses=${diag.blobLookupMisses}`
          : '[diag unavailable]'
        const waitedMs = Date.now() - startPoll
        const reason = waitedMs > HARD_CEILING_MS ? 'hard ceiling' : `engine idle ${(IDLE_GRACE_MS / 1000).toFixed(0)}s`
        audioPathReason = `__capturedWavBlob did not appear (${reason}, polled ${(waitedMs / 1000).toFixed(1)}s after the ${(duration / 1000).toFixed(0)}s pre-wait) — ${diagStr}`
      }
    }

    // Extract the captured WAV blob — populated by the click interceptor
    // above whether triggered from the Rec button or from recording_save.
    const wavBase64 = await page.evaluate(async () => {
      const blob = (window as any).__capturedWavBlob as Blob | null
      if (!blob) return null
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      const cs = 8192
      for (let i = 0; i < bytes.length; i += cs) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
      }
      return btoa(binary)
    })

    if (wavBase64) {
      audioPath = resolve(CAPTURES_DIR, `${prefix}_audio.wav`)
      writeFileSync(audioPath, Buffer.from(wavBase64, 'base64'))
    } else if (!audioPathReason) {
      // Blob extraction returned null but polling didn't time out — the click
      // interceptor never fired. Either Rec/Save UI flow exited without
      // triggering a blob, or the page never reached recording_stop. Mark
      // with a distinct reason so the comparator's TOOL-FAIL vs ENGINE-SILENT
      // distinction stays meaningful.
      audioPathReason = 'blob extraction returned null — Recorder.ts may not have produced a blob (Rec/Save UI flow exited without download, or recording_stop never fired)'
    }
  } else {
    // Firefox: just wait (no reliable audio capture in headless)
    await page.waitForTimeout(duration)
  }

  // Screenshot after running
  const afterPath = resolve(CAPTURES_DIR, `${prefix}_after.png`)
  await page.screenshot({ path: afterPath, fullPage: true })

  // Capture app state
  const appFullText = await page.locator('#app').textContent() ?? ''

  // Read engine-level captures (issue #221). String-form to side-step tsx's
  // __name rewriting of arrow-function closures.
  const engineHooks = await page.evaluate(`({
    puts: window.__capturedPuts || [],
    cues: window.__capturedCues || [],
    warnings: window.__capturedWarnings || []
  })`) as { puts: { t: number; msg: string }[]; cues: { t: number; name: string; sourceLoop: string }[]; warnings: { t: number; title: string; msg: string }[] }

  // Try to isolate the console pane text (everything after "Audio engine ready" or "Happy live coding")
  let appConsoleText = ''
  const consoleStart = appFullText.indexOf('Happy live coding!')
  if (consoleStart >= 0) {
    appConsoleText = appFullText.slice(consoleStart)
  } else {
    const altStart = appFullText.indexOf('Audio engine ready')
    if (altStart >= 0) appConsoleText = appFullText.slice(altStart)
  }

  // Stop
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  await context.close()

  // Derive error/warning summaries
  const errorSummary: string[] = []
  const warningsSummary: string[] = []

  for (const e of pageErrors) {
    if (!e.message.includes('Aborted') && !e.message.includes('h1-check'))
      errorSummary.push(`[pageerror @ ${e.time}ms] ${e.message}`)
  }
  for (const c of consoleLog) {
    if (c.type === 'error') errorSummary.push(`[console.error @ ${c.time}ms] ${c.text}`)
    if (c.type === 'warning') warningsSummary.push(`[console.warn @ ${c.time}ms] ${c.text}`)
  }
  for (const n of networkErrors) {
    errorSummary.push(`[network ${n.status} @ ${n.time}ms] ${n.url}`)
  }

  // Check app console for runtime errors.
  // The patterns scan `appConsoleText` (spw-console DOM textContent slice) for
  // tokens that uniquely identify error blocks the engine renders via
  // `friendlyError → console.logError`. New tokens MUST be added when a new
  // friendly title shape lands — otherwise the comparator/cogate sweeps
  // silently mis-classify the row as PASS-with-no-output (the SP98 / #384
  // instrument-blindspot pattern). Includes both the user-facing friendly
  // title ("Syntax error — your code could not be parsed", "Parse error at
  // line N: ...") AND the raw token forms ("SyntaxError", "TypeError") in
  // case any error path skips the friendly transform.
  const runtimePatterns = [
    'not a function', 'not defined', 'Something went wrong',
    'Error in loop', "isn't available",
    'SyntaxError', 'TypeError', 'ReferenceError', 'Unexpected token',
    // #384 — friendly-error titles from FriendlyErrors.ts that the prior
    // pattern list missed. Trailing space on 'Syntax error ' disambiguates
    // from the no-space 'SyntaxError' token already above. Includes the
    // stack-overflow title "Code nested too deeply" so #382-style recursion
    // shows up as an error (previously the report said "None.").
    'Parse error', 'Syntax error ', 'Code nested too deeply',
  ]
  for (const pattern of runtimePatterns) {
    if (appConsoleText.includes(pattern)) {
      const idx = appConsoleText.indexOf(pattern)
      const context = appConsoleText.slice(Math.max(0, idx - 80), idx + 150).trim()
      errorSummary.push(`[app console] ...${context}...`)
    }
  }

  // Analyze captured audio if available
  let audioStats: CaptureResult['audioStats'] = null
  if (audioPath) {
    try {
      const wavBuf = readFileSync(audioPath)
      // Parse WAV header: offset 24 = sampleRate, offset 34 = bitsPerSample
      const sampleRate = wavBuf.readUInt32LE(24)
      const bitsPerSample = wavBuf.readUInt16LE(34)
      const numChannels = wavBuf.readUInt16LE(22)
      const dataOffset = 44
      const bytesPerSample = bitsPerSample / 8
      const numSamples = Math.floor((wavBuf.length - dataOffset) / (numChannels * bytesPerSample))

      let sumSq = 0
      let peak = 0
      let clipCount = 0
      for (let i = 0; i < numSamples; i++) {
        const off = dataOffset + i * numChannels * bytesPerSample
        const val = wavBuf.readInt16LE(off) / 32768.0
        sumSq += val * val
        const a = Math.abs(val)
        if (a > peak) peak = a
        if (a > 0.95) clipCount++
      }
      const rms = Math.sqrt(sumSq / numSamples)
      audioStats = {
        duration: numSamples / sampleRate,
        peak: Math.round(peak * 10000) / 10000,
        rms: Math.round(rms * 10000) / 10000,
        clipping: Math.round((clipCount / numSamples) * 10000) / 100,
      }
    } catch { /* WAV parse failed — skip stats */ }
  }

  return {
    timestamp: new Date().toISOString(),
    code,
    duration,
    url: BASE_URL,
    browser: browser.browserType().name(),
    console: consoleLog,
    pageErrors,
    networkErrors,
    appConsoleText,
    appFullText,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
    audioPath,
    audioPathReason,
    audioStats,
    errorSummary,
    warningsSummary,
    puts: engineHooks.puts,
    cues: engineHooks.cues,
    warnings: engineHooks.warnings,
  }
}

// ---------------------------------------------------------------------------
// Write capture to readable markdown
// ---------------------------------------------------------------------------

function writeCaptureReport(result: CaptureResult, outputPath: string): void {
  const lines: string[] = []

  lines.push(`# Browser Capture: ${result.timestamp}`)
  lines.push('')
  lines.push(`- **Browser:** ${result.browser}`)
  lines.push(`- **URL:** ${result.url}`)
  lines.push(`- **Duration:** ${result.duration}ms`)
  lines.push(`- **Screenshots:** before: \`${result.screenshotBefore}\`, after: \`${result.screenshotAfter}\``)
  lines.push('')

  // Code
  lines.push('## Code')
  lines.push('```ruby')
  lines.push(result.code)
  lines.push('```')
  lines.push('')

  // Errors (the important part)
  lines.push('## Errors')
  if (result.errorSummary.length === 0) {
    lines.push('None.')
  } else {
    for (const e of result.errorSummary) {
      lines.push(`- ${e}`)
    }
  }
  lines.push('')

  // Warnings
  lines.push('## Warnings')
  if (result.warningsSummary.length === 0) {
    lines.push('None.')
  } else {
    for (const w of result.warningsSummary) {
      lines.push(`- ${w}`)
    }
  }
  lines.push('')

  // Audio capture
  // Always emit this section so downstream consumers (the comparator) can
  // distinguish "engine produced no audio" from "capture tool failed to
  // resolve the blob" (#358). Previously this section only rendered when
  // audioPath was set; missing **File:** line meant the comparator
  // false-classified tool-failure as Tier-0 INVALID.
  lines.push('## Audio Capture')
  if (result.audioPath) {
    lines.push(`- **File:** \`${result.audioPath}\``)
    if (result.audioStats) {
      const s = result.audioStats
      lines.push(`- **Duration:** ${s.duration.toFixed(2)}s`)
      lines.push(`- **Peak:** ${s.peak}`)
      lines.push(`- **RMS:** ${s.rms}`)
      lines.push(`- **Clipping (>0.95):** ${s.clipping}%`)
      if (s.clipping > 1) lines.push(`- ⚠ **High clipping** — limiter may not be active`)
      if (s.rms > 0.3) lines.push(`- ⚠ **Loud output** — RMS ${s.rms} (original Sonic Pi ≈ 0.19)`)
      if (s.peak < 0.01) lines.push(`- ⚠ **Silent output** — no audio captured`)
    }
  } else {
    // Sentinel form — `**File:** none — <reason>`. The comparator's regex
    // for the resolved-path form (`**File:** \`...wav\``) WILL NOT match
    // this, so webWav stays null. The comparator's TOOL-FAIL probe then
    // greps this line to surface a distinct verdict instead of blaming the
    // engine. #358 / SV27 / SV30 / SP75 family.
    const reason = result.audioPathReason ?? 'unknown — neither blob extraction nor a polling timeout fired (audio path remained null)'
    lines.push(`- **File:** none — ${reason}`)
    lines.push('- ℹ This is a CAPTURE-TOOL failure, not necessarily an engine failure.')
    lines.push('- ℹ The engine may have produced audio that the tool could not resolve; check the App Console Output below for /s_new activity.')
  }
  lines.push('')

  // App console (engine-level puts hook — issue #221).
  // The previous DOM-textContent slice was unreliable: Console ring buffer
  // pruned old entries, and the slice contained UI chrome. The engine hook
  // captures every puts call without depending on DOM rendering.
  lines.push('## App Console Output')
  lines.push('```')
  if (result.puts.length === 0) {
    lines.push('(empty)')
  } else {
    for (const p of result.puts) {
      lines.push(`[${p.t}ms] ${p.msg}`)
    }
  }
  lines.push('```')
  lines.push('')

  // Engine warnings (SP95-loud + future build-time lints).
  // Real users see these in `.spw-console` via theme.warning hue; this
  // section is the headless / dashboard view. Symmetric with App Console
  // Output above — always emitted (`(none)` when empty) so the dashboard
  // can deterministically count zero-warning runs.
  lines.push('## Engine Warnings')
  lines.push('```')
  if (result.warnings.length === 0) {
    lines.push('(none)')
  } else {
    for (const w of result.warnings) {
      lines.push(`[${w.t}ms] ${w.title}`)
      lines.push(`         ${w.msg}`)
    }
  }
  lines.push('```')
  lines.push('')

  // Cue log (engine-level cue hook — issue #221).
  lines.push('## Cue Log')
  lines.push('```')
  if (result.cues.length === 0) {
    lines.push('(empty)')
  } else {
    for (const c of result.cues) {
      lines.push(`[${c.t}ms] cue :${c.name}  (audioTime ${c.audioTime.toFixed(3)}s)`)
    }
  }
  lines.push('```')
  lines.push('')

  // Browser console (verbose, for deep debugging)
  lines.push('## Browser Console (all messages)')
  lines.push('```')
  for (const c of result.console) {
    lines.push(`[${c.type}] (${c.time}ms) ${c.text}`)
  }
  if (result.console.length === 0) lines.push('(empty)')
  lines.push('```')
  lines.push('')

  // Page errors
  if (result.pageErrors.length > 0) {
    lines.push('## Uncaught Page Errors')
    for (const e of result.pageErrors) {
      lines.push(`- (${e.time}ms) ${e.message}`)
    }
    lines.push('')
  }

  // Network errors
  if (result.networkErrors.length > 0) {
    lines.push('## Network Errors')
    for (const n of result.networkErrors) {
      lines.push(`- ${n.status} ${n.url} (${n.time}ms)`)
    }
    lines.push('')
  }

  writeFileSync(outputPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Discover Ruby fixtures at a path. Path may be:
 *  - A directory → recursively collects all `*.rb` files
 *  - A single .rb file → returns just that one
 * Returns sorted by relative path so output ordering is stable.
 */
function discoverFixtures(path: string): { name: string; code: string; relPath: string }[] {
  const stat = statSync(path)
  const baseDir = stat.isDirectory() ? path : dirname(path)
  const files: string[] = []
  if (stat.isFile()) {
    files.push(path)
  } else {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && extname(entry.name) === '.rb') files.push(full)
      }
    }
    walk(path)
  }
  files.sort()
  return files.map((f) => ({
    name: basename(f, '.rb'),
    code: readFileSync(f, 'utf-8'),
    relPath: relative(baseDir, f) || basename(f),
  }))
}

async function main() {
  const args = process.argv.slice(2)
  mkdirSync(CAPTURES_DIR, { recursive: true })

  let code = ''
  let name = 'default'
  let duration = DEFAULT_DURATION
  let runAllExamples = false
  let batchPath: string | null = null
  let wrapRecordingSec: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') {
      const filePath = args[++i]
      code = readFileSync(filePath, 'utf-8')
      name = filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'file'
    } else if (args[i] === '--duration') {
      duration = parseInt(args[++i])
    } else if (args[i] === '--all-examples') {
      runAllExamples = true
    } else if (args[i] === '--batch') {
      batchPath = args[++i]
    } else if (args[i] === '--example') {
      name = args[++i]
      // Will be loaded from the app's example selector
    } else if (args[i] === '--wrap-recording') {
      wrapRecordingSec = parseFloat(args[++i])
    } else if (!args[i].startsWith('--')) {
      code = args[i]
      name = 'inline'
    }
  }

  // Default code if nothing specified
  if (!code && !runAllExamples && !batchPath) {
    code = `live_loop :test do
  play [:c4, :e4, :g4].choose
  sleep 0.5
end

live_loop :beat do
  sample :bd_haus
  sleep 1
end`
    name = 'default_test'
  }

  // Use Chromium headed by default — captures real audio via Rec button.
  // Firefox fallback: --firefox flag for headless event-only capture.
  const useFirefox = args.includes('--firefox')
  console.log(`Launching ${useFirefox ? 'Firefox (headless)' : 'Chromium (headed, audio capture)'}...`)
  const browser = useFirefox
    ? await firefox.launch({ headless: true })
    : await chromium.launch({
        headless: false,
        args: ['--autoplay-policy=no-user-gesture-required'],
      })

  if (batchPath) {
    // --batch <dir-or-file> — fan out across .rb fixtures, share one browser
    const fixtures = discoverFixtures(batchPath)
    if (fixtures.length === 0) {
      console.log(`No .rb fixtures found at ${batchPath}`)
      await browser.close()
      return
    }
    console.log(`Found ${fixtures.length} fixtures at ${batchPath}`)

    const summaryLines: string[] = [
      `# Batch Capture Summary`,
      ``,
      `- Source: \`${batchPath}\``,
      `- Fixtures: ${fixtures.length}`,
      `- Duration per fixture: ${duration}ms`,
      `- Started: ${new Date().toISOString()}`,
      ``,
      `| # | Fixture | Status | Errors | Report |`,
      `|---|---------|--------|--------|--------|`,
    ]

    let okCount = 0
    let errorCount = 0
    const t0 = Date.now()
    for (let i = 0; i < fixtures.length; i++) {
      const fx = fixtures[i]
      const tag = `[${i + 1}/${fixtures.length}]`
      process.stdout.write(`  ${tag} ${fx.relPath}... `)
      try {
        const result = await captureRun(browser, fx.code, { duration, name: fx.name, wrapRecordingSec })
        const reportPath = resolve(CAPTURES_DIR, `batch_${fx.name}.md`)
        writeCaptureReport(result, reportPath)
        const errs = result.errorSummary.length
        const status = errs === 0 ? 'OK' : 'FAIL'
        if (errs === 0) okCount++; else errorCount++
        console.log(`${status}${errs ? ` (${errs} errors)` : ''}`)
        summaryLines.push(`| ${i + 1} | \`${fx.relPath}\` | ${status} | ${errs} | [report](batch_${fx.name}.md) |`)
        if (errs > 0) {
          for (const e of result.errorSummary) {
            summaryLines.push(`|   |   |   |   | ${e.replace(/\|/g, '\\|')} |`)
          }
        }
      } catch (err) {
        errorCount++
        console.log(`CRASH (${(err as Error).message})`)
        summaryLines.push(`| ${i + 1} | \`${fx.relPath}\` | CRASH | — | ${(err as Error).message.replace(/\|/g, '\\|')} |`)
      }
    }
    const elapsed = Math.round((Date.now() - t0) / 1000)
    summaryLines.push(``)
    summaryLines.push(`## Results`)
    summaryLines.push(``)
    summaryLines.push(`- OK: ${okCount}/${fixtures.length}`)
    summaryLines.push(`- Failures: ${errorCount}/${fixtures.length}`)
    summaryLines.push(`- Elapsed: ${elapsed}s`)

    const summaryPath = resolve(CAPTURES_DIR, 'BATCH_SUMMARY.md')
    writeFileSync(summaryPath, summaryLines.join('\n'))
    console.log(`\nBatch complete: ${okCount}/${fixtures.length} OK, ${errorCount} failures in ${elapsed}s`)
    console.log(`Summary: ${summaryPath}`)
  } else if (runAllExamples) {
    // Run each built-in example
    const examples = [
      { name: 'Hello Beep', code: 'play 60\nsleep 1\nplay 64\nsleep 1\nplay 67' },
      { name: 'Basic Beat', code: 'live_loop :drums do\n  sample :bd_haus\n  sleep 0.5\n  sample :sn_dub\n  sleep 0.5\nend' },
      { name: 'Random Melody', code: 'use_random_seed 42\nlive_loop :melody do\n  use_synth :pluck\n  play scale(:c4, :minor_pentatonic).choose, release: 0.3\n  sleep 0.25\nend' },
      { name: 'Minimal Techno', code: 'use_bpm 130\n\nlive_loop :kick do\n  sample :bd_haus, amp: 1.5\n  sleep 1\nend\n\nlive_loop :hats do\n  pattern = spread(7, 16)\n  16.times do |i|\n    sample :hat_snap, amp: 0.4 if pattern[i]\n    sleep 0.25\n  end\nend\n\nlive_loop :acid do\n  use_synth :tb303\n  notes = ring(:e2, :e2, :e3, :e2, :g2, :e2, :a2, :e2)\n  play notes.tick, release: 0.2, cutoff: rrand(40, 120), res: 0.3\n  sleep 0.25\nend' },
    ]

    const summaryLines: string[] = ['# Capture Summary\n']

    for (const ex of examples) {
      console.log(`  Running: ${ex.name}...`)
      const result = await captureRun(browser, ex.code, { duration, name: ex.name, wrapRecordingSec })
      const reportPath = resolve(CAPTURES_DIR, `${ex.name.replace(/\s+/g, '_')}.md`)
      writeCaptureReport(result, reportPath)

      const status = result.errorSummary.length === 0 ? 'OK' : `${result.errorSummary.length} errors`
      summaryLines.push(`- **${ex.name}**: ${status} → \`${reportPath}\``)
      if (result.errorSummary.length > 0) {
        for (const e of result.errorSummary) {
          summaryLines.push(`  - ${e}`)
        }
      }
    }

    const summaryPath = resolve(CAPTURES_DIR, 'SUMMARY.md')
    writeFileSync(summaryPath, summaryLines.join('\n'))
    console.log(`\nSummary: ${summaryPath}`)
  } else {
    console.log(`  Running: ${name} (${duration}ms)...`)
    const result = await captureRun(browser, code, { duration, name, wrapRecordingSec })
    const reportPath = resolve(CAPTURES_DIR, `${name}.md`)
    writeCaptureReport(result, reportPath)

    console.log(`\nCapture saved: ${reportPath}`)
    if (result.errorSummary.length > 0) {
      console.log(`\nErrors found:`)
      for (const e of result.errorSummary) {
        console.log(`  ${e}`)
      }
    } else {
      console.log('No errors detected.')
    }
  }

  await browser.close()
}

main().catch((err) => {
  console.error('Capture failed:', err)
  process.exit(1)
})
