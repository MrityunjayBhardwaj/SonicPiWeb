/**
 * observe-fx-tree.ts — TEMPORARY observation harness for #424.
 *
 * Catches a silent run of the trailing-nested-with_fx + concurrent-live_loop
 * shape (mod_303_phade) and dumps scsynth's ACTUAL node tree at the moment the
 * FX chain should be alive. This is Lokayata: the node tree is THEIR side
 * (scsynth's running graph), observed via /g_queryTree.reply + /g_dumpTree —
 * not inferred from our OSC trace.
 *
 * Per-run it records:
 *   - peak: max |sample| polled from the master AnalyserNode (real output tap)
 *   - tree: /g_dumpTree text from scsynth's debug channel
 *   - replyTree: parsed /g_queryTree.reply (structured)
 *
 * Fresh engine per run (page.reload) so each run is independent — matches the
 * real "load → Run once" scenario where the residual silence appears.
 *
 * Usage: npx tsx tools/observe-fx-tree.ts [--file /tmp/x.rb] [--runs 40] [--dump-all]
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

function parseArgs() {
  const a = process.argv.slice(2)
  let file = '/tmp/mod_303_phade.rb'
  let runs = 40
  let dumpAll = false
  let captureMs = 4000
  let freshBrowser = false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--file') file = a[++i]
    else if (a[i] === '--runs') runs = parseInt(a[++i], 10)
    else if (a[i] === '--dump-all') dumpAll = true
    else if (a[i] === '--capture-ms') captureMs = parseInt(a[++i], 10)
    else if (a[i] === '--fresh-browser') freshBrowser = true
  }
  return { file, runs, dumpAll, captureMs, freshBrowser }
}

/**
 * Parse a /g_queryTree.reply array into { groupId: [{id, defname|null}] }.
 * Format: [address, flag, rootID, rootNumChildren, ...nodes]. Each node is
 * (id, numChildren); numChildren===-1 marks a synth, whose defname follows as
 * a string (present in observed output even with flag 0 — peek-typed to be
 * robust to either flag mode). Groups recurse over their children.
 */
function parseQueryTree(arr: unknown[]): Record<number, Array<{ id: number; defname: string | null }>> {
  const groups: Record<number, Array<{ id: number; defname: string | null }>> = {}
  let i = 1 // skip address
  i++ // skip flag
  function readNode(parentList: Array<{ id: number; defname: string | null }> | null) {
    const id = arr[i++] as number
    const nc = arr[i++] as number
    if (nc === -1) {
      let defname: string | null = null
      if (typeof arr[i] === 'string') defname = arr[i++] as string
      if (parentList) parentList.push({ id, defname })
    } else {
      const childList: Array<{ id: number; defname: string | null }> = []
      groups[id] = childList
      if (parentList) parentList.push({ id, defname: null })
      for (let k = 0; k < nc; k++) readNode(childList)
    }
  }
  readNode(null)
  return groups
}

/** FX synth defnames in group 101, head→tail (empty container groups dropped). */
function fxOrder(reply: unknown[] | undefined): string[] {
  if (!reply) return []
  try {
    const groups = parseQueryTree(reply)
    return (groups[101] ?? [])
      .filter(n => n.defname && n.defname.includes('fx_'))
      .map(n => n.defname!.replace('sonic-pi-fx_', ''))
  } catch { return [] }
}

