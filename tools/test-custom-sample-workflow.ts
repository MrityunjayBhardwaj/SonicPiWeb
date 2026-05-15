/**
 * End-to-end test: upload a WAV, register as `:user_fixture`, play it,
 * capture the audio output, and confirm scsynth actually produced sound.
 *
 * Level 1 (unit) and Level 2 (event log) would only prove dispatch. This
 * is Level 3 (WAV observation per SV8 / CLAUDE.md Testing Protocol) — the
 * only signal that proves the buffer round-tripped to scsynth and rendered.
 *
 * Usage:
 *   npm run dev   # in another terminal — BASE_URL=http://localhost:5173
 *   npx tsx tools/test-custom-sample-workflow.ts
 *
 * Inputs:  .captures/custom-sample/fixture.wav  (must exist — download first)
 * Outputs: .captures/custom-sample/output.wav   (recorded audio)
 *          stdout PASS/FAIL line — exit code 0/1
 */

import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const FIXTURE = resolve(ROOT, '.captures/custom-sample/fixture.wav')
const OUTPUT = resolve(ROOT, '.captures/custom-sample/output.wav')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

// Play the uploaded sample four times across ~4s so we have plenty of
// energy in the recording window (rate 0.5 stretches it; pan widens it).
const CODE = `
sample :user_fixture, amp: 1.5
sleep 1
sample :user_fixture, amp: 1.5, rate: 0.7
sleep 1
sample :user_fixture, amp: 1.5, rate: 1.3, pan: -0.5
sleep 1
sample :user_fixture, amp: 1.5, rate: 1.0, pan: 0.5
sleep 1
`.trim()

const REC_DURATION_MS = 5500   // a bit longer than the four sleeps

