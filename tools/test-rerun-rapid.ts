/**
 * Playwright reproducer for user-reported "tracks drop on Run-while-playing".
 *
 * Pastes the full DJ_Dave sketch, clicks Run, then re-Runs every 4 seconds
 * 3 times while a single continuous in-app Rec captures everything.
 *
 * Output: one 16s WAV split into 4 chunks of ~4s each. The companion analyzer
 * (analyze-rerun-chunks.py) reports per-chunk band energy + onsets so a missing
 * kick / clap / cymbal track is visible as a band-energy dropout in chunk N.
 *
 * Why one continuous Rec (not 4 separate Recs):
 *   The user reported the bug across a SINGLE recording session — they want
 *   to see whether the AudioWorklet / scsynth state survives Update without
 *   disturbing the recorder boundary. Splitting into 4 Recs would re-attach
 *   the analyser between captures and hide stream-level discontinuities.
 *
 * Usage:
 *   npx tsx tools/test-rerun-track-loss.ts          # headless
 *   npx tsx tools/test-rerun-track-loss.ts --headed
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/rerun-rapid')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const RAPID_MS = Number(process.env.RAPID_MS ?? 1000)   // ms between rapid hot-swaps
const NUM_RAPID = Number(process.env.NUM_RAPID ?? 10)   // rapid re-runs after initial Run
const TAIL_MS = Number(process.env.TAIL_MS ?? 5000)     // free playback after last swap
const SETTLE_MS = 2000
const TRIAL_LABEL = process.env.TRIAL_LABEL ?? 'rapid'

// Full DJ_Dave sketch from the user's report. Eight live_loops total:
//   met1, kick (unwrapped), clap (echo→reverb), hhc1 (reverb→panslicer),
//   hhc2 (unwrapped), crash (reverb), arp (reverb→echo dynamic), synthbass
//   (panslicer→reverb).
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

async function main() {
  console.log('[rerun-track-loss] launching chromium', HEADED ? '(headed)' : '(headless)')
  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  page.on('pageerror', err => console.error('[page error]', err.message))
  page.on('console', m => {
    const t = m.type()
    if (t === 'error' || t === 'warning') console.error(`[console ${t}]`, m.text())
  })

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  // Paste snippet
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(SNIPPET)
  await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()

  // First Run — initial play
  console.log('[rerun-track-loss] click Run (#1, initial)...')
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(SETTLE_MS)

  // Start continuous Rec
  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  await recBtn.click()
  console.log(`[rerun-rapid] Rec started — ${NUM_RAPID}× hot-swap @ ${RAPID_MS}ms then ${TAIL_MS}ms tail`)

  for (let i = 1; i <= NUM_RAPID; i++) {
    await page.waitForTimeout(RAPID_MS)
    console.log(`[rerun-rapid] click Run (#${i + 1}, rapid hot-swap)...`)
    await runBtn.click()
  }
  console.log(`[rerun-rapid] last hot-swap done — letting it play ${TAIL_MS}ms`)
  await page.waitForTimeout(TAIL_MS)

  // Stop Rec by clicking Save (Toolbar replaces Rec with Save when armed)
  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) {
    await saveBtn.click()
  } else {
    await recBtn.click()
  }
  await page.waitForTimeout(2500)

  const b64 = await page.evaluate(async () => {
    const blob = (window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob
    if (!blob) return null
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let s = ''
    const cs = 8192
    for (let i = 0; i < bytes.length; i += cs) {
      s += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
    }
    return btoa(s)
  })
  if (!b64) throw new Error('no WAV blob captured')
  const wav = Buffer.from(b64, 'base64')
  const wavPath = resolve(OUT_DIR, `${TRIAL_LABEL}.wav`)
  writeFileSync(wavPath, wav)
  console.log(`[rerun-track-loss] wrote ${wavPath} (${wav.length} bytes, ~${(wav.length / 4 / 48000).toFixed(1)}s float32 stereo @48k)`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  if (await stopBtn.count() > 0) await stopBtn.click()
  await browser.close()

  // Boundary scan resolution matters here per feedback_boundary_scan_distinguishes_bug_classes
  // (chunk-RMS would smear rapid swaps together — 200ms resolution separates them).
  console.log('\n[rerun-rapid] running boundary scan around click moments...\n')
  // Click moments at t=2 (initial settle) + RAPID_MS, +2*RAPID_MS, +3*RAPID_MS — but
  // Rec t=0 is at start of Rec, which is right after the first Run completed and we
  // settled SETTLE_MS. So rapid clicks occur at relative t = RAPID_MS, 2*RAPID_MS, 3*RAPID_MS.
  const py = spawnSync('python3', [
    resolve(__dirname, 'analyze-rerun-boundaries.py'),
    wavPath,
    String(RAPID_MS / 1000),
  ], { stdio: 'inherit' })
  process.exit(py.status ?? 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
