/**
 * build-examples-sweep.ts — mirror per-roster comparator artifacts into
 * test_results/<roster>/<slug>/ and emit a manifest JSON.
 *
 * Default roster = the 34 bundled Sonic Pi.app examples. Pass --roster
 * book-examples to build the 18 curriculum snippets instead.
 *
 * Idempotent: re-run picks up the latest matching .captures/compare_*<name>.md.
 *
 * Output (per roster):
 *   test_results/<rosterDir>/<slug>/{desktop.wav, web.wav, spectrogram.png, snippet.rb, report.md}
 *   test_results/<rosterDir>.json
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const CAPTURES = resolve(ROOT, '.captures')

// --- Roster config (selectable via --roster) -------------------------------
interface Roster {
  examplesDir: string
  outDirName: string     // test_results/<this>/
  outJsonName: string    // test_results/<this>.json
  recursive: boolean     // recurse into subdirs to collect .rb files?
}
const ROSTERS: Record<string, Roster> = {
  'official': {
    examplesDir: '/Applications/Sonic Pi.app/Contents/Resources/etc/examples',
    outDirName: 'examples-sweep',
    outJsonName: 'examples-sweep.json',
    recursive: true,
  },
  'book-examples': {
    examplesDir: resolve(ROOT, 'tests', 'book-examples'),
    outDirName: 'book-examples-sweep',
    outJsonName: 'book-examples-sweep.json',
    recursive: false,           // top-level only — community/in-thread-forum subdirs are their own rosters
  },
}

const argv = process.argv.slice(2)
const rosterName = (argv.find(a => a.startsWith('--roster=')) ?? '').split('=')[1]
  || (argv.includes('--roster') ? argv[argv.indexOf('--roster') + 1] : 'official')
if (!ROSTERS[rosterName]) {
  console.error(`Unknown roster '${rosterName}'. Valid: ${Object.keys(ROSTERS).join(', ')}`)
  process.exit(1)
}
const ROSTER = ROSTERS[rosterName]
const EXAMPLES_DIR = ROSTER.examplesDir
const OUT_DIR = resolve(ROOT, 'test_results', ROSTER.outDirName)
const OUT_JSON = resolve(ROOT, 'test_results', ROSTER.outJsonName)
console.log(`[build] roster='${rosterName}' src='${EXAMPLES_DIR}' → ${OUT_JSON}`)

// PRNG-indicating identifiers in user code → classifies row as PRNG-driven
const PRNG_RE = /\b(rrand|rrand_i|rand|rand_i|\.choose|\.shuffle|\.pick|one_in|dice|use_random_seed)\b/

interface SweepRow {
  n: number
  slug: string
  category: string
  example: string
  path: string
  verdict: 'match' | 'diverge' | 'prng-variant' | 'invalid' | 'inconcl' | 'error'
  verdictRaw: string
  tempoDesktop: number | null
  tempoWeb: number | null
  divergeAt: string | null
  prng: boolean
  prngFreeReal: boolean
  heavy: boolean
  pitchDesktop: string | null
  pitchWeb: string | null
  detectMethodDesktop: string | null
  detectMethodWeb: string | null
  onsetDesktop: number | null
  onsetWeb: number | null
  tier0Soft: boolean
  tier0Hard: string | null
  rmsRatio: number | null
  peakRatio: number | null
  l2MelDb: number | null
  mfccDist: number | null
  desktopStats: { duration: number; peak: number; rms: number; clipping: number; sampleRate: number; channels: number } | null
  webStats: { duration: number; peak: number; rms: number; clipping: number; sampleRate: number; channels: number } | null
  artifacts: {
    snippet: string | null
    desktopWav: string | null
    webWav: string | null
    spectrogramPng: string | null
    report: string | null
  }
  consoleErrors: string[]
  reportTimestamp: string | null
}

// Relative paths under EXAMPLES_DIR — recursive or top-level per roster config.
const EXAMPLES: string[] = []
function collectRb(dir: string, recurse: boolean) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (recurse) collectRb(p, true)
    } else if (name.endsWith('.rb')) {
      EXAMPLES.push(p)
    }
  }
}
collectRb(EXAMPLES_DIR, ROSTER.recursive)
EXAMPLES.sort()

function findLatestReport(exampleBaseNoExt: string): string | null {
  if (!existsSync(CAPTURES)) return null
  const files = readdirSync(CAPTURES)
    .filter(f => f.startsWith('compare_') && f.endsWith(`_${exampleBaseNoExt}.md`))
    .map(f => resolve(CAPTURES, f))
  if (!files.length) return null
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0]
}

function parseReport(reportPath: string): Partial<SweepRow> {
  const md = readFileSync(reportPath, 'utf8')
  const row: Partial<SweepRow> = {
    pitchDesktop: null, pitchWeb: null, divergeAt: null,
    tempoDesktop: null, tempoWeb: null,
    onsetDesktop: null, onsetWeb: null,
    rmsRatio: null, peakRatio: null, l2MelDb: null, mfccDist: null,
    desktopStats: null, webStats: null,
    tier0Soft: false, tier0Hard: null,
    verdictRaw: '',
    detectMethodDesktop: null, detectMethodWeb: null,
    consoleErrors: [],
    reportTimestamp: null,
  }

  // Timestamp
  const ts = md.match(/\*\*Timestamp:\*\*\s+([^\n]+)/)
  if (ts) row.reportTimestamp = ts[1].trim()

  // Verdict headline
  const verdictLine = md.match(/^###\s+(.+)$/m)
  if (verdictLine) {
    row.verdictRaw = verdictLine[1].trim()
    // #371: match ERROR before INVALID — the ERROR header contains "❌" too,
    // and the ERROR root cause must NOT be re-bucketed as a generic INVALID.
    if (/^❌ ERROR\b/.test(row.verdictRaw) || /\bERROR\b — Web engine threw/.test(row.verdictRaw)) row.verdict = 'error'
    else if (/PRNG-VARIANT/.test(row.verdictRaw)) row.verdict = 'prng-variant'
    else if (/PITCH-MATCH/.test(row.verdictRaw)) row.verdict = 'match'
    else if (/PITCH DIVERGENCE/.test(row.verdictRaw)) {
      row.verdict = 'diverge'
      const m = row.verdictRaw.match(/at (note|pc) (\d+)/)
      if (m) row.divergeAt = `${m[1]} ${m[2]}`
    } else if (/INVALID/.test(row.verdictRaw)) row.verdict = 'invalid'
    else if (/inconclusive/i.test(row.verdictRaw)) row.verdict = 'inconcl'
    else row.verdict = 'inconcl'
  }

  // Tier-0 SOFT / HARD
  if (/0\.2[^\n]*\(SOFT/.test(md)) row.tier0Soft = true
  const hard = md.match(/✗\s+(Web produced no WAV[^\n]*)/)
  if (hard) row.tier0Hard = hard[1]
  const hardSR = md.match(/✗\s+(Sample rate inconsistent[^\n]*)/)
  if (hardSR) row.tier0Hard = (row.tier0Hard ? row.tier0Hard + '; ' : '') + hardSR[1]

  // Pitch tracks and detect methods
  const pitchD = md.match(/desktop:\s+`([0-9,\s]+)`/)
  const pitchW = md.match(/web&nbsp;&nbsp;&nbsp;:\s+`([0-9,\s]+)`/)
  if (pitchD) row.pitchDesktop = pitchD[1]
  if (pitchW) row.pitchWeb = pitchW[1]
  const dm = md.match(/method:\s+desktop\s+`(\w+)`[^\n]*·\s+web\s+`(\w+)`/)
  if (dm) { row.detectMethodDesktop = dm[1]; row.detectMethodWeb = dm[2] }

  // Tempo
  const tempo = md.match(/Tempo \(inter-onset\):\*\*\s+[✓✗]\s+desktop\s+([\d.]+)s\s+·\s+web\s+([\d.]+)s/)
  if (tempo) { row.tempoDesktop = parseFloat(tempo[1]); row.tempoWeb = parseFloat(tempo[2]) }

  // Onset counts
  const onset = md.match(/Onset count:\*\*\s+desktop\s+(\d+)\s+·\s+web\s+(\d+)/)
  if (onset) { row.onsetDesktop = parseInt(onset[1]); row.onsetWeb = parseInt(onset[2]) }

  // Stats table
  const stats = md.match(/Duration \(s\)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
  if (stats) {
    const dDur = parseFloat(stats[1])
    const wDur = stats[2] === '—' ? null : parseFloat(stats[2])
    const peak = md.match(/\|\s+Peak\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const rms  = md.match(/\|\s+RMS\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const clip = md.match(/\|\s+Clipping[^|]+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const sr   = md.match(/\|\s+Sample rate \(Hz\)\s+\|\s+(\d+)\s+\|\s+(\d+|—)/)
    const ch   = md.match(/\|\s+Channels\s+\|\s+(\d+)\s+\|\s+(\d+|—)/)
    if (peak && rms) {
      row.desktopStats = {
        duration: dDur,
        peak: parseFloat(peak[1]),
        rms: parseFloat(rms[1]),
        clipping: clip ? parseFloat(clip[1]) : 0,
        sampleRate: sr ? parseInt(sr[1]) : 48000,
        channels: ch ? parseInt(ch[1]) : 2,
      }
      if (wDur !== null && peak[2] !== '—' && rms[2] !== '—') {
        row.webStats = {
          duration: wDur,
          peak: parseFloat(peak[2]),
          rms: parseFloat(rms[2]),
          clipping: clip && clip[2] !== '—' ? parseFloat(clip[2]) : 0,
          sampleRate: sr && sr[2] !== '—' ? parseInt(sr[2]) : 48000,
          channels: ch && ch[2] !== '—' ? parseInt(ch[2]) : 2,
        }
      }
    }
  }

  // Ratios (Tier 3)
  const rmsR = md.match(/RMS ratio web\/desktop\s+=\s+([\d.]+)×/)
  const peakR = md.match(/Peak ratio web\/desktop\s+=\s+([\d.]+)×/)
  if (rmsR) row.rmsRatio = parseFloat(rmsR[1])
  if (peakR) row.peakRatio = parseFloat(peakR[1])

  // L2 / MFCC
  const l2 = md.match(/L2 distance \(mel-dB\)\s+\|\s+([\d.]+)/)
  const mfcc = md.match(/MFCC distance \(timbre\)\s+\|\s+([\d.]+)/)
  if (l2) row.l2MelDb = parseFloat(l2[1])
  if (mfcc) row.mfccDist = parseFloat(mfcc[1])

  // Web stdout — capture error fragments
  const webStdout = md.match(/### Web\n```\n([\s\S]+?)```/)
  if (webStdout) {
    const errs = webStdout[1].match(/(Detail:[^\n]+|.+isn't available[^\n]*|.+is not a function[^\n]*)/g)
    if (errs) row.consoleErrors = errs.slice(0, 5)
  }

  // Source WAV paths
  const wavD = md.match(/\*\*Desktop:\*\*\s+([^\n]+\.wav)/)
  const wavW = md.match(/\*\*Web:\*\*\s+(?!_)([^\n]+\.wav)/)
  // Spectrogram PNG
  const png = md.match(/!\[spectrogram[^\]]*\]\(([^)]+\.png)\)/)
  row.artifacts = {
    snippet: null,
    desktopWav: wavD ? wavD[1].trim() : null,
    webWav: wavW ? wavW[1].trim() : null,
    spectrogramPng: png ? png[1].trim() : null,
    report: reportPath,
  }
  return row
}

function slugify(path: string): string {
  // illusionist/chord_inversions.rb → illusionist__chord_inversions
  return path.replace(/\.rb$/, '').replace(/\//g, '__')
}

function copyArtifact(srcAbs: string, destAbs: string): boolean {
  if (!existsSync(srcAbs)) return false
  mkdirSync(dirname(destAbs), { recursive: true })
  copyFileSync(srcAbs, destAbs)
  return true
}

mkdirSync(OUT_DIR, { recursive: true })

const rows: SweepRow[] = []
let n = 0

for (const examplePath of EXAMPLES) {
  n++
  const rel = examplePath.substring(EXAMPLES_DIR.length + 1)
  // Two layouts handled:
  //   - nested (recursive=true):  "<category>/<file>.rb"  → category from prefix
  //   - flat   (recursive=false): "<file>.rb"             → category derived from filename prefix (chN_/eN_/etc.) or 'main'
  let category: string
  let file: string
  if (rel.includes('/')) {
    [category, file] = rel.split('/')
  } else {
    file = rel
    const m = file.match(/^(ch\d+|e2e_\d+|[a-z]+)_/)
    category = m ? m[1] : 'main'
  }
  const example = file.replace(/\.rb$/, '')
  const slug = slugify(rel)
  const exampleSrc = readFileSync(examplePath, 'utf8')
  const prng = PRNG_RE.test(exampleSrc)

  const report = findLatestReport(example)
  const parsed: Partial<SweepRow> = report ? parseReport(report) : { verdict: 'invalid', verdictRaw: 'NO REPORT — sweep not run for this example' }

  // Decide classification badges
  const heavyHint = parsed.tier0Hard?.includes('no WAV') ?? false

  const row: SweepRow = {
    n,
    slug,
    category,
    example,
    path: rel,
    verdict: parsed.verdict ?? 'invalid',
    verdictRaw: parsed.verdictRaw ?? '',
    tempoDesktop: parsed.tempoDesktop ?? null,
    tempoWeb: parsed.tempoWeb ?? null,
    divergeAt: parsed.divergeAt ?? null,
    prng,
    prngFreeReal: false, // set after verdict
    heavy: heavyHint,
    pitchDesktop: parsed.pitchDesktop ?? null,
    pitchWeb: parsed.pitchWeb ?? null,
    detectMethodDesktop: parsed.detectMethodDesktop ?? null,
    detectMethodWeb: parsed.detectMethodWeb ?? null,
    onsetDesktop: parsed.onsetDesktop ?? null,
    onsetWeb: parsed.onsetWeb ?? null,
    tier0Soft: parsed.tier0Soft ?? false,
    tier0Hard: parsed.tier0Hard ?? null,
    rmsRatio: parsed.rmsRatio ?? null,
    peakRatio: parsed.peakRatio ?? null,
    l2MelDb: parsed.l2MelDb ?? null,
    mfccDist: parsed.mfccDist ?? null,
    desktopStats: parsed.desktopStats ?? null,
    webStats: parsed.webStats ?? null,
    consoleErrors: parsed.consoleErrors ?? [],
    reportTimestamp: parsed.reportTimestamp ?? null,
    artifacts: { snippet: null, desktopWav: null, webWav: null, spectrogramPng: null, report: null },
  }
  // PRNG-free real divergence: DIVERGE + no PRNG
  // PRNG-free real divergences = engine bugs in non-random examples — the
  // actionable backlog. ERROR rows are root-caused by a throw, not parity;
  // they belong to their own bucket (#371) and must NOT inflate the backlog.
  if (row.verdict === 'diverge' && !row.prng) row.prngFreeReal = true

  // Copy artifacts into test_results/examples-sweep/<slug>/
  const slugDir = resolve(OUT_DIR, slug)
  // Snippet (always — straight from EXAMPLES_DIR)
  const snippetDest = join(slugDir, 'snippet.rb')
  copyArtifact(examplePath, snippetDest)
  row.artifacts.snippet = `examples-sweep/${slug}/snippet.rb`

  if (parsed.artifacts?.desktopWav) {
    const dest = join(slugDir, 'desktop.wav')
    if (copyArtifact(parsed.artifacts.desktopWav, dest)) {
      row.artifacts.desktopWav = `examples-sweep/${slug}/desktop.wav`
    }
  }
  if (parsed.artifacts?.webWav) {
    const dest = join(slugDir, 'web.wav')
    if (copyArtifact(parsed.artifacts.webWav, dest)) {
      row.artifacts.webWav = `examples-sweep/${slug}/web.wav`
    }
  }
  if (parsed.artifacts?.spectrogramPng) {
    const dest = join(slugDir, 'spectrogram.png')
    if (copyArtifact(parsed.artifacts.spectrogramPng, dest)) {
      row.artifacts.spectrogramPng = `examples-sweep/${slug}/spectrogram.png`
    }
  }
  if (parsed.artifacts?.report) {
    const dest = join(slugDir, 'report.md')
    if (copyArtifact(parsed.artifacts.report, dest)) {
      row.artifacts.report = `examples-sweep/${slug}/report.md`
    }
  }

  rows.push(row)
}

// Counts and the headline sweep metadata
const counts = {
  match: rows.filter(r => r.verdict === 'match').length,
  diverge: rows.filter(r => r.verdict === 'diverge').length,
  prngVariant: rows.filter(r => r.verdict === 'prng-variant').length,
  invalid: rows.filter(r => r.verdict === 'invalid').length,
  inconcl: rows.filter(r => r.verdict === 'inconcl').length,
  error: rows.filter(r => r.verdict === 'error').length,
  prng: rows.filter(r => r.prng).length,
  prngFreeReal: rows.filter(r => r.prngFreeReal).length,
  heavy: rows.filter(r => r.heavy).length,
  totalRows: rows.length,
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: '/Applications/Sonic Pi.app/Contents/Resources/etc/examples/',
  toolUsed: 'tools/compare-desktop-vs-web.ts',
  durationMs: 15000,
  perExampleTimeoutSec: 90,
  counts,
  entries: rows,
}

writeFileSync(OUT_JSON, JSON.stringify(manifest, null, 2))

console.log(`✓ Built ${rows.length} entries → ${OUT_JSON}`)
console.log(`  match=${counts.match} · prng-variant=${counts.prngVariant} · diverge=${counts.diverge} · invalid=${counts.invalid} · inconcl=${counts.inconcl} · error=${counts.error}`)
console.log(`  PRNG-driven=${counts.prng} · PRNG-free real divergences=${counts.prngFreeReal} (the actionable backlog) · heavy-tool-fail=${counts.heavy}`)
const missingDesk = rows.filter(r => !r.artifacts.desktopWav).length
const missingWeb = rows.filter(r => !r.artifacts.webWav).length
const missingPng = rows.filter(r => !r.artifacts.spectrogramPng).length
console.log(`  missing artifacts: desktop.wav=${missingDesk} · web.wav=${missingWeb} · spectrogram.png=${missingPng}`)
