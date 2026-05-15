/**
 * Level-3 observation for the share-permalink feature (#306).
 *
 * Tests + tsc are inference ("the code I expected ran"). This loads a
 * REAL browser and observes what actually happens:
 *   1. Navigate to BASE_URL#c=<encoded>  → CodeMirror shows the decoded code.
 *   2. Click Share with fresh code        → clipboard holds a URL that
 *                                            decodes back to that code.
 *
 * Usage: npm run dev (other terminal), then `npx tsx tools/observe-share-link.ts`
 */
import { chromium } from '@playwright/test'
import { encodeShareCode, decodeShareCode } from '../src/app/ShareLink'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const SHARED = 'live_loop :obs do\n  sample :bd_haus\n  sleep 0.5\nend  # ♯🎹 #306'
const TYPED = 'play 72\nsleep 0.25\nplay 76  # share-button observation'

let failed = false
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed = true
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()

  // --- 1. Inbound: a share URL reconstructs the buffer ---
  await page.goto(BASE_URL + encodeShareCode(SHARED))
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(800)
  const shown = (await page.locator('.cm-content').first().innerText()).replace(/ /g, ' ')
  // CodeMirror may soft-wrap/strip; compare on a distinctive line.
  ok('share URL populates editor', shown.includes('live_loop :obs do'), JSON.stringify(shown.slice(0, 60)))
  ok('unicode survived round-trip', shown.includes('♯') && shown.includes('🎹'))

  // Hash must be stripped so refresh/persistence behave normally.
  const hashAfter = await page.evaluate(() => location.hash)
  ok('hash stripped after load', hashAfter === '', `hash=${JSON.stringify(hashAfter)}`)

  // --- 2. Outbound: Share button copies a working link ---
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await editor.fill(TYPED)
  await page.waitForTimeout(200)

  await page.locator('.spw-btn-label:has-text("Share")').click()
  await page.waitForTimeout(300)

  const clip = await page.evaluate(() => navigator.clipboard.readText())
  const decoded = clip ? decodeShareCode(new URL(clip).hash) : null
  ok('Share button copied a URL', !!clip && clip.includes('#c='), clip.slice(0, 50))
  ok('copied link decodes to typed code', decoded === TYPED, JSON.stringify(decoded))

  const toastVisible = await page.locator('text=Share link copied').count()
  ok('toast shown', toastVisible > 0)

  await browser.close()
  console.log(failed ? '\nOBSERVATION FAILED' : '\nOBSERVATION CLEAN')
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
