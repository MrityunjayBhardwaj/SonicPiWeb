/**
 * Control test: load dj_dave, click Run once, record 22 seconds of audio
 * with NO hot-swap. If gain grows over the same window we observed in
 * test-hhc2-sleep-edit.ts, the growth is intrinsic to the snippet's
 * persistent-FX architecture (SP11), not caused by the hot-swap path.
 *
 *   npx tsx tools/test-longrun-no-edit.ts
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/hhc2-edit')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const TRIAL_LABEL = process.env.TRIAL_LABEL ?? 'no_edit_control'

const SNIPPET = `# Coded by DJ_Dave

use_bpm 130

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
    with_fx :echo, phase: 1, mix: (line 0.1, 1, steps: 128).mirror.tick do
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
      } else {
        origClick.call(this)
      }
    }
  })
}

async function fetchCapturedWav(page: import('@playwright/test').Page): Promise<Buffer | null> {
  for (let i = 0; i < 60; i++) {
    const len = await page.evaluate(async () => {
      const b = (window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob
      if (!b) return -1
      const buf = await b.arrayBuffer()
      ;(window as unknown as { __wavBytes: Uint8Array }).__wavBytes = new Uint8Array(buf)
      return buf.byteLength
    })
    if (len > 0) {
      const bytes = await page.evaluate(() => {
        const u8 = (window as unknown as { __wavBytes: Uint8Array }).__wavBytes
        return Array.from(u8)
      })
      return Buffer.from(bytes)
    }
    await page.waitForTimeout(100)
  }
  return null
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('console', m => {
    const t = m.type()
    if (t === 'error' || t === 'warning') console.error(`[console ${t}]`, m.text())
  })

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(SNIPPET)
  await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()

  console.log('[long-run] Run (single click, no hot-swap)...')
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(2000)

  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  console.log('[long-run] click Rec...')
  await recBtn.click()
  await page.waitForTimeout(200)

  console.log('[long-run] recording 22s with NO hot-swap...')
  await page.waitForTimeout(22000)

  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  console.log('[long-run] click Save...')
  await saveBtn.click()

  const wav = await fetchCapturedWav(page)
  if (!wav) {
    console.error('[long-run] no WAV captured')
    process.exit(1)
  }
  const wavPath = resolve(OUT_DIR, `${TRIAL_LABEL}.wav`)
  writeFileSync(wavPath, wav)
  console.log(`[long-run] wrote ${wavPath} (${wav.length} bytes)`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  await stopBtn.click().catch(() => {})

  await browser.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
