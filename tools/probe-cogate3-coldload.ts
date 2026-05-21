#!/usr/bin/env tsx
/**
 * exp-016 — Cross-browser cold-load probe for dharana §30 CO-GATE 3.
 * Diagnostic-only: each browser launches fresh, pastes a minimal test
 * snippet, clicks Run, reads .spw-console + browser console. No source
 * changes; no audio WAV capture (the contract is "user hears audio first
 * try", verified by /s_new dispatch + Audio engine ready + no blocker
 * errors).
 */
import { chromium, firefox, webkit, type BrowserType, type Browser } from '@playwright/test'

const URL = 'http://localhost:5173'
const TEST_CODE = 'play 60\nsleep 0.3\nplay 64\nsleep 0.3\nplay 67\n'

interface ProbeResult {
  name: string
  launched: boolean
  launchError?: string
  appMounted: boolean
  audioEngineReady: boolean
  audioEngineReadyMs?: number
  spwConsoleSinceRun: string
  sNewCount: number
  browserConsoleErrors: string[]
  browserConsoleWarnings: string[]
  pageErrors: string[]
}

async function probe(name: string, btype: BrowserType<Browser>, headless: boolean): Promise<ProbeResult> {
  const result: ProbeResult = {
    name, launched: false, appMounted: false, audioEngineReady: false,
    spwConsoleSinceRun: '', sNewCount: 0,
    browserConsoleErrors: [], browserConsoleWarnings: [], pageErrors: [],
  }
  let browser: Browser | null = null
  try {
    browser = await btype.launch({ headless })
    result.launched = true
  } catch (e: any) {
    result.launchError = `${e.name}: ${e.message}`
    return result
  }

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  page.on('console', (m) => {
    if (m.type() === 'error') result.browserConsoleErrors.push(m.text())
    if (m.type() === 'warning') result.browserConsoleWarnings.push(m.text())
  })
  page.on('pageerror', (e) => result.pageErrors.push(`${e.name}: ${e.message}`))

  try {
    await page.goto(URL, { timeout: 20000 })
    await page.waitForSelector('#app', { timeout: 15000 })
    result.appMounted = true
  } catch (e: any) {
    result.launchError = `page.goto/#app: ${e.message}`
    await browser.close()
    return result
  }

  // Paste test code into the editor.
  try {
    await page.locator('.cm-content, textarea').first().click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await page.locator('.cm-content, textarea').first().fill(TEST_CODE)
    await page.waitForTimeout(150)
  } catch (e: any) {
    result.launchError = `editor paste: ${e.message}`
    await browser.close()
    return result
  }

  // Snapshot spw-console BEFORE Run so we can slice the new chunk.
  const beforeText: string = await page.locator('.spw-console').first().textContent() ?? ''

  // Click Run.
  const runStart = Date.now()
  try {
    await page.locator('.spw-btn-label:has-text("Run")').first().click({ timeout: 5000 })
  } catch (e: any) {
    result.launchError = `Run click: ${e.message}`
    await browser.close()
    return result
  }

  // Wait up to 60s for "Audio engine ready" — the canonical post-init signal.
  try {
    await page.waitForFunction(
      () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
      null,
      { timeout: 60000, polling: 500 },
    )
    result.audioEngineReady = true
    result.audioEngineReadyMs = Date.now() - runStart
  } catch {
    result.audioEngineReady = false
  }

  // Give the engine ~3s to dispatch /s_new events.
  await page.waitForTimeout(3000)

  const afterText: string = await page.locator('.spw-console').first().textContent() ?? ''
  result.spwConsoleSinceRun = afterText.length > beforeText.length
    ? afterText.slice(beforeText.length)
    : afterText.slice(-2000)
  result.sNewCount = (result.spwConsoleSinceRun.match(/\/s_new/g) ?? []).length

  await browser.close()
  return result
}

function printResult(r: ProbeResult): void {
  console.log('==============================')
  console.log('Browser:', r.name)
  console.log('==============================')
  if (!r.launched) {
    console.log('  LAUNCH FAILED:', r.launchError)
    return
  }
  console.log('  launched:           YES')
  console.log('  app #app mounted:  ', r.appMounted ? 'YES' : 'NO')
  console.log('  Audio engine ready:', r.audioEngineReady ? `YES (${r.audioEngineReadyMs}ms)` : 'NO (>60s timeout)')
  console.log('  /s_new events:     ', r.sNewCount)
  console.log('  page errors:       ', r.pageErrors.length)
  for (const p of r.pageErrors.slice(0, 5)) console.log('    -', p)
  console.log('  console errors:    ', r.browserConsoleErrors.length)
  for (const e of r.browserConsoleErrors.slice(0, 5)) console.log('    -', e.slice(0, 200))
  console.log('  console warnings:  ', r.browserConsoleWarnings.length)
  for (const w of r.browserConsoleWarnings.slice(0, 3)) console.log('    -', w.slice(0, 200))
  console.log('  --- spw-console new chunk (first 1200 chars) ---')
  console.log(r.spwConsoleSinceRun.slice(0, 1200).replace(/\n/g, '\n    '))
  console.log('  --- end ---')
  // Verdict
  let verdict = 'INCONCLUSIVE'
  if (r.audioEngineReady && r.sNewCount > 0 && r.pageErrors.length === 0) verdict = 'PASS'
  else if (r.audioEngineReady && r.sNewCount > 0) verdict = 'PASS-with-errors'
  else if (!r.audioEngineReady && (r.pageErrors.length > 0 || r.browserConsoleErrors.length > 0)) verdict = 'FAIL-VISIBLE'
  else if (!r.audioEngineReady) verdict = 'SILENT-FAIL'
  console.log('  VERDICT:', verdict)
}

const browsers: Array<[string, BrowserType<Browser>, boolean]> = [
  ['chromium', chromium, false],   // headed = closer to real user
  ['firefox',  firefox,  false],
  ['webkit',   webkit,   false],
]

;(async () => {
  for (const [name, btype, headless] of browsers) {
    const r = await probe(name, btype, headless)
    printResult(r)
  }
  console.log('\n=== ALL BROWSERS DONE ===')
})()
