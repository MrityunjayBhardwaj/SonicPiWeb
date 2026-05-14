/**
 * Reproducer for FX-orphan-leak (applyFx /n_free targets wrong group).
 *
 * Latent bug: SuperSonicBridge.applyFxImmediate dispatches /s_new with the
 * FX synth as a direct child of group 101 (not the container `createFxGroup`).
 * On hot-swap orphan teardown, freeGroup(state.groups[i]) sends /n_free for
 * the empty container — the FX synth in group 101 keeps rendering.
 *
 * For scope-PRESERVING edits (same scopeId pre/post), no orphan teardown
 * fires, so the bug is invisible. To force orphan teardown we mutate an FX
 * opt (here: room: 0.95 → 0.05). Since scopeId fingerprint includes opts
 * (SonicPiEngine.ts:835-838), the new program produces a different scopeId
 * → old persistentFx entry is orphaned → freeGroup runs → bug fires.
 *
 *   npx tsx tools/test-fx-orphan-leak.ts
 *
 * Output: .captures/fx-orphan-leak/<TRIAL_LABEL>.wav
 *
 * Symptom pre-fix: After hot-swap, the OLD `:reverb room:0.95` synth keeps
 * running in group 101 and processes whatever the freed bus happens to carry
 * (often still master bus 0 or a reallocated bus), producing audible reverb
 * tail content that the new `room:0.05` synth alone shouldn't produce.
 * Post-fix: the OLD reverb synth is /n_free'd correctly.
 *
 * The decisive observation is the OSC trace (logged separately) — we just
 * need a WAV capture that lets us A/B audibly + numerically.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/fx-orphan-leak')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const TRIAL_LABEL = process.env.TRIAL_LABEL ?? 'baseline'

// Snippet A — huge reverb (room: 0.95). 4 hits per 4 beats, very wet tail.
const SNIPPET_A = `use_bpm 120

live_loop :met1 do
  sleep 1
end

with_fx :reverb, mix: 0.9, room: 0.95 do
  live_loop :pulse, sync: :met1 do
    sample :bd_tek, amp: 1.5
    sleep 1
  end
end
`

// Snippet B — same loop, reverb room changed (room: 0.05 = nearly dry).
// scopeId fingerprint differs → orphan teardown fires on hot-swap.
const SNIPPET_B = SNIPPET_A.replace('room: 0.95', 'room: 0.05')

if (SNIPPET_A === SNIPPET_B) {
  console.error('[fx-orphan-leak] FATAL: edit pattern did not match; aborting')
  process.exit(1)
}

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
  console.log('[fx-orphan-leak] launching chromium', HEADED ? '(headed)' : '(headless)')
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
  await editor.fill(SNIPPET_A)
  await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()

  console.log('[fx-orphan-leak] Run #1 (room:0.95)...')
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(2000)

  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  console.log('[fx-orphan-leak] click Rec...')
  await recBtn.click()
  await page.waitForTimeout(200)

  // 4 seconds of Run #1 (room:0.95 — wet reverb)
  console.log('[fx-orphan-leak] recording 4s of room:0.95...')
  await page.waitForTimeout(4000)

  // Hot-swap to dry reverb — forces scope orphan + recreate
  console.log('[fx-orphan-leak] editing room:0.95 → 0.05 (scope orphan)...')
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(SNIPPET_B)
  await page.waitForTimeout(200)

  console.log('[fx-orphan-leak] click Update...')
  await runBtn.click()

  // 8 seconds post-hot-swap to capture sustained behavior
  console.log('[fx-orphan-leak] recording 8s post-hot-swap...')
  await page.waitForTimeout(8000)

  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  console.log('[fx-orphan-leak] click Save...')
  await saveBtn.click()

  const wav = await fetchCapturedWav(page)
  if (!wav) {
    console.error('[fx-orphan-leak] no WAV captured')
    process.exit(1)
  }
  const wavPath = resolve(OUT_DIR, `${TRIAL_LABEL}.wav`)
  writeFileSync(wavPath, wav)
  console.log(`[fx-orphan-leak] wrote ${wavPath} (${wav.length} bytes, ~${(wav.length / 4 / 48000).toFixed(1)}s)`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  await stopBtn.click().catch(() => {})

  await browser.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
