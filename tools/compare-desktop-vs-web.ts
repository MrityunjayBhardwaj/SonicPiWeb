/**
 * A/B comparator — runs the same Sonic Pi snippet through BOTH desktop
 * Sonic Pi.app (via tools/capture-desktop.ts) and the SonicPi.js browser app
 * (via tools/capture.ts), then writes a side-by-side stats report.
 *
 * Useful for parity verification: "does our engine produce the same audio
 * shape as Desktop SP for this snippet?" — the desktop side is the canonical
 * reference (audio WAV is the gold standard for observation; the event log
 * is inference about what should happen, not observation of what did).
 *
 * Prereqs (BOTH must hold):
 *   1. Sonic Pi.app must be running (`open -a "Sonic Pi"` and wait ~10s).
 *   2. The browser dev server must be running (`npm run dev` on :5173).
 *
 * Usage:
 *   npx tsx tools/compare-desktop-vs-web.ts                          # default snippet
 *   npx tsx tools/compare-desktop-vs-web.ts "play 60; sleep 1"        # inline
 *   npx tsx tools/compare-desktop-vs-web.ts --file path/to/code.rb    # from file
 *   npx tsx tools/compare-desktop-vs-web.ts --file foo.rb --duration 12000
 *
 * Per-beat windowed analysis (opt-in for rhythmic content):
 *   npx tsx tools/compare-desktop-vs-web.ts --file beat.rb --bpm 120 --beats 16
 *   # → slices both WAVs into 16 windows of 0.5s each, computes per-beat
 *   #   RMS / peak / MFCC distance, identifies most-divergent beats, and
 *   #   emits a per-beat bar-chart PNG alongside the spectrogram.
 *
 * Output:
 *   .captures/compare_<ts>_<name>.md  — side-by-side stats + verdict
 *   .captures/desktop-recordings/...wav and .captures/...wav (the source WAVs)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const DEFAULT_DURATION = 8000

// ---------------------------------------------------------------------------
// Spawn helper — collect stdout, return when child exits
// ---------------------------------------------------------------------------

interface ChildResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runChild(cmd: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd: resolve(__dirname, '..') })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('error', rejectP)
    child.on('close', (code) => {
      resolveP({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// WAV stats — same impl as capture.ts and capture-desktop.ts
// ---------------------------------------------------------------------------

interface AudioStats {
  duration: number
  peak: number
  rms: number
  clipping: number
  sampleRate: number
  channels: number
}

function analyzeWav(path: string): AudioStats | null {
  try {
    const buf = readFileSync(path)
    const sampleRate = buf.readUInt32LE(24)
    const bitsPerSample = buf.readUInt16LE(34)
    const channels = buf.readUInt16LE(22)
    const dataOffset = 44
    const bytesPerSample = bitsPerSample / 8
    const numSamples = Math.floor((buf.length - dataOffset) / (channels * bytesPerSample))
    let sumSq = 0
    let peak = 0
    let clipCount = 0
    for (let i = 0; i < numSamples; i++) {
      const off = dataOffset + i * channels * bytesPerSample
      const val = buf.readInt16LE(off) / 32768.0
      sumSq += val * val
      const a = Math.abs(val)
      if (a > peak) peak = a
      if (a > 0.95) clipCount++
    }
    const rms = Math.sqrt(sumSq / numSamples)
    return {
      duration: numSamples / sampleRate,
      peak: Math.round(peak * 10000) / 10000,
      rms: Math.round(rms * 10000) / 10000,
      clipping: Math.round((clipCount / numSamples) * 10000) / 100,
      sampleRate,
      channels,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// WAV path discovery — parse the child tools' stdout
// ---------------------------------------------------------------------------

function findWavPath(stdout: string, regex: RegExp): string | null {
  const m = stdout.match(regex)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

interface PerBeatRow {
  beat: number
  desktop_rms: number
  web_rms: number
  desktop_peak: number
  web_peak: number
  mfcc_distance: number | null
}

interface PerBeatMetrics {
  bpm: number
  beats: number
  rows: PerBeatRow[]
  most_divergent_beats: number[]
  mean_per_beat_mfcc_distance: number
  per_beat_png: string
}

interface SpectrogramMetrics {
  l2_mel_db: number
  mfcc_distance: number
  frames_compared: number
  spectrogram_png: string
  desktop_peak_freq_hz: number
  web_peak_freq_hz: number
  per_beat: PerBeatMetrics | null
}

interface PitchTrack {
  count: number
  median_spacing_s: number
  midi: (number | null)[]
  pc: (number | null)[]
  names: (string | null)[]
  method: string
  confidence: number
  inconclusive: boolean
  compare: 'midi' | 'pitch_class'
}

interface ComparisonResult {
  timestamp: string
  code: string
  duration: number
  name: string
  desktop: { wavPath: string | null; stats: AudioStats | null; rawStdout: string; ok: boolean; pitch: PitchTrack | null }
  web:     { wavPath: string | null; stats: AudioStats | null; rawStdout: string; ok: boolean; pitch: PitchTrack | null }
  spectrogram: SpectrogramMetrics | null
  spectrogramError: string | null
  reportPath: string
}

function writeComparisonReport(r: ComparisonResult): void {
  const lines: string[] = []
  lines.push(`# Desktop ↔ Web Comparison: ${r.name}`)
  lines.push('')
  lines.push(`- **Timestamp:** ${r.timestamp}`)
  lines.push(`- **Capture window:** ${r.duration} ms`)
  lines.push('')

  lines.push('## Code')
  lines.push('```ruby')
  lines.push(r.code.trim())
  lines.push('```')
  lines.push('')

  lines.push('## Stats (Level 3 — observation, not inference)')
  lines.push('')
  lines.push('| Metric        | Desktop SP             | SonicPi.js (web)        | Δ (desk − web) |')
  lines.push('|---------------|------------------------|-------------------------|----------------|')

  const fmt = (v: number | undefined, digits = 4) =>
    v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits)

  const dStats = r.desktop.stats
  const wStats = r.web.stats

  const row = (
    label: string,
    pickD: (s: AudioStats) => number,
    pickW: (s: AudioStats) => number,
    digits = 4,
  ) => {
    const dv = dStats ? pickD(dStats) : undefined
    const wv = wStats ? pickW(wStats) : undefined
    const delta = dv !== undefined && wv !== undefined ? dv - wv : undefined
    lines.push(`| ${label} | ${fmt(dv, digits)} | ${fmt(wv, digits)} | ${fmt(delta, digits)} |`)
  }

  row('Duration (s)', s => s.duration, s => s.duration, 3)
  row('Peak',         s => s.peak,     s => s.peak)
  row('RMS',          s => s.rms,      s => s.rms)
  row('Clipping (%)', s => s.clipping, s => s.clipping, 2)
  lines.push(`| Sample rate (Hz) | ${dStats?.sampleRate ?? '—'} | ${wStats?.sampleRate ?? '—'} | ${
    dStats && wStats ? dStats.sampleRate - wStats.sampleRate : '—'
  } |`)
  lines.push(`| Channels | ${dStats?.channels ?? '—'} | ${wStats?.channels ?? '—'} | — |`)
  lines.push('')

  // ── 6-Tier Audio Analysis Standard (issue #346, vyapti SV46) ───────────────
  // Tier 0 = validity gates (fail ⇒ INVALID, no verdict). Tier 1 = musical
  // correctness = THE verdict. Tiers 2–3 supporting, may NEVER override Tier 1
  // (SP93). Tiers the comparator can't compute print "not analysed" explicitly.

  // Tier 0 — Validity gates. Two severities:
  //  • HARD (invalid): makes the pitch sequence itself unreliable → no Tier-1
  //    verdict possible (missing WAV, SR mismatch needing resample).
  //  • SOFT (aggregatesUnreliable): only invalidates COUNTS & AGGREGATES
  //    (Tier 3 ratios, onset count). Tier 1 pitch-track is prefix-compared and
  //    robust to window misalignment by construction — it must NOT be nuked by
  //    a duration delta (that delta is intrinsic: scsynth warm-up + reverb
  //    tail). Over-blocking here would flag correct PITCH-MATCH runs as
  //    INVALID and train readers to ignore the gate.
  const t0: string[] = []
  let invalid = false
  let aggregatesUnreliable = false
  const fail = (m: string) => { t0.push(`- ✗ ${m}  **(HARD — verdict INVALID)**`); invalid = true }
  const soft = (m: string) => { t0.push(`- ⚠ ${m}  **(SOFT — Tier 3 + 1.3 unreliable; Tier 1 pitch still valid)**`); aggregatesUnreliable = true }
  const passG = (m: string) => t0.push(`- ✓ ${m}`)
  if (!dStats) fail('Desktop produced no WAV — see desktop tool stdout below')
  if (!wStats) fail('Web produced no WAV — see web tool stdout below')
  let durDelta = 0
  if (dStats && wStats) {
    if (dStats.sampleRate !== wStats.sampleRate)
      fail(`0.1 Sample-rate mismatch (${dStats.sampleRate} vs ${wStats.sampleRate} Hz) — SV29: cross-SR compare invalid`)
    else passG(`0.1 Sample rate consistent (${dStats.sampleRate} Hz)`)
    durDelta = Math.abs(dStats.duration - wStats.duration)
    if (durDelta > 0.5)
      soft(`0.2 Capture-window misaligned (Δ ${durDelta.toFixed(2)}s > 0.5s) — note-count / level aggregates unreliable`)
    else passG(`0.2 Capture windows aligned (Δ ${durDelta.toFixed(2)}s)`)
  }
  t0.push('- ◦ 0.3 equal preconditions / 0.4 lossless capture / 0.5 routing sanity — not auto-checked; ensure SP.app reset + raw-float32 + FX-bus wired (SV31/SV27/SV30)')

  // Tier 1 — Musical correctness (THE verdict)
  const dp = r.desktop.pitch, wp = r.web.pitch
  const t1: string[] = []
  let pitchVerdict = 'not analysed'
  if (dp && wp) {
    // #348: cheap contour is octave-unstable → compare pitch CLASSES when
    // either side used contour mode (octave error cancels). Exact MIDI only
    // when both sides are onset-tracked.
    const pcMode = dp.compare === 'pitch_class' || wp.compare === 'pitch_class'
    const dSeq = (pcMode ? dp.pc : dp.midi).filter(x => x !== null) as number[]
    const wSeq = (pcMode ? wp.pc : wp.midi).filter(x => x !== null) as number[]
    const unit = pcMode ? 'pitch-classes (octave-invariant — contour mode)' : 'notes'
    const n = Math.min(dSeq.length, wSeq.length)
    let mismatch = -1
    for (let i = 0; i < n; i++) if (dSeq[i] !== wSeq[i]) { mismatch = i; break }
    const inconc = dp.inconclusive || wp.inconclusive
    if (inconc) pitchVerdict = `⚠ INCONCLUSIVE — contour-low confidence (desktop ${dp.method}/${dp.confidence}, web ${wp.method}/${wp.confidence}); sustained/noisy material, no Tier-1 verdict`
    else if (n === 0) pitchVerdict = '⚠ no notes detected on one/both sides'
    else if (mismatch < 0) pitchVerdict = `✓ PITCH-MATCH — ${unit} identical over ${n}`
    else pitchVerdict = `✗ PITCH DIVERGENCE at ${pcMode ? 'pc' : 'note'} ${mismatch} (desktop ${dSeq[mismatch]} vs web ${wSeq[mismatch]})`
    const dt = dp.median_spacing_s, wt = wp.median_spacing_s
    const tempoOk = dt > 0 && Math.abs(dt - wt) / dt < 0.1
    t1.push(`- **1.1 Note progression:** ${pitchVerdict}`)
    t1.push(`  - method: desktop \`${dp.method}\` (conf ${dp.confidence}) · web \`${wp.method}\` (conf ${wp.confidence})${pcMode ? ' · compared octave-invariant' : ''}`)
    t1.push(`  - desktop: \`${(pcMode ? dp.pc : dp.midi).slice(0, 24).join(',')}\``)
    t1.push(`  - web&nbsp;&nbsp;&nbsp;: \`${(pcMode ? wp.pc : wp.midi).slice(0, 24).join(',')}\``)
    t1.push(`- **1.2 Tempo (inter-onset):** ${tempoOk ? '✓' : '✗'} desktop ${dt.toFixed(3)}s · web ${wt.toFixed(3)}s/note`)
    t1.push(`- **1.3 Onset count:** desktop ${dp.count} · web ${wp.count}${durDelta > 0.5 ? ' (Δ explained by Tier-0 window misalignment)' : ''}`)
    t1.push('- ◦ 1.4 note duration / 1.5 polyphony / 1.6 determinism — not auto-tracked here (unit tests cover determinism; see SV24/SV45)')
  } else {
    t1.push(`- ⚠ pitch-track unavailable (desktop=${dp ? 'ok' : 'none'}, web=${wp ? 'ok' : 'none'}) — Tier 1 verdict cannot be formed`)
  }

  // Headline verdict
  const softNote = aggregatesUnreliable ? '  · ⚠ Tier-0 SOFT: level/count aggregates unreliable (Tier 1 pitch unaffected)' : ''
  lines.push('## Verdict')
  if (invalid) {
    lines.push(`### ❌ INVALID — Tier 0 HARD gate failed. The pitch sequence itself is unreliable; no verdict until fixed.`)
  } else if (pitchVerdict.startsWith('✓')) {
    lines.push(`### ✅ Tier 1 ${pitchVerdict}  (the musical-correctness verdict)${softNote}`)
  } else if (pitchVerdict.startsWith('✗')) {
    lines.push(`### ❌ Tier 1 ${pitchVerdict}  (musical correctness FAILED — Tier 2/3 cannot override this)`)
  } else {
    lines.push(`### ⚠ Tier 1 inconclusive — ${pitchVerdict}${softNote}`)
  }
  lines.push('')
  lines.push('### Tier 0 — Validity gates')
  for (const v of t0) lines.push(v)
  lines.push('')
  lines.push('### Tier 1 — Musical correctness (THE verdict — energy/MFCC may never override)')
  for (const v of t1) lines.push(v)
  lines.push('')
  lines.push('### Tier 3 — Level / gain (reported; NOT a musical-correctness blocker — known ~0.5× web gain-staging)')
  if (aggregatesUnreliable) lines.push('> ⚠ Tier-0 SOFT failed — these ratios span misaligned windows; treat as indicative only.')
  if (dStats && wStats) {
    const rmsRatio = dStats.rms > 0 ? wStats.rms / dStats.rms : 0
    const peakRatio = dStats.peak > 0 ? wStats.peak / dStats.peak : 0
    lines.push(`- 3.1 RMS ratio web/desktop = ${rmsRatio.toFixed(2)}× ${rmsRatio >= 0.5 && rmsRatio <= 2 ? '(within 0.5–2× band)' : '(outside band — tracked separately, not a Tier-1 fail)'}`)
    lines.push(`- 3.2 Peak ratio web/desktop = ${peakRatio.toFixed(2)}×`)
    lines.push(`- 3.3 Clipping: desktop ${dStats.clipping}% · web ${wStats.clipping}% ${(dStats.clipping > 1 || wStats.clipping > 1) ? '⚠' : '✓ (< 1%)'}`)
  } else {
    lines.push('- not analysed (WAV missing)')
  }
  lines.push('')
  lines.push('### Tier 2 — Spectral / timbral (supporting only) · Tier 4 — FX/routing · Tier 5 — lifecycle')
  lines.push('- Tier 2: see **Spectrogram comparison** section below (MFCC carries its mandatory caveat there).')
  lines.push('- Tier 4 (FX accumulation/suppression 200ms scan, per-FX-scope energy): **not analysed** by this tool — use the FX-sweep / boundary-scan tools when FX is in scope.')
  lines.push('- Tier 5 (Run/Stop/hot-swap, cold-start, long-run drift): **not analysed** — single capture; use `tools/test-run-stop-cycle.ts` for lifecycle.')
  lines.push('')

  lines.push('## Source WAVs')
  lines.push(`- **Desktop:** ${r.desktop.wavPath ?? '_(not produced)_'}`)
  lines.push(`- **Web:** ${r.web.wavPath ?? '_(not produced)_'}`)
  lines.push('')

  lines.push('## Spectrogram comparison')
  if (r.spectrogram) {
    const sp = r.spectrogram
    lines.push(`![spectrogram comparison](${sp.spectrogram_png})`)
    lines.push('')
    lines.push('| Metric | Value | Reading |')
    lines.push('|---|---|---|')
    lines.push(`| L2 distance (mel-dB) | ${sp.l2_mel_db.toFixed(2)} | < 10 = very close · 10–25 = similar shape · > 25 = divergent |`)
    lines.push(`| MFCC distance (timbre) | ${sp.mfcc_distance.toFixed(2)} | < 30 = similar · 30–80 = noticeably different · > 80 = unrelated |`)
    lines.push(`| ↳ MFCC caveat | — | **Tier-2 supporting only.** Confounded by the known ~0.5× web gain ratio + desktop reverb-tail length; **never overrides Tier 1** (SP93). A high MFCC with a Tier-1 PITCH-MATCH means timbre/gain, not wrong notes. |`)
    lines.push(`| Frames compared | ${sp.frames_compared} | overlapping window after length-aligning |`)
    lines.push(`| Peak freq desktop | ${sp.desktop_peak_freq_hz.toFixed(1)} Hz | dominant frequency |`)
    lines.push(`| Peak freq web | ${sp.web_peak_freq_hz.toFixed(1)} Hz | dominant frequency |`)
    if (sp.l2_mel_db > 25) {
      lines.push('')
      lines.push(`⚠ Spectral L2 ${sp.l2_mel_db.toFixed(2)} indicates divergent spectral content — inspect the diff panel of the PNG above.`)
    }
    if (sp.mfcc_distance > 80) {
      lines.push(`⚠ MFCC distance ${sp.mfcc_distance.toFixed(2)} is high — **check Tier 1 first**: if pitch-track matched, this is timbre/gain (the known 0.5× + reverb tail), NOT wrong notes. Only treat as "different synth/sample chain" when Tier 1 also diverges.`)
    }

    if (sp.per_beat) {
      const pb = sp.per_beat
      lines.push('')
      lines.push(`### Per-beat (bpm=${pb.bpm}, ${pb.beats} beats)`)
      lines.push('')
      lines.push(`![per-beat comparison](${pb.per_beat_png})`)
      lines.push('')
      lines.push('| Beat | Desktop RMS | Web RMS | RMS Δ | MFCC dist |')
      lines.push('|---|---|---|---|---|')
      for (const row of pb.rows) {
        const delta = row.desktop_rms - row.web_rms
        const mfcc = row.mfcc_distance === null ? '—' : row.mfcc_distance.toFixed(1)
        lines.push(`| ${row.beat} | ${row.desktop_rms.toFixed(4)} | ${row.web_rms.toFixed(4)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} | ${mfcc} |`)
      }
      lines.push('')
      lines.push(`- **Mean per-beat MFCC distance:** ${pb.mean_per_beat_mfcc_distance.toFixed(2)}`)
      lines.push(`- **Most divergent beats (top 3):** ${pb.most_divergent_beats.join(', ') || '—'}`)
      const silentDesktop = pb.rows.filter(r => r.desktop_rms < 0.001).map(r => r.beat)
      const silentWeb = pb.rows.filter(r => r.web_rms < 0.001).map(r => r.beat)
      if (silentDesktop.length !== silentWeb.length) {
        lines.push(`- ⚠ **Silent-beat asymmetry:** desktop silent on beats ${silentDesktop.join(',') || '(none)'} · web silent on beats ${silentWeb.join(',') || '(none)'} — likely a missed trigger on one side`)
      }
    }
  } else if (r.spectrogramError) {
    lines.push(`_Spectrogram analysis failed: ${r.spectrogramError}_`)
  } else {
    lines.push('_Spectrogram analysis skipped — both WAVs required._')
  }
  lines.push('')

  lines.push('## Tool stdout (debug)')
  lines.push('### Desktop')
  lines.push('```')
  lines.push(r.desktop.rawStdout.trim())
  lines.push('```')
  lines.push('### Web')
  lines.push('```')
  lines.push(r.web.rawStdout.trim())
  lines.push('```')

  writeFileSync(r.reportPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

interface CliArgs {
  code: string
  duration: number
  name: string
  bpm: number | null   // null → no per-beat analysis
  beats: number | null
  jsonOut: string | null // --json-out: write a sidecar JSON for programmatic consumers
}

function parseArgs(argv: string[]): CliArgs {
  let duration = DEFAULT_DURATION
  let name = 'inline'
  let code = `play 60\nsleep 1\nplay 67\nsleep 1\nplay 72\nsleep 1`
  let bpm: number | null = null
  let beats: number | null = null
  let jsonOut: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--duration') duration = parseInt(argv[++i], 10)
    else if (a === '--name') name = argv[++i]
    else if (a === '--bpm') bpm = parseFloat(argv[++i])
    else if (a === '--beats') beats = parseInt(argv[++i], 10)
    else if (a === '--json-out') jsonOut = argv[++i]
    else if (a === '--file') {
      const path = argv[++i]
      code = readFileSync(path, 'utf8')
      name = basename(path).replace(/\.[^.]+$/, '')
    } else if (!a.startsWith('--')) {
      code = a
    }
  }
  // Per-beat fires only when --beats is given. If --bpm omitted, default to 60
  // (Sonic Pi default; matches the Python script's default).
  if (beats !== null && bpm === null) bpm = 60
  return { code, duration, name, bpm, beats, jsonOut }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`▶ A/B comparison (${args.duration}ms): ${args.name}`)
  console.log(`  Running desktop + web in parallel...`)

  mkdirSync(CAPTURES_DIR, { recursive: true })

  // Desktop tool accepts --name; web tool (capture.ts) does not — it picks the
  // name from --file basename or defaults to "inline" for raw code. So we
  // pass --name only to the desktop side and locate the web report via the
  // "Capture saved: <path>" line printed by capture.ts.
  //
  // Recording-mechanism parity (issue #266): desktop wraps user code with
  // recording_start/stop internally (capture-desktop.ts:202). To match its
  // DSL clock semantics on web, pass --wrap-recording to capture.ts so it
  // takes the codeDrivesRecording branch instead of the UI Rec button path.
  // Both sides now record from user-code t=0 to user-code t=duration.
  const durationSec = args.duration / 1000.0
  const desktopArgs = [args.code, '--duration', String(args.duration), '--name', args.name]
  const webArgs     = [args.code, '--duration', String(args.duration), '--wrap-recording', String(durationSec)]

  const [desktop, web] = await Promise.all([
    runChild('npx', ['tsx', 'tools/capture-desktop.ts', ...desktopArgs]),
    runChild('npx', ['tsx', 'tools/capture.ts', ...webArgs]),
  ])

  // capture-desktop.ts prints: "✓ WAV:    <abs-path>"
  const desktopWav = findWavPath(desktop.stdout, /✓ WAV:\s+(\S+\.wav)/)
  // capture.ts prints: "Capture saved: <abs-path-to-md>". Read that md and
  // grep for the **File:** line (the audio path inside the report).
  let webWav: string | null = null
  const webReportMatch = web.stdout.match(/Capture saved:\s+(\S+\.md)/)
  if (webReportMatch && existsSync(webReportMatch[1])) {
    const md = readFileSync(webReportMatch[1], 'utf8')
    const m = md.match(/\*\*File:\*\*\s+`([^`]+\.wav)`/)
    if (m) webWav = m[1]
  }

  const desktopStats = desktopWav ? analyzeWav(desktopWav) : null
  const webStats = webWav ? analyzeWav(webWav) : null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = resolve(CAPTURES_DIR, `compare_${ts}_${args.name}.md`)

  // Spectrogram + MFCC analysis via Python (librosa). Only if both WAVs exist.
  let spectrogram: SpectrogramMetrics | null = null
  let spectrogramError: string | null = null
  if (desktopWav && webWav) {
    const specOutPrefix = resolve(CAPTURES_DIR, `compare_${ts}_${args.name}_spectrogram`)
    const pyArgs = ['tools/spectrogram-compare.py', desktopWav, webWav, specOutPrefix]
    if (args.beats !== null && args.bpm !== null) {
      pyArgs.push('--bpm', String(args.bpm), '--beats', String(args.beats))
    }
    try {
      const py = await runChild('python3', pyArgs)
      if (py.exitCode === 0) {
        const jsonPath = `${specOutPrefix}.json`
        if (existsSync(jsonPath)) {
          const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
          spectrogram = {
            l2_mel_db: data.comparison.l2_mel_db,
            mfcc_distance: data.comparison.mfcc_distance,
            frames_compared: data.comparison.frames_compared,
            spectrogram_png: data.comparison.spectrogram_png,
            desktop_peak_freq_hz: data.desktop.peak_freq_hz,
            web_peak_freq_hz: data.web.peak_freq_hz,
            per_beat: data.per_beat ?? null,
          }
        }
      } else {
        spectrogramError = py.stderr.trim() || `python3 exited ${py.exitCode}`
      }
    } catch (err) {
      spectrogramError = err instanceof Error ? err.message : String(err)
    }
  }

  // Tier 1 — pitch-track (the musical-correctness verdict). Run for each WAV
  // independently so a missing one still yields the other's sequence.
  const runPitch = async (wav: string | null): Promise<PitchTrack | null> => {
    if (!wav) return null
    try {
      const pArgs = ['tools/pitchtrack.py', '--json']
      if (args.bpm !== null) pArgs.push('--bpm', String(args.bpm))
      pArgs.push(wav)
      const py = await runChild('python3', pArgs)
      if (py.exitCode !== 0) return null
      const d = JSON.parse(py.stdout.trim().split('\n').pop() as string)
      return {
        count: d.count, median_spacing_s: d.median_spacing_s,
        midi: d.midi, pc: d.pc, names: d.names,
        method: d.method, confidence: d.confidence,
        inconclusive: d.inconclusive, compare: d.compare,
      }
    } catch { return null }
  }
  const [desktopPitch, webPitch] = await Promise.all([runPitch(desktopWav), runPitch(webWav)])

  const result: ComparisonResult = {
    timestamp: new Date().toISOString(),
    code: args.code,
    duration: args.duration,
    name: args.name,
    desktop: { wavPath: desktopWav, stats: desktopStats, rawStdout: desktop.stdout, ok: desktop.exitCode === 0, pitch: desktopPitch },
    web:     { wavPath: webWav,     stats: webStats,     rawStdout: web.stdout,     ok: web.exitCode === 0, pitch: webPitch },
    spectrogram,
    spectrogramError,
    reportPath,
  }
  writeComparisonReport(result)

  if (args.jsonOut) {
    // Strip rawStdout to keep the JSON small for programmatic consumers
    // (the markdown report already preserves the full stdout for debugging).
    const jsonResult = {
      ...result,
      desktop: { ...result.desktop, rawStdout: undefined },
      web:     { ...result.web,     rawStdout: undefined },
    }
    writeFileSync(args.jsonOut, JSON.stringify(jsonResult, null, 2))
  }

  console.log(`\n✓ Comparison report: ${reportPath}`)
  if (desktopStats && webStats) {
    const rmsRatio = desktopStats.rms > 0 ? webStats.rms / desktopStats.rms : 0
    const peakRatio = desktopStats.peak > 0 ? webStats.peak / desktopStats.peak : 0
    console.log(`  Desktop: peak ${desktopStats.peak} · RMS ${desktopStats.rms} · ${desktopStats.duration.toFixed(2)}s @ ${desktopStats.sampleRate}Hz`)
    console.log(`  Web:     peak ${webStats.peak} · RMS ${webStats.rms} · ${webStats.duration.toFixed(2)}s @ ${webStats.sampleRate}Hz`)
    console.log(`  Ratios:  peak ${peakRatio.toFixed(2)}× · RMS ${rmsRatio.toFixed(2)}× (web/desktop)`)
    if (spectrogram) {
      console.log(`  Spec:    L2(mel-dB)=${spectrogram.l2_mel_db.toFixed(2)} · MFCC dist=${spectrogram.mfcc_distance.toFixed(2)}`)
      console.log(`  PNG:     ${spectrogram.spectrogram_png}`)
      if (spectrogram.per_beat) {
        const pb = spectrogram.per_beat
        console.log(`  Per-beat: mean MFCC ${pb.mean_per_beat_mfcc_distance.toFixed(2)} · most divergent beats: ${pb.most_divergent_beats.join(', ')}`)
        console.log(`  PNG:      ${pb.per_beat_png}`)
      }
    } else if (spectrogramError) {
      console.log(`  ⚠ Spectrogram analysis failed: ${spectrogramError}`)
    }
  } else {
    console.log(`  ⚠ One or both sides produced no WAV — see report for stdout`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
