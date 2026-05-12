/**
 * Discriminator for the loopTicks-hypothesis on Run#3 arp_mid deficit.
 *
 * Same as test-rerun-track-loss.ts except arp's inner with_fx uses
 * `mix: 0.5` (static) instead of `mix: (line 0.1, 1, steps: 128).mirror.tick`.
 *
 * If hypothesis is correct:
 *   - With dynamic mix.tick (track-loss test): arp_mid drops on Run#3 by ~25%
 *   - With static mix=0.5 (this test):         arp_mid stable across runs
 *
 * If hypothesis is wrong:
 *   - Both tests show same Run#3 deficit
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/rerun-static-mix')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const CHUNK_MS = 4000
const NUM_CHUNKS = 4
const SETTLE_MS = 2000

// Full DJ_Dave with ONLY ONE CHANGE: arp's inner with_fx mix is static 0.5
// instead of `(line 0.1, 1, steps: 128).mirror.tick`.
const SNIPPET = `use_bpm 130

live_loop :met1 do
  sleep 1
end

cmaster1 = 130
cmaster2 = 130

define :pattern do |pattern|
  return pattern.ring.tick == "x"
end

live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern "x--x--x---x--x--"
  sleep 0.25
end

with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sample :drum_snare_hard, rate: 2.2, start: 0.02, cutoff: cmaster1, pan: 0.2, amp: a
      sample :drum_snare_hard, rate: 2, start: 0.04, cutoff: cmaster1, pan: -0.2, amp: a
      sleep 1
    end
  end
end

with_fx :reverb, mix: 0.2 do
  with_fx :panslicer, mix: 0.2 do
    live_loop :hhc1, sync: :met1 do
      a = 0.75
      p = [-0.3, 0.3].choose
      sample :drum_cymbal_closed, amp: a, rate: 2.5, finish: 0.5, pan: p, cutoff: cmaster2 if pattern "x-x-x-x-x-x-x-x-xxx-x-x-x-x-x-x-"
      sleep 0.125
    end
  end
end

live_loop :hhc2, sync: :met1 do
  a = 1.25
  sleep 0.5
  sample :drum_cymbal_closed, cutoff: cmaster2, rate: 1.2, start: 0.01, finish: 0.5, amp: a
  sleep 0.5
end

with_fx :reverb, mix: 0.7 do
  live_loop :crash, sync: :met1 do
    a = 0.1
    c = cmaster2-10
    r = 1.5
    f = 0.25
    crash = :drum_splash_soft
    sleep 14.5
    sample crash, amp: a, cutoff: c, rate: r, finish: f
    sample crash, amp: a, cutoff: c, rate: r-0.2, finish: f
    sleep 1
    sample crash, amp: a, cutoff: c, rate: r, finish: f
    sample crash, amp: a, cutoff: c, rate: r-0.2, finish: f
    sleep 0.5
  end
end

with_fx :reverb, mix: 0.7 do
  live_loop :arp, sync: :met1 do
    with_fx :echo, phase: 1, mix: 0.5 do
      a = 0.6
      r = 0.25
      c = 130
      p = (line -0.7, 0.7, steps: 64).mirror.tick
      at = 0.01
      use_synth :beep
      tick
      notes = (scale :g4, :major_pentatonic).shuffle
      play notes.look, amp: a, release: r, cutoff: c, pan: p, attack: at
      sleep 0.75
    end
  end
end

with_fx :panslicer, mix: 0.4 do
  with_fx :reverb, mix: 0.75 do
    live_loop :synthbass, sync: :met1 do
      use_synth :tech_saws
      play :g3, sustain: 6, cutoff: 60, amp: 0.75, attack: 0
      sleep 6
      play :d3, sustain: 2, cutoff: 60, amp: 0.75, attack: 0
      sleep 2
      play :e3, sustain: 8, cutoff: 60, amp: 0.75, attack: 0
      sleep 8
    end
  end
end
`

mkdirSync(OUT_DIR, { recursive: true })

async function installWavInterceptor(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob = null
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.href?.startsWith('blob:') && this.download?.endsWith('.wav')) {
        fetch(this.href).then(r => r.blob()).then(b => {
          ;(window as unknown as { __capturedWavBlob: Blob }).__capturedWavBlob = b
        })
      } else { origClick.call(this) }
    }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', err => console.error('[page error]', err.message))

  await page.goto(BASE_URL); await page.waitForTimeout(2000)
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace')
  await page.waitForTimeout(100); await editor.fill(SNIPPET); await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()
  console.log('[static-mix] Run #1')
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(SETTLE_MS)

  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  await recBtn.click()
  for (let i = 1; i <= NUM_CHUNKS; i++) {
    await page.waitForTimeout(CHUNK_MS)
    if (i < NUM_CHUNKS) { console.log(`[static-mix] Run #${i + 1}`); await runBtn.click() }
  }
  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) await saveBtn.click(); else await recBtn.click()
  await page.waitForTimeout(2500)

  const b64 = await page.evaluate(async () => {
    const blob = (window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob
    if (!blob) return null
    const buf = await blob.arrayBuffer(); const bytes = new Uint8Array(buf)
    let s = ''; const cs = 8192
    for (let i = 0; i < bytes.length; i += cs) s += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
    return btoa(s)
  })
  if (!b64) throw new Error('no WAV blob captured')
  const wav = Buffer.from(b64, 'base64')
  const wavPath = resolve(OUT_DIR, 'rerun_static_mix.wav')
  writeFileSync(wavPath, wav)
  console.log(`[static-mix] wrote ${wavPath}`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  if (await stopBtn.count() > 0) await stopBtn.click()
  await browser.close()

  const py = spawnSync('python3', [resolve(__dirname, 'analyze-rerun-chunks.py'), wavPath, String(CHUNK_MS / 1000), String(NUM_CHUNKS)], { stdio: 'inherit' })
  process.exit(py.status ?? 0)
}
main().catch(e => { console.error(e); process.exit(1) })
