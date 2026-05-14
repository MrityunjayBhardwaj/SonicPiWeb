/**
 * SV41 edge case — inner with_fx iter GENUINELY exceeds kill_delay=1.0s.
 *
 * Snippet:
 *   live_loop :a do
 *     with_fx :echo do
 *       play 60
 *       sleep 3   # iter (3s) > kill_delay (1s) → kill SHOULD fire each iter
 *     end
 *   end
 *
 * With SV41 (virtual-time-scheduled kill via queueMicrotask):
 *   - Iter k starts at virtualTime=3k. Reuse branch cancels existing killTimer.
 *   - Iter k finally schedules killTimer at 3k+1.0 (audio time).
 *   - Iter k+1 starts at virtualTime=3(k+1). Since 3k+1 < 3k+3, the killTimer
 *     in iter k SHOULD have fired before iter k+1 takes the reuse branch.
 *   - Net: each iter creates a fresh FX (CREATE branch), runs ~3s, gets killed
 *     ~1s after iter body ends. Audio: echo decay window for ~1s after each
 *     `play 60`, then ~2s of silence, repeat.
 *
 * If SV41 broken (kill doesn't fire / leaks resources):
 *   - Old FX nodes accumulate, bus/group/node IDs leak.
 *   - WAV shows continuous tail (everything still rendering into bus 0).
 *
 *   npx tsx tools/test-slow-inner-fx.ts
 *
 * Output: .captures/slow-inner-fx/<TRIAL_LABEL>.wav
 *
 * Verification:
 *   1. WAV character: pulse then ~2s near-silence, repeated.
 *   2. RMS of "silent" windows should be much smaller than RMS at hits.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/slow-inner-fx')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const TRIAL_LABEL = process.env.TRIAL_LABEL ?? 'baseline'
const REC_MS = Number(process.env.REC_MS ?? 14000)

const SNIPPET = `use_bpm 60

live_loop :a do
  with_fx :echo do
    play 60, amp: 0.8, release: 0.4
    sleep 3
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
  console.log('[slow-inner-fx] launching chromium', HEADED ? '(headed)' : '(headless)')
  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('console', m => {
    const t = m.type()
    if (t === 'error') console.error(`[console error]`, m.text())
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
  console.log('[slow-inner-fx] Run...')
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(1500)

  await installWavInterceptor(page)
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  console.log('[slow-inner-fx] click Rec...')
  await recBtn.click()
  await page.waitForTimeout(200)

  console.log(`[slow-inner-fx] recording ${REC_MS}ms (~${REC_MS / 3000} iters at 3s/iter)...`)
  await page.waitForTimeout(REC_MS)

  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  console.log('[slow-inner-fx] click Save...')
  await saveBtn.click()

  const wav = await fetchCapturedWav(page)
  if (!wav) {
    console.error('[slow-inner-fx] no WAV captured')
    process.exit(1)
  }
  const wavPath = resolve(OUT_DIR, `${TRIAL_LABEL}.wav`)
  writeFileSync(wavPath, wav)
  console.log(`[slow-inner-fx] wrote ${wavPath} (${wav.length} bytes, ~${(wav.length / 4 / 48000).toFixed(1)}s)`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  await stopBtn.click().catch(() => {})

  await browser.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
