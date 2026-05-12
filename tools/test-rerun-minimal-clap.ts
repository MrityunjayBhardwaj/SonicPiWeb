/**
 * Minimal repro: just the clap loop wrapped in echo→reverb. Same Update cadence
 * as the full DJ_Dave test. If snare-band still grows across re-runs, the bug
 * is in FX teardown / state accumulation. If flat, it's multi-loop interaction.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/rerun-minimal-clap')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const CHUNK_MS = 4000
const NUM_CHUNKS = 4
const SETTLE_MS = 2000

const SNIPPET = `use_bpm 130
live_loop :met1 do
  sleep 1
end
with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, amp: a
      sample :drum_snare_hard, rate: 2.2, start: 0.02, pan: 0.2, amp: a
      sample :drum_snare_hard, rate: 2, start: 0.04, pan: -0.2, amp: a
      sleep 1
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
  console.log('[minimal-clap] Run #1')
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
    if (i < NUM_CHUNKS) { console.log(`[minimal-clap] Run #${i + 1}`); await runBtn.click() }
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
  const wavPath = resolve(OUT_DIR, 'rerun_minimal_clap.wav')
  writeFileSync(wavPath, wav)
  console.log(`[minimal-clap] wrote ${wavPath}`)

  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  if (await stopBtn.count() > 0) await stopBtn.click()
  await browser.close()

  const py = spawnSync('python3', [resolve(__dirname, 'analyze-rerun-chunks.py'), wavPath, String(CHUNK_MS / 1000), String(NUM_CHUNKS)], { stdio: 'inherit' })
  process.exit(py.status ?? 0)
}
main().catch(e => { console.error(e); process.exit(1) })