async function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`FIXTURE missing: ${FIXTURE}`)
    console.error(`Download a small WAV first, e.g.:`)
    console.error(`  curl -L -o ${FIXTURE} https://samplelib.com/lib/preview/wav/sample-3s.wav`)
    process.exit(2)
  }
  const fixtureBytes = readFileSync(FIXTURE)
  console.log(`[fixture] ${FIXTURE} — ${(fixtureBytes.length / 1024).toFixed(1)}KB`)
  const fixtureB64 = fixtureBytes.toString('base64')

  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  page.on('console', msg => {
    const t = msg.type()
    if (t === 'error' || t === 'warning') console.log(`[browser:${t}] ${msg.text()}`)
  })
  page.on('pageerror', err => console.log(`[browser:pageerror] ${err.message}`))

  console.log(`[nav] ${BASE_URL}`)
  await page.goto(BASE_URL)

  // Sanity: this must be sonicPiWeb
  await page.waitForSelector('#app', { timeout: 10000 })

  // Install the WAV blob interceptor BEFORE Rec is clicked (matches capture.ts:250).
  await page.evaluate(() => {
    const origClick = HTMLAnchorElement.prototype.click
    ;(window as unknown as Record<string, unknown>).__capturedWavBlob = null
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href?.startsWith('blob:') && this.download?.endsWith('.wav')) {
        fetch(this.href).then(r => r.blob()).then(b => {
          ;(window as unknown as Record<string, unknown>).__capturedWavBlob = b
        })
      } else {
        origClick.call(this)
      }
    }
  })

  // Fill editor with our test code BEFORE clicking Run.
  // CodeMirror is content-editable; use the same approach as capture.ts.
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(CODE)
  await page.waitForTimeout(200)

  // Click Run — boots the engine and exposes window.__spw_engine
  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()

  // Wait until the engine is fully ready (audio worklet up, bridge wired).
  await page.waitForFunction(
    () => Boolean((window as unknown as Record<string, unknown>).__spw_engine)
       && document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 }
  )
  console.log(`[engine] ready`)

  // Register the custom sample via the same code path the UI uploader uses.
  // engine.registerCustomSample → bridge.registerCustomSample → sonic.loadSample.
  const regResult = await page.evaluate(async (b64: string) => {
    type Engine = { registerCustomSample(name: string, buf: ArrayBuffer): Promise<void> }
    const engine = (window as unknown as { __spw_engine: Engine }).__spw_engine
    const bin = atob(b64)
    const buf = new ArrayBuffer(bin.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
    try {
      await engine.registerCustomSample('user_fixture', buf)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }, fixtureB64)

  if (!regResult.ok) {
    console.error(`[FAIL] registerCustomSample threw: ${regResult.error}`)
    await browser.close()
    process.exit(1)
  }
  console.log(`[register] :user_fixture loaded into scsynth`)

  // Stop the engine (Run already triggered it once; the code is empty effectively
  // until we re-run with the sample-playing code). The editor still holds CODE,
  // so the next Run will dispatch /s_new with our buffer.
  // Actually — Run already executed CODE once, BEFORE registerCustomSample,
  // when :user_fixture wasn't loaded yet. So we Stop and Re-Run.
  const stopBtn = page.locator('.spw-btn-label:has-text("Stop")').first()
  if (await stopBtn.count() > 0) {
    await stopBtn.click().catch(() => {})
    await page.waitForTimeout(300)
  }

  // Start recording, then trigger Run, wait, then Save.
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  if (await recBtn.count() === 0) {
    console.error('[FAIL] Rec button not found in UI')
    await browser.close()
    process.exit(1)
  }
  await recBtn.click()
  console.log(`[rec] started`)

  // Now Re-run with the sample loaded.
  await runBtn.click()
  console.log(`[run] dispatched — playing :user_fixture`)

  await page.waitForTimeout(REC_DURATION_MS)

  // Stop recording — button now says "Save"
  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) {
    await saveBtn.click()
  } else {
    await recBtn.click()  // toggle off
  }
  await page.waitForTimeout(2000)  // blob flush margin

  // Pull the WAV blob.
  const wavB64 = await page.evaluate(async () => {
    const blob = (window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob
    if (!blob) return null
    const ab = await blob.arrayBuffer()
    const bytes = new Uint8Array(ab)
    let bin = ''
    const cs = 8192
    for (let i = 0; i < bytes.length; i += cs) {
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
    }
    return btoa(bin)
  })

  await browser.close()

  if (!wavB64) {
    console.error('[FAIL] No WAV blob captured — recording did not produce output')
    process.exit(1)
  }

  const wavBytes = Buffer.from(wavB64, 'base64')
  writeFileSync(OUTPUT, wavBytes)
  console.log(`[output] ${OUTPUT} — ${(wavBytes.length / 1024).toFixed(1)}KB`)

  // ---- Level 3 analysis: did scsynth actually produce sound? ----
  const { rms, peak, sr, durSec } = analyzeWav(wavBytes)
  console.log(`[analyze] sr=${sr}Hz duration=${durSec.toFixed(2)}s rms=${rms.toFixed(4)} peak=${peak.toFixed(4)}`)

  // Thresholds: a successful 4-sample playback should produce
  // RMS >> noise floor (~1e-4) and peak well above silence.
  const RMS_MIN = 0.005
  const PEAK_MIN = 0.05
  const DUR_MIN = REC_DURATION_MS / 1000 - 1  // -1s slack for stop margins

  const pass = rms >= RMS_MIN && peak >= PEAK_MIN && durSec >= DUR_MIN
  if (pass) {
    console.log(`[PASS] custom sample workflow end-to-end verified`)
    console.log(`       :user_fixture round-tripped IndexedDB-free path:`)
    console.log(`       bytes → registerCustomSample → bridge → WASM scsynth → audio`)
    process.exit(0)
  } else {
    console.error(`[FAIL] thresholds not met`)
    console.error(`       rms ${rms.toFixed(4)} >= ${RMS_MIN}? ${rms >= RMS_MIN}`)
    console.error(`       peak ${peak.toFixed(4)} >= ${PEAK_MIN}? ${peak >= PEAK_MIN}`)
    console.error(`       dur ${durSec.toFixed(2)} >= ${DUR_MIN}? ${durSec >= DUR_MIN}`)
    process.exit(1)
  }
}

function analyzeWav(buf: Buffer): { rms: number; peak: number; sr: number; durSec: number } {
  // Minimal RIFF/WAVE PCM/float parser — enough for the recorder's output.
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  // Walk chunks
  let pos = 12
  let fmtFound = false
  let sr = 0, ch = 1, bits = 16, audioFormat = 1
  let dataStart = 0, dataLen = 0
  while (pos < buf.length - 8) {
    const id = buf.toString('ascii', pos, pos + 4)
    const sz = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(pos + 8)
      ch = buf.readUInt16LE(pos + 10)
      sr = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
      fmtFound = true
    } else if (id === 'data') {
      dataStart = pos + 8
      dataLen = sz
      break
    }
    pos += 8 + sz + (sz & 1)
  }
  if (!fmtFound || !dataStart) throw new Error('malformed WAV')

  const bytesPerSample = bits / 8
  const frames = dataLen / (bytesPerSample * ch)
  let sumSq = 0, peak = 0
  for (let f = 0; f < frames; f++) {
    let mono = 0
    for (let c = 0; c < ch; c++) {
      const off = dataStart + (f * ch + c) * bytesPerSample
      let v: number
      if (audioFormat === 3 && bits === 32) {
        v = buf.readFloatLE(off)
      } else if (bits === 16) {
        v = buf.readInt16LE(off) / 32768
      } else if (bits === 24) {
        const lo = buf.readUInt16LE(off)
        const hi = buf.readInt8(off + 2)
        v = ((hi << 16) | lo) / 8388608
      } else if (bits === 32) {
        v = buf.readInt32LE(off) / 2147483648
      } else {
        throw new Error(`unsupported bits=${bits}`)
      }
      mono += v
    }
    mono /= ch
    sumSq += mono * mono
    const a = Math.abs(mono)
    if (a > peak) peak = a
  }
  const rms = Math.sqrt(sumSq / frames)
  const durSec = frames / sr
  return { rms, peak, sr, durSec }
}

main().catch(err => {
  console.error(`[error] ${err.stack ?? err}`)
  process.exit(1)
})
