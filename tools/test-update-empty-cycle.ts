/**
 * Playwright reproducer: Run code → empty buffer → Update 5× → restore code → Update.
 *
 * Tests that removing all loops, re-evaluating empty code multiple times,
 * then re-adding the original code produces audio matching the initial run.
 *
 * Bugs this catches:
 *   - Stale entries in loopFxScope/fxScopeChains from removed loops surviving across empty Updates.
 *   - persistentFx not being cleaned up when its loops are gone.
 *   - Bridge state (FX nodes, buses) leaking when scopes are abandoned.
 *   - loopBuilders/loopSeeds/loopTicks not resetting properly.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/update-empty-cycle')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const RECORD_DURATION_MS = 6000
const SETTLE_MS = 600
const EMPTY_UPDATE_COUNT = 5

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
      s = 4
      r = 2
      c = 60
      a = 0.75
      at = 0
      use_synth :tech_saws
      play :g3, sustain: 6, cutoff: c, amp: a, attack: at
      sleep 6
      play :d3, sustain: 2, cutoff: c, amp: a, attack: at
      sleep 2
      play :e3, sustain: 8, cutoff: c, amp: a, attack: at
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

async function recordWindow(page: import('@playwright/test').Page, durationMs: number, label: string): Promise<Buffer> {
  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  await recBtn.click()
  await page.waitForTimeout(durationMs)
  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) await saveBtn.click()
  else await recBtn.click()
  await page.waitForTimeout(1500)
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
  if (!b64) throw new Error(`[${label}] no WAV blob captured`)
  return Buffer.from(b64, 'base64')
}

async function setEditorContent(page: import('@playwright/test').Page, code: string) {
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(80)
  await editor.fill(code)
  await page.waitForTimeout(120)
}

async function main() {
  console.log('[update-empty-cycle] launching chromium', HEADED ? '(headed)' : '(headless)')
  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', err => console.error('[page error]', err.message))
  page.on('console', m => { if (m.type() === 'error') console.error('[console error]', m.text()) })

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)
  if (!(await page.evaluate(() => Boolean(document.querySelector('#app'))))) {
    throw new Error(`[update-empty-cycle] ${BASE_URL} doesn't look like Sonic Pi Web`)
  }

  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()

  // Step 1: load code, click Run
  await setEditorContent(page, SNIPPET)
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(2000)

  console.log('[update-empty-cycle] capturing A (initial run)...')
  const wavA = await recordWindow(page, RECORD_DURATION_MS, 'A')
  const wavAPath = resolve(OUT_DIR, 'A_initial.wav')
  writeFileSync(wavAPath, wavA)
  console.log(`[update-empty-cycle] wrote ${wavAPath} (${wavA.length} bytes)`)

  // Control A2: capture again immediately (same elapsed time pattern as the
  // empty-cycle path) so we can quantify natural temporal variation. The full
  // snippet has long cycles (synthbass 16s, crash 17.5s) — A and A2 land in
  // different parts of those cycles, so SOME drift in mid/low bands is just
  // sampling, not a bug.
  console.log('[update-empty-cycle] capturing A2 (control — no Update)...')
  const wavA2 = await recordWindow(page, RECORD_DURATION_MS, 'A2')
  const wavA2Path = resolve(OUT_DIR, 'A2_control.wav')
  writeFileSync(wavA2Path, wavA2)
  console.log(`[update-empty-cycle] wrote ${wavA2Path} (${wavA2.length} bytes)`)

  // Step 2: empty buffer, Update N times
  await setEditorContent(page, '')
  for (let i = 1; i <= EMPTY_UPDATE_COUNT; i++) {
    console.log(`[update-empty-cycle] empty Update ${i}/${EMPTY_UPDATE_COUNT}...`)
    await runBtn.click()
    await page.waitForTimeout(SETTLE_MS)
  }

  // Step 3: restore the original code, Update once
  console.log('[update-empty-cycle] restoring code, clicking Update...')
  await setEditorContent(page, SNIPPET)
  await runBtn.click()
  await page.waitForTimeout(2000) // settle to steady state

  console.log('[update-empty-cycle] capturing B (after empty-cycle restore)...')
  const wavB = await recordWindow(page, RECORD_DURATION_MS, 'B')
  const wavBPath = resolve(OUT_DIR, 'B_after_empty_cycle.wav')
  writeFileSync(wavBPath, wavB)
  console.log(`[update-empty-cycle] wrote ${wavBPath} (${wavB.length} bytes)`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  if (await stopBtn.count() > 0) await stopBtn.click()
  await browser.close()

  console.log('\n[update-empty-cycle] CONTROL: A vs A2 (natural temporal variation, long-cycle snippet)\n')
  const ctrlPy = spawnSync('python3', [resolve(__dirname, 'compare-update-bands.py'), wavAPath, wavA2Path], {
    stdio: 'inherit',
  })
  console.log('\n[update-empty-cycle] TEST: A vs B (after empty-cycle restore)\n')
  const py = spawnSync('python3', [resolve(__dirname, 'compare-update-bands.py'), wavAPath, wavBPath], {
    stdio: 'inherit',
  })
  console.log(`\n[update-empty-cycle] control verdict=${ctrlPy.status===0?'PASS':'FAIL'}  test verdict=${py.status===0?'PASS':'FAIL'}`)
  console.log('  Interpretation: control FAIL with similar drift to test means long-cycle natural variation.')
  console.log('                  control PASS + test FAIL means empty-cycle is leaking real state.')
  process.exit(py.status ?? 0)
}

main().catch(err => { console.error(err); process.exit(1) })
