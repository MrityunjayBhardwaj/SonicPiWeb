/**
 * FX WAV-verify sweep — runs every wired FX through the A/B comparator,
 * categorizes each as HIGH / MID / LOW / INCONCLUSIVE, and writes a baseline JSON for
 * regression checks.
 *
 * Why: 40 FX are wired in src/engine/SonicPiEngine.ts:462-470 but only a
 * handful have been WAV-verified end-to-end against Desktop SP. This tool
 * raises the verified count to all of them in one shot and bakes a baseline
 * so future PRs can detect regressions with `npm run fx-sweep`.
 *
 * Prereqs (BOTH must hold):
 *   1. Sonic Pi.app must be running and healthy. The tool does an SP60 gate
 *      check (:bd_haus baseline) before sweeping.
 *   2. The browser dev server must be running on :5173.
 *
 * Usage:
 *   npx tsx tools/fx-sweep.ts                  # all 40 FX
 *   npx tsx tools/fx-sweep.ts --only reverb,echo  # subset
 *   npx tsx tools/fx-sweep.ts --skip vowel,whammy # exclude
 *   npx tsx tools/fx-sweep.ts --baseline .captures/fx-baseline.json # diff against
 *
 * Output:
 *   .captures/fx-sweep/snippet-<fx>.rb       — per-FX snippet (re-runnable)
 *   .captures/fx-sweep/<fx>.json             — sidecar metrics
 *   .captures/fx-sweep/SUMMARY.md            — HIGH/MID/LOW/INCONCLUSIVE table
 *   .captures/fx-baseline.json               — baseline for regression diffs
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(__dirname, '..')
const SWEEP_DIR = resolve(ROOT_DIR, '.captures/fx-sweep')
const BASELINE_PATH = resolve(ROOT_DIR, '.captures/fx-baseline.json')

// ---------------------------------------------------------------------------
// FX list — mirrors src/engine/SonicPiEngine.ts:462-470 fx_names_fn.
// Per-FX snippet flavor:
//   "rhythmic"  → percussive bd_haus + sn_dub at 120bpm (default)
//   "sustained" → continuous prophet pad — needed for FX that operate on
//                 sustained signal (slicer, tremolo, panslicer, vowel) so the
//                 modulation has signal to chop / tremolo / vowel-shape.
// ---------------------------------------------------------------------------

type SnippetFlavor = 'rhythmic' | 'sustained'

interface FxSpec {
  name: string
  flavor: SnippetFlavor
}

const FX_LIST: FxSpec[] = [
  // Time-based / spatial
  { name: 'reverb',       flavor: 'rhythmic'  },
  { name: 'echo',         flavor: 'rhythmic'  },
  { name: 'delay',        flavor: 'rhythmic'  },
  { name: 'gverb',        flavor: 'rhythmic'  },
  { name: 'ping_pong',    flavor: 'rhythmic'  },
  // Dynamics
  { name: 'compressor',   flavor: 'rhythmic'  },
  { name: 'normaliser',   flavor: 'rhythmic'  },
  { name: 'level',        flavor: 'rhythmic'  },
  // Distortion / saturation
  { name: 'distortion',   flavor: 'rhythmic'  },
  { name: 'krush',        flavor: 'rhythmic'  },
  { name: 'bitcrusher',   flavor: 'rhythmic'  },
  { name: 'tanh',         flavor: 'rhythmic'  },
  // Modulation — these need sustained signal to be audibly different
  { name: 'slicer',       flavor: 'sustained' },
  { name: 'panslicer',    flavor: 'sustained' },
  { name: 'tremolo',      flavor: 'sustained' },
  { name: 'wobble',       flavor: 'sustained' },
  { name: 'flanger',      flavor: 'rhythmic'  },
  { name: 'chorus',       flavor: 'rhythmic'  },
  { name: 'ring_mod',     flavor: 'sustained' },
  { name: 'vowel',        flavor: 'sustained' },
  { name: 'octaver',      flavor: 'rhythmic'  },
  // Pitch
  { name: 'pitch_shift',  flavor: 'rhythmic'  },
  { name: 'whammy',       flavor: 'rhythmic'  },
  // Stereo
  { name: 'pan',          flavor: 'rhythmic'  },
  { name: 'mono',         flavor: 'rhythmic'  },
  // Genre
  { name: 'ixi_techno',   flavor: 'rhythmic'  },
  // Filters
  { name: 'rlpf',         flavor: 'rhythmic'  },
  { name: 'rhpf',         flavor: 'rhythmic'  },
  { name: 'hpf',          flavor: 'rhythmic'  },
  { name: 'lpf',          flavor: 'rhythmic'  },
  { name: 'band_eq',      flavor: 'rhythmic'  },
  { name: 'bpf',          flavor: 'rhythmic'  },
  { name: 'rbpf',         flavor: 'rhythmic'  },
  { name: 'nbpf',         flavor: 'rhythmic'  },
  { name: 'nrbpf',        flavor: 'rhythmic'  },
  { name: 'nlpf',         flavor: 'rhythmic'  },
  { name: 'nrlpf',        flavor: 'rhythmic'  },
  { name: 'nhpf',         flavor: 'rhythmic'  },
  { name: 'nrhpf',        flavor: 'rhythmic'  },
  { name: 'eq',           flavor: 'rhythmic'  },
]

const RHYTHMIC_SNIPPET = (fx: string): string =>
  `use_bpm 120
use_random_seed 42
with_fx :${fx} do
  live_loop :probe do
    sample :bd_haus
    sleep 0.5
    sample :sn_dub
    sleep 0.5
  end
end
`

const SUSTAINED_SNIPPET = (fx: string): string =>
  `use_bpm 120
use_random_seed 42
with_fx :${fx} do
  live_loop :probe do
    use_synth :prophet
    play :c4, release: 1, cutoff: 80, amp: 0.5
    sleep 1
    play :e4, release: 1, cutoff: 80, amp: 0.5
    sleep 1
  end
end
`

const renderSnippet = (fx: FxSpec): string =>
  fx.flavor === 'sustained' ? SUSTAINED_SNIPPET(fx.name) : RHYTHMIC_SNIPPET(fx.name)

// Sweep parameters — kept small + fixed so baseline is meaningful across runs.
const SWEEP_DURATION_MS = 5000
const SWEEP_BPM = 120
const SWEEP_BEATS = 8
// Two leading-beat sources of asymmetry we don't want to flag as FX bugs:
//   1. Desktop scsynth's ~2-beat warm-up before audio settles (SP22).
//   2. Web's Chromium boot is slower than Sonic Pi.app's OSC dispatch, so
//      web's recording-start lags desktop's by ~0.5 beat at 120 bpm — costing
//      one extra beat of "silent on web only" at the start.
// Total: skip first 3 beats from silent-beat asymmetry detection. The
// remaining 5 (of 8) give enough signal to detect a truly silent or wrong-FX
// path. Eyeballed from comparator runs in session 2026-05-05.
const WARMUP_BEATS = 3

// ---------------------------------------------------------------------------
// SP60 desktop-health gate
// ---------------------------------------------------------------------------

function sp60Gate(): { ok: boolean; reason: string } {
  const spiderLogPath = `${process.env.HOME}/.sonic-pi/log/spider.log`
  if (!existsSync(spiderLogPath)) {
    return { ok: false, reason: 'Sonic Pi.app does not appear to be running (spider.log missing)' }
  }
  const log = readFileSync(spiderLogPath, 'utf8')
  if (/PromiseTimeoutError|buffer_alloc/.test(log.split('\n').slice(-200).join('\n'))) {
    return { ok: false, reason: 'spider.log shows recent PromiseTimeoutError / buffer_alloc — restart Sonic Pi.app' }
  }

  // Run :bd_haus baseline through capture-desktop directly.
  console.log('[sp60] running :bd_haus desktop baseline...')
  try {
    const out = execSync(
      `npx tsx tools/capture-desktop.ts "sample :bd_haus
sleep 1" --duration 4000 --name sp60-gate`,
      { cwd: ROOT_DIR, encoding: 'utf8', timeout: 30000 },
    )
    if (!/✓ WAV:/.test(out)) {
      return { ok: false, reason: 'baseline produced no WAV — see captures/desktop_*sp60-gate.md' }
    }
    return { ok: true, reason: 'baseline WAV produced' }
  } catch (err) {
    return { ok: false, reason: `baseline failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function devServerUp(): boolean {
  try {
    execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:5173', { encoding: 'utf8', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Run one FX through the comparator
// ---------------------------------------------------------------------------

interface FxMetrics {
  fx: string
  flavor: SnippetFlavor
  desktop: { rms: number; peak: number; duration: number } | null
  web: { rms: number; peak: number; duration: number } | null
  rmsRatio: number | null   // web/desktop
  peakRatio: number | null
  l2MelDb: number | null
  mfccDist: number | null
  silentDesktopBeats: number[]
  silentWebBeats: number[]
  silentBeatAsymmetry: boolean
  meanPerBeatMfcc: number | null
  reportPath: string
  jsonPath: string
  errors: string[]
}

interface FxComparisonJson {
  desktop: { wavPath: string | null; stats: { rms: number; peak: number; duration: number } | null }
  web:     { wavPath: string | null; stats: { rms: number; peak: number; duration: number } | null }
  spectrogram: {
    l2_mel_db: number
    mfcc_distance: number
    per_beat: {
      rows: { beat: number; desktop_rms: number; web_rms: number }[]
      mean_per_beat_mfcc_distance: number
    } | null
  } | null
  reportPath: string
}

function emptyMetrics(fx: FxSpec, jsonPath: string): FxMetrics {
  return {
    fx: fx.name,
    flavor: fx.flavor,
    desktop: null,
    web: null,
    rmsRatio: null,
    peakRatio: null,
    l2MelDb: null,
    mfccDist: null,
    silentDesktopBeats: [],
    silentWebBeats: [],
    silentBeatAsymmetry: false,
    meanPerBeatMfcc: null,
    reportPath: '',
    jsonPath,
    errors: [],
  }
}

// Hydrate FxMetrics from a per-FX sidecar JSON written by a prior sweep run.
// Used by both runFx (after the comparator subprocess writes the file) and
// --reclassify-only (which skips recording entirely).
function metricsFromSidecar(fx: FxSpec, jsonPath: string): FxMetrics {
  const m = emptyMetrics(fx, jsonPath)
  if (!existsSync(jsonPath)) {
    m.errors.push('sidecar JSON not found')
    return m
  }
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8')) as FxComparisonJson
    m.reportPath = j.reportPath
    m.desktop = j.desktop.stats ? {
      rms: j.desktop.stats.rms, peak: j.desktop.stats.peak, duration: j.desktop.stats.duration,
    } : null
    m.web = j.web.stats ? {
      rms: j.web.stats.rms, peak: j.web.stats.peak, duration: j.web.stats.duration,
    } : null
    if (m.desktop && m.web) {
      m.rmsRatio = m.desktop.rms > 0 ? m.web.rms / m.desktop.rms : null
      m.peakRatio = m.desktop.peak > 0 ? m.web.peak / m.desktop.peak : null
    }
    if (j.spectrogram) {
      m.l2MelDb = j.spectrogram.l2_mel_db
      m.mfccDist = j.spectrogram.mfcc_distance
      if (j.spectrogram.per_beat) {
        m.meanPerBeatMfcc = j.spectrogram.per_beat.mean_per_beat_mfcc_distance
        m.silentDesktopBeats = j.spectrogram.per_beat.rows
          .filter((r) => r.desktop_rms < 0.001).map((r) => r.beat)
        m.silentWebBeats = j.spectrogram.per_beat.rows
          .filter((r) => r.web_rms < 0.001).map((r) => r.beat)
        const dPost = m.silentDesktopBeats.filter((b) => b >= WARMUP_BEATS)
        const wPost = m.silentWebBeats.filter((b) => b >= WARMUP_BEATS)
        m.silentBeatAsymmetry = dPost.length !== wPost.length
      }
    }
  } catch (err) {
    m.errors.push(`failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return m
}

async function runFx(fx: FxSpec): Promise<FxMetrics> {
  const snippetPath = resolve(SWEEP_DIR, `snippet-${fx.name}.rb`)
  writeFileSync(snippetPath, renderSnippet(fx))

  const jsonPath = resolve(SWEEP_DIR, `${fx.name}.json`)

  return new Promise<FxMetrics>((resolveP) => {
    const child = spawn(
      'npx',
      [
        'tsx', 'tools/compare-desktop-vs-web.ts',
        '--file', snippetPath,
        '--duration', String(SWEEP_DURATION_MS),
        '--bpm', String(SWEEP_BPM),
        '--beats', String(SWEEP_BEATS),
        '--name', `fx-${fx.name}`,
        '--json-out', jsonPath,
      ],
      { cwd: ROOT_DIR },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('close', () => {
      if (!existsSync(jsonPath)) {
        const m = emptyMetrics(fx, jsonPath)
        m.errors.push('comparator did not write JSON sidecar')
        m.errors.push(`stdout: ${stdout.trim().slice(-300)}`)
        if (stderr.trim()) m.errors.push(`stderr: ${stderr.trim().slice(-300)}`)
        resolveP(m)
        return
      }
      // Hydrate from the freshly-written sidecar. Asymmetry check excludes
      // WARMUP_BEATS leading beats — desktop's scsynth needs ~2 beats to
      // settle before audio fires (SP22). Web doesn't have this delay, so
      // beats 0..WARMUP_BEATS-1 always look asymmetric without indicating
      // a real bug.
      resolveP(metricsFromSidecar(fx, jsonPath))
    })
  })
}

// ---------------------------------------------------------------------------
// Score-band classification (HIGH / MID / LOW / INCONCLUSIVE)
// ---------------------------------------------------------------------------
//
// Original PASS/FLAG/FAIL scheme was retired in #278 — PASS only required
// L2 ≤ 25 dB (≈17× per-band divergence) and ignored MFCC entirely, so 9 of
// 9 PASS verdicts had spectrograms that visibly didn't match desktop. The
// new tiers are pure score-band labels with a single hard MFCC gate on the
// top tier.
//
//   HIGH         score ≥ 70 AND MFCC dist ≤ 180   (close in level AND timbre)
//   MID          50 ≤ score < 70, OR HIGH-score-but-MFCC > 180
//   LOW          score < 50  (significantly different)
//   INCONCLUSIVE desktop side missing or silent — can't compare
//
// FAIL-style breakage (web-side missing, silent-beat asymmetry past warm-up)
// produces score < 50 → LOW with a reason explaining why. We don't reuse
// FAIL as a separate label because the score band already places these at
// the bottom and the reason text disambiguates.

type Verdict = 'HIGH' | 'MID' | 'LOW' | 'INCONCLUSIVE'

const HIGH_SCORE_THRESHOLD = 70
const HIGH_MFCC_THRESHOLD = 180
const MID_SCORE_THRESHOLD = 50

function verdictTag(v: Verdict): string {
  switch (v) {
    case 'HIGH': return '✓'
    case 'MID': return '~'
    case 'LOW': return '✗'
    case 'INCONCLUSIVE': return '?'
  }
}

// Composite consistency score 0-100 against Desktop SP. 100 = identical, 0 =
// unrelated. Weighted average of four parity components:
//   30% RMS-ratio    : log-distance, penalizes 2× and 0.5× equally
//   15% Peak-ratio   : same shape, less weight (peak is noisier than RMS)
//   30% L2 (mel-dB)  : linear, 0dB → 100, 50dB → 0 (cap)
//   25% MFCC distance: linear, 0 → 100, 500 → 0 (cap)
// Returns null when any component is unavailable (INCONCLUSIVE / no WAV).
function ratioComponent(r: number | null): number {
  if (r === null || r <= 0) return 0
  return Math.max(0, 100 - 50 * Math.abs(Math.log2(r)))
}
function l2Component(v: number | null): number {
  if (v === null) return 0
  return Math.max(0, 100 - 2 * v)
}
function mfccComponent(v: number | null): number {
  if (v === null) return 0
  return Math.max(0, 100 - 0.2 * v)
}
function consistencyScore(m: FxMetrics): number | null {
  if (!m.desktop || !m.web) return null
  if (m.rmsRatio === null && m.peakRatio === null && m.l2MelDb === null && m.mfccDist === null) return null
  return (
    0.30 * ratioComponent(m.rmsRatio) +
    0.15 * ratioComponent(m.peakRatio) +
    0.30 * l2Component(m.l2MelDb) +
    0.25 * mfccComponent(m.mfccDist)
  )
}

function classify(m: FxMetrics, score: number | null): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = []
  // INCONCLUSIVE: desktop side is broken (silent or empty), so we can't
  // compare. Likely a Desktop SP bug for that FX, not a web issue.
  if (!m.desktop) {
    reasons.push('desktop produced no WAV — Desktop SP issue, web cannot be evaluated')
    return { verdict: 'INCONCLUSIVE', reasons }
  }
  if (m.desktop.rms < 0.001 && m.desktop.peak < 0.01) {
    reasons.push(`desktop produced silence (peak=${m.desktop.peak}, rms=${m.desktop.rms}) — Desktop SP issue, web cannot be evaluated`)
    return { verdict: 'INCONCLUSIVE', reasons }
  }
  // Web missing → score is null → tier by score logic below would fail. Route
  // to LOW with explicit reason. Past sweep runs have never hit this; included
  // for completeness.
  if (!m.web) {
    reasons.push('web produced no WAV')
    return { verdict: 'LOW', reasons }
  }
  // Silent-beat asymmetry past warm-up is a real signal-path break, not just
  // a level/shape divergence. Surface it via reason text; tier still falls out
  // of the score band (will land in MID or LOW depending on numbers).
  if (m.silentBeatAsymmetry) {
    const dPost = m.silentDesktopBeats.filter((b) => b >= WARMUP_BEATS)
    const wPost = m.silentWebBeats.filter((b) => b >= WARMUP_BEATS)
    reasons.push(
      `silent-beat asymmetry past warm-up: desktop silent on [${dPost.join(',') || '–'}] · web silent on [${wPost.join(',') || '–'}]`,
    )
  }

  if (score === null) {
    reasons.push('score not computable')
    return { verdict: 'LOW', reasons }
  }

  // Tier by score, gated by MFCC for the top band
  if (score >= HIGH_SCORE_THRESHOLD && m.mfccDist !== null && m.mfccDist <= HIGH_MFCC_THRESHOLD) {
    reasons.push(
      `score ${score.toFixed(1)} · MFCC ${m.mfccDist.toFixed(0)} (≥${HIGH_SCORE_THRESHOLD} AND ≤${HIGH_MFCC_THRESHOLD})`,
    )
    return { verdict: 'HIGH', reasons }
  }
  if (score >= HIGH_SCORE_THRESHOLD && m.mfccDist !== null && m.mfccDist > HIGH_MFCC_THRESHOLD) {
    reasons.push(
      `score ${score.toFixed(1)} would qualify for HIGH but MFCC ${m.mfccDist.toFixed(0)} > ${HIGH_MFCC_THRESHOLD} (timbre diverges)`,
    )
    return { verdict: 'MID', reasons }
  }
  if (score >= MID_SCORE_THRESHOLD) {
    reasons.push(`score ${score.toFixed(1)} (audible divergence — recognisable but not parity)`)
    return { verdict: 'MID', reasons }
  }
  reasons.push(`score ${score.toFixed(1)} (significantly different)`)
  return { verdict: 'LOW', reasons }
}

// ---------------------------------------------------------------------------
// Summary writer
// ---------------------------------------------------------------------------

interface SweepRow {
  fx: string
  flavor: SnippetFlavor
  verdict: Verdict
  reasons: string[]
  score: number | null
  m: FxMetrics
}

function writeSummary(rows: SweepRow[], summaryPath: string): void {
  const counts: Record<Verdict, number> = { HIGH: 0, MID: 0, LOW: 0, INCONCLUSIVE: 0 }
  for (const r of rows) counts[r.verdict]++

  const lines: string[] = []
  lines.push('# FX WAV-verify sweep')
  lines.push('')
  lines.push(`- **Timestamp:** ${new Date().toISOString()}`)
  lines.push(`- **Total FX:** ${rows.length}`)
  lines.push(`- **HIGH:** ${counts.HIGH} · **MID:** ${counts.MID} · **LOW:** ${counts.LOW} · **INCONCLUSIVE:** ${counts.INCONCLUSIVE}`)
  const evaluated = rows.filter((r) => r.score !== null)
  if (evaluated.length > 0) {
    const mean = evaluated.reduce((s, r) => s + (r.score ?? 0), 0) / evaluated.length
    const sorted = evaluated.map((r) => r.score!).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    lines.push(`- **Mean consistency score:** ${mean.toFixed(1)} / 100 · **Median:** ${median.toFixed(1)} (${evaluated.length} evaluated, INCONCLUSIVE excluded)`)
  }
  lines.push(`- **Sweep config:** duration=${SWEEP_DURATION_MS}ms · bpm=${SWEEP_BPM} · beats=${SWEEP_BEATS}`)
  lines.push('')
  lines.push('## Verdicts')
  lines.push('')
  lines.push('Sorted by **consistency score** (100 = identical to desktop, 0 = unrelated; INCONCLUSIVE last).')
  lines.push('')
  lines.push('| FX | Flavor | Verdict | Score | RMS ratio | Peak ratio | L2 (mel-dB) | MFCC dist | Reasons |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  const sorted = [...rows].sort((a, b) => {
    if (a.score === null) return 1
    if (b.score === null) return -1
    return b.score - a.score
  })
  for (const r of sorted) {
    const m = r.m
    const fmtRatio = (v: number | null) => v === null ? '—' : v.toFixed(2) + '×'
    const fmt = (v: number | null) => v === null ? '—' : v.toFixed(1)
    const fmtScore = (v: number | null) => v === null ? '—' : v.toFixed(1)
    lines.push(
      `| \`${r.fx}\` | ${r.flavor} | ${r.verdict} | ${fmtScore(r.score)} | ${fmtRatio(m.rmsRatio)} | ${fmtRatio(m.peakRatio)} | ${fmt(m.l2MelDb)} | ${fmt(m.mfccDist)} | ${r.reasons.join('; ')} |`,
    )
  }
  lines.push('')
  lines.push('## Methodology')
  lines.push('')
  lines.push('Each FX runs through `tools/compare-desktop-vs-web.ts` with a fixed reference snippet.')
  lines.push('Rhythmic snippet: `:bd_haus + :sn_dub` at 120 bpm, 8 beats.')
  lines.push('Sustained snippet: `:prophet` pad with sustained notes (slicer / tremolo / vowel / wobble / panslicer / ring_mod need this to have signal to modulate).')
  lines.push('')
  lines.push('Categorization rules (see issues #271, #278):')
  lines.push(`- **HIGH:** score ≥ ${HIGH_SCORE_THRESHOLD} AND MFCC dist ≤ ${HIGH_MFCC_THRESHOLD} (close in level AND timbre)`)
  lines.push(`- **MID:** ${MID_SCORE_THRESHOLD} ≤ score < ${HIGH_SCORE_THRESHOLD}, OR HIGH-by-score-only-but-MFCC > ${HIGH_MFCC_THRESHOLD} (audible divergence)`)
  lines.push(`- **LOW:** score < ${MID_SCORE_THRESHOLD} (significantly different) — also covers web-missing and silent-beat asymmetry`)
  lines.push('- **INCONCLUSIVE:** desktop produced silence or no WAV — Desktop SP issue, web cannot be evaluated against it')
  lines.push('')
  lines.push('Consistency score (0-100):')
  lines.push('  `score = 0.30·ratio(rms) + 0.15·ratio(peak) + 0.30·l2(L2_dB) + 0.25·mfcc(MFCC_dist)`')
  lines.push('  where `ratio(r) = max(0, 100 − 50·|log2(r)|)`, `l2(v) = max(0, 100 − 2·v)`, `mfcc(v) = max(0, 100 − 0.2·v)`.')
  lines.push('  100 = identical to desktop, 0 = unrelated. Log-distance for ratios so 2× and 0.5× penalize equally.')
  lines.push('')
  lines.push('## Per-FX reports')
  lines.push('')
  for (const r of rows) {
    lines.push(`- \`${r.fx}\` (${r.verdict}): [${r.m.reportPath ? 'comparator report' : 'no report'}](${r.m.reportPath}) · [json](${r.m.jsonPath})`)
  }
  writeFileSync(summaryPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SweepArgs {
  only: string[] | null
  skip: string[]
  baseline: string | null
  reclassifyOnly: boolean
}

function parseArgs(argv: string[]): SweepArgs {
  let only: string[] | null = null
  let skip: string[] = []
  let baseline: string | null = null
  let reclassifyOnly = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') only = argv[++i].split(',').map(s => s.trim())
    else if (a === '--skip') skip = argv[++i].split(',').map(s => s.trim())
    else if (a === '--baseline') baseline = argv[++i]
    else if (a === '--reclassify-only') reclassifyOnly = true
  }
  return { only, skip, baseline, reclassifyOnly }
}

async function reclassifyOnly(args: SweepArgs): Promise<void> {
  let fxToRun = FX_LIST
  if (args.only) fxToRun = fxToRun.filter(f => args.only!.includes(f.name))
  if (args.skip.length) fxToRun = fxToRun.filter(f => !args.skip.includes(f.name))
  const isFullRun = fxToRun.length === FX_LIST.length

  console.log(`▶ Reclassifying ${fxToRun.length} FX from existing sidecars (no recording)`)
  const rows: SweepRow[] = []
  let missing = 0
  for (const fx of fxToRun) {
    const jsonPath = resolve(SWEEP_DIR, `${fx.name}.json`)
    if (!existsSync(jsonPath)) {
      console.log(`  ? ${fx.name}: sidecar missing — skipped`)
      missing++
      continue
    }
    const m = metricsFromSidecar(fx, jsonPath)
    const score = consistencyScore(m)
    const cls = classify(m, score)
    rows.push({ fx: fx.name, flavor: fx.flavor, verdict: cls.verdict, reasons: cls.reasons, score, m })
    const tag = verdictTag(cls.verdict)
    const scoreStr = score === null ? '' : ` (score ${score.toFixed(1)})`
    const mfccStr = m.mfccDist === null ? '' : ` MFCC=${m.mfccDist.toFixed(0)}`
    console.log(`  ${tag} ${fx.name.padEnd(12)} ${cls.verdict.padEnd(12)}${scoreStr}${mfccStr}`)
  }

  const summaryPath = resolve(SWEEP_DIR, 'SUMMARY.md')
  writeSummary(rows, summaryPath)

  const baseline: Record<string, BaselineEntry> = {}
  for (const r of rows) {
    baseline[r.fx] = {
      verdict: r.verdict,
      score: r.score,
      rmsRatio: r.m.rmsRatio,
      peakRatio: r.m.peakRatio,
      l2MelDb: r.m.l2MelDb,
      mfccDist: r.m.mfccDist,
    }
  }

  const counts: Record<Verdict, number> = { HIGH: 0, MID: 0, LOW: 0, INCONCLUSIVE: 0 }
  for (const r of rows) counts[r.verdict]++

  console.log(`\n✓ Summary: ${summaryPath}`)
  if (isFullRun) {
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
    console.log(`✓ Baseline: ${BASELINE_PATH}`)
  } else {
    console.log(`  (partial reclassify — baseline.json unchanged)`)
  }
  console.log(`  HIGH ${counts.HIGH} · MID ${counts.MID} · LOW ${counts.LOW} · INCONCLUSIVE ${counts.INCONCLUSIVE} (of ${rows.length})`)
  if (missing > 0) console.log(`  ${missing} sidecar(s) missing — re-run \`npm run fx-sweep\` to regenerate`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  mkdirSync(SWEEP_DIR, { recursive: true })

  // --reclassify-only: skip recording entirely. Re-read each per-FX sidecar
  // produced by a prior sweep, re-run classify() + consistencyScore(), and
  // emit a fresh baseline.json + SUMMARY.md. Lets us iterate on tier
  // thresholds (#278) without burning a 30-minute sweep cycle.
  if (args.reclassifyOnly) {
    await reclassifyOnly(args)
    return
  }

  // Preconditions
  console.log('[precondition] checking dev server on :5173...')
  if (!devServerUp()) {
    console.error('✗ dev server not responding on :5173. Run `npm run dev` and retry.')
    process.exit(1)
  }
  console.log('  ✓ dev server up')

  console.log('[precondition] SP60 desktop-health gate...')
  const gate = sp60Gate()
  if (!gate.ok) {
    console.error(`✗ SP60 gate failed: ${gate.reason}`)
    console.error('  Restart Sonic Pi.app and retry.')
    process.exit(1)
  }
  console.log(`  ✓ ${gate.reason}`)

  // Filter FX list
  let fxToRun = FX_LIST
  if (args.only) fxToRun = fxToRun.filter(f => args.only!.includes(f.name))
  if (args.skip.length) fxToRun = fxToRun.filter(f => !args.skip.includes(f.name))
  const isFullRun = fxToRun.length === FX_LIST.length

  // Read --baseline INTO MEMORY before any writes — otherwise a partial run
  // (--only / --skip) that points --baseline at the same path would diff
  // against the file the run is about to overwrite, producing a meaningless
  // self-diff.
  let priorBaseline: Record<string, BaselineEntry> | null = null
  if (args.baseline && existsSync(args.baseline)) {
    priorBaseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as Record<string, BaselineEntry>
  }

  console.log(`\n▶ Sweeping ${fxToRun.length} FX (of ${FX_LIST.length} total)`)
  console.log(`  duration=${SWEEP_DURATION_MS}ms · bpm=${SWEEP_BPM} · beats=${SWEEP_BEATS}\n`)

  const rows: SweepRow[] = []
  for (let i = 0; i < fxToRun.length; i++) {
    const fx = fxToRun[i]
    process.stdout.write(`[${i + 1}/${fxToRun.length}] :${fx.name} (${fx.flavor})... `)
    const m = await runFx(fx)
    const score = consistencyScore(m)
    const cls = classify(m, score)
    rows.push({ fx: fx.name, flavor: fx.flavor, verdict: cls.verdict, reasons: cls.reasons, score, m })
    const tag = verdictTag(cls.verdict)
    const scoreStr = score === null ? '' : ` (score ${score.toFixed(1)})`
    console.log(`${tag} ${cls.verdict}${scoreStr}`)
    if (cls.verdict !== 'HIGH') {
      for (const reason of cls.reasons) console.log(`     ${reason}`)
    }
  }

  const summaryPath = resolve(SWEEP_DIR, 'SUMMARY.md')
  writeSummary(rows, summaryPath)

  // Baseline JSON: small, programmatic shape
  const baseline: Record<string, BaselineEntry> = {}
  for (const r of rows) {
    baseline[r.fx] = {
      verdict: r.verdict,
      score: r.score,
      rmsRatio: r.m.rmsRatio,
      peakRatio: r.m.peakRatio,
      l2MelDb: r.m.l2MelDb,
      mfccDist: r.m.mfccDist,
    }
  }

  // Only persist .captures/fx-baseline.json on a full sweep — partial runs
  // would either overwrite the canonical baseline with an incomplete snapshot
  // (silently breaking future regression diffs) or shrink it to just the
  // subset. Either way is a footgun.
  const counts: Record<Verdict, number> = { HIGH: 0, MID: 0, LOW: 0, INCONCLUSIVE: 0 }
  for (const r of rows) counts[r.verdict]++

  console.log(`\n✓ Summary: ${summaryPath}`)
  if (isFullRun) {
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
    console.log(`✓ Baseline: ${BASELINE_PATH}`)
  } else {
    console.log(`  (partial run — baseline.json unchanged)`)
  }
  console.log(`  HIGH ${counts.HIGH} · MID ${counts.MID} · LOW ${counts.LOW} · INCONCLUSIVE ${counts.INCONCLUSIVE} (of ${rows.length})`)

  // Diff against prior baseline if requested. priorBaseline was read into
  // memory BEFORE the new baseline was written, so even when --baseline points
  // at .captures/fx-baseline.json the diff is meaningful.
  if (priorBaseline) {
    console.log(`\n▶ Diffing against ${args.baseline}`)
    let regressed = 0
    let improved = 0
    let scoreDelta = 0
    let scoreCompared = 0
    const tierRank: Record<string, number> = { HIGH: 3, MID: 2, LOW: 1, INCONCLUSIVE: 0, PASS: 3, FLAG: 2, FAIL: 1 }
    for (const r of rows) {
      const p = priorBaseline[r.fx]
      if (!p) continue
      const pr = tierRank[p.verdict] ?? 0
      const rr = tierRank[r.verdict] ?? 0
      if (rr < pr) {
        console.log(`  ✗ regression: ${r.fx} ${p.verdict} → ${r.verdict}`)
        regressed++
      } else if (rr > pr) {
        console.log(`  ✓ improvement: ${r.fx} ${p.verdict} → ${r.verdict}`)
        improved++
      }
      if (p.score !== null && p.score !== undefined && r.score !== null) {
        const d = r.score - p.score
        if (Math.abs(d) >= 5) {
          const tag = d < 0 ? '✗ score drop' : '✓ score rise'
          console.log(`  ${tag}: ${r.fx} ${p.score.toFixed(1)} → ${r.score.toFixed(1)} (Δ ${d >= 0 ? '+' : ''}${d.toFixed(1)})`)
        }
        scoreDelta += d
        scoreCompared++
      }
    }
    if (scoreCompared > 0) {
      console.log(`  Mean score Δ: ${scoreDelta >= 0 ? '+' : ''}${(scoreDelta / scoreCompared).toFixed(2)} across ${scoreCompared} FX`)
    }
    console.log(`  ${regressed} regressed · ${improved} improved`)
    if (regressed > 0) process.exitCode = 1
  }

  if (counts.FAIL > 0) process.exitCode = process.exitCode ?? 1
}

interface BaselineEntry {
  verdict: Verdict
  score: number | null
  rmsRatio: number | null
  peakRatio: number | null
  l2MelDb: number | null
  mfccDist: number | null
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