async function main() {
  const { file, runs, dumpAll, captureMs, freshBrowser } = parseArgs()
  const code = readFileSync(file, 'utf8')
  console.log(`[observe] file=${file} runs=${runs} captureMs=${captureMs} freshBrowser=${freshBrowser}`)
  console.log(`[observe] code:\n${code.split('\n').map(l => '    ' + l).join('\n')}\n`)

  const launchOpts = {
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
    ],
  }

  async function openPage() {
    const browser = await chromium.launch(launchOpts)
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
    await page.goto(BASE_URL)
    await page.waitForTimeout(1500)
    const isApp = await page.evaluate(() => Boolean(document.querySelector('#app')))
    if (!isApp) throw new Error(`[observe] ${BASE_URL} is not the SonicPi.js app`)
    return { browser, page }
  }

  // In page-reload mode a single browser is reused across runs; in
  // fresh-browser mode (the faithful capture.ts-loop reproduction) each run
  // gets a brand-new browser + AudioContext + WASM scsynth cold start.
  let { browser, page } = await openPage()

  // Injected once per run after the engine exists: subscribe to scsynth's
  // incoming OSC ('in' → /g_queryTree.reply) and debug text ('debug' →
  // /g_dumpTree), and start a peak poller on the master analyser.
  const installProbe = `(function () {
    var eng = window.__spw_engine;
    if (!eng || !eng.bridge || !eng.bridge.sonic) return false;
    var sonic = eng.bridge.sonic;
    window.__peak = 0;
    window.__dumpText = [];
    window.__queryReplies = [];
    // Debug channel — /g_dumpTree prints here as plain text.
    if (window.__unsubDebug) window.__unsubDebug();
    window.__unsubDebug = sonic.on('debug', function (m) {
      window.__dumpText.push(m && m.text != null ? m.text : String(m));
    });
    // Incoming OSC — /g_queryTree.reply arrives here as [address, ...args].
    if (window.__unsubIn) window.__unsubIn();
    window.__unsubIn = sonic.on('in', function (msg) {
      if (Array.isArray(msg) && msg[0] === '/g_queryTree.reply') {
        window.__queryReplies.push(msg.slice());
      }
    });
    // Peak poller — read the REAL master output tap (post-worklet, post-mixer).
    var an = eng.bridge.analyserNode || (eng.bridge.getAnalyserNode && eng.bridge.getAnalyserNode());
    if (an) {
      var buf = new Float32Array(an.fftSize);
      if (window.__peakTimer) clearInterval(window.__peakTimer);
      window.__peakTimer = setInterval(function () {
        an.getFloatTimeDomainData(buf);
        var p = 0;
        for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i]); if (v > p) p = v; }
        if (p > window.__peak) window.__peak = p;
      }, 25);
    }
    return true;
  })()`

  const sendDump = `(function () {
    var eng = window.__spw_engine;
    if (!eng || !eng.bridge || !eng.bridge.sonic) return false;
    var sonic = eng.bridge.sonic;
    // Structure-only dump (flag 0) of the whole graph — readable node ORDER,
    // which is exactly what the FX-ordering race would corrupt. Control values
    // (flag 1) are noise for ordering analysis.
    sonic.send('/g_dumpTree', 0, 0);
    sonic.send('/g_queryTree', 0, 0);
    return true;
  })()`

  type RunResult = { run: number; peak: number; dump: string[]; replies: unknown[][]; fx: string[] }
  const results: RunResult[] = []

  for (let r = 0; r < runs; r++) {
    if (r > 0) {
      if (freshBrowser) {
        await browser.close()
        ;({ browser, page } = await openPage())
      } else {
        await page.reload()
        await page.waitForTimeout(1200)
      }
    }
    // Paste code
    const editor = page.locator('.cm-content, textarea').first()
    await editor.click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(80)
    await editor.fill(code)
    await page.waitForTimeout(150)

    // Run
    const runBtn = page.locator('.spw-btn-label:has-text("Run")')
    await runBtn.click()
    await page.waitForFunction(
      () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
      { timeout: 12000 },
    ).catch(() => {})

    // Install probe (retry until the bridge/sonic exists)
    let installed = false
    for (let t = 0; t < 40 && !installed; t++) {
      installed = await page.evaluate(installProbe) as boolean
      if (!installed) await page.waitForTimeout(100)
    }

    // Let the loop run + the with_fx/play fire (sync :foo returns ~0.5s).
    await page.waitForTimeout(captureMs)

    // Dump tree NOW — release:60 means tb303 + FX chain are alive far past this.
    await page.evaluate(sendDump)
    await page.waitForTimeout(400) // let reply/debug arrive

    const snap = await page.evaluate(`({
      peak: window.__peak || 0,
      dump: window.__dumpText || [],
      replies: window.__queryReplies || []
    })`) as { peak: number; dump: string[]; replies: unknown[][] }

    const silent = snap.peak < 0.01
    // Classify by the FX order in group 101 from the LAST reply (the dump send).
    const ord = fxOrder(snap.replies[snap.replies.length - 1] as unknown[] | undefined)
    results.push({ run: r, peak: snap.peak, dump: snap.dump, replies: snap.replies, fx: ord })
    const ordStr = ord.join('→') || '(none)'
    let verdict = ''
    if (silent) {
      if (ord.length === 0) verdict = 'SILENT/NO-FX-IN-TREE'
      else if (ord[0] === 'reverb') verdict = 'SILENT/REVERSED(reverb-head)'
      else if (ord[0] === 'slicer') verdict = 'SILENT/CORRECT-ORDER(slicer-head)!=race'
      else verdict = `SILENT/OTHER[${ordStr}]`
    }
    console.log(`[run ${String(r).padStart(3)}] peak=${snap.peak.toFixed(4)} fx101=[${ordStr}] ${silent ? '*** ' + verdict + ' ***' : ''}`)
    if (silent || dumpAll) {
      console.log(`  --- /g_dumpTree (run ${r}) ---`)
      console.log(snap.dump.join('\n').split('\n').map(l => '    ' + l).join('\n'))
      console.log(`  --- /g_queryTree.reply (run ${r}) ---`)
      console.log('    ' + JSON.stringify(snap.replies))
    }
  }

  const silentRuns = results.filter(x => x.peak < 0.01)
  console.log(`\n[observe] SUMMARY: ${silentRuns.length}/${runs} silent (${(100 * silentRuns.length / runs).toFixed(1)}%)`)
  console.log(`[observe] peaks: ${results.map(x => x.peak.toFixed(3)).join(' ')}`)
  // Silent-signature tally — answers "is the reversed tree the ONLY silent mode?"
  const sig = (x: RunResult) =>
    x.fx.length === 0 ? 'NO-FX-IN-TREE'
    : x.fx[0] === 'reverb' ? 'REVERSED(reverb-head)'
    : x.fx[0] === 'slicer' ? 'CORRECT-ORDER(slicer-head)≠race'
    : `OTHER[${x.fx.join('→')}]`
  const tally: Record<string, number> = {}
  for (const x of silentRuns) tally[sig(x)] = (tally[sig(x)] ?? 0) + 1
  console.log(`[observe] SILENT SIGNATURES: ${JSON.stringify(tally)}`)
  console.log(`[observe] silent runs: ${silentRuns.map(x => `#${x.run}[${x.fx.join('→') || 'none'}]`).join(' ')}`)

  // Always print the dump from the FIRST audible run too, as a reference tree.
  const firstAudible = results.find(x => x.peak >= 0.01)
  if (firstAudible) {
    console.log(`\n[observe] REFERENCE (audible) tree from run ${firstAudible.run}, peak=${firstAudible.peak.toFixed(4)}:`)
    console.log(firstAudible.dump.join('\n').split('\n').map(l => '    ' + l).join('\n'))
  }

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
