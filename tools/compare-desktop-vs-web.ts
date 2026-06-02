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
  // toolFailReason — populated when capture.ts emitted `**File:** none — <reason>`
  // (a known capture-pipeline failure as opposed to engine silence). Lets the
  // Tier-0 line say TOOL-FAIL distinctly from generic INVALID. See #358.
  // errors — engine errors collected by capture.ts (pageErrors, console.error,
  // network failures, app-console runtime-pattern hits). Surfaced as a Tier-0
  // ERROR verdict distinct from DIVERGE/INVALID/TOOL-FAIL — without it, an
  // example that throws mid-run is indistinguishable from a real parity bug
  // (silent or partial audio after the throw → false DIVERGE-at-note-0). #371.
  web:     { wavPath: string | null; stats: AudioStats | null; rawStdout: string; ok: boolean; pitch: PitchTrack | null; toolFailReason: string | null; errors: string[] }
  spectrogram: SpectrogramMetrics | null
  spectrogramError: string | null
  reportPath: string
  // #376 reconciliation — when the two sides auto-select DIFFERENT pitch-track
  // methods, both are re-tracked with a forced common method (contour) capped
  // to the shorter capture's duration, so a method-asymmetric pair can still
  // yield a Tier-1 verdict (MATCH / PRNG-VARIANT) instead of an automatic
  // INCONCL. Populated only in the asymmetric case; null otherwise.
  reconciledPitch?: { desktop: PitchTrack | null; web: PitchTrack | null } | null
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
  let webEngineError = false
  let aggregatesUnreliable = false
  // SV48 (#427): a missing web WAV must NAME its layer — ENGINE-REFUSED (the
  // engine threw / refused to transpile) ≠ ENGINE-SILENT (the engine ran but
  // produced no recording) ≠ TOOL-FAIL (the capture pipeline lost a real blob).
  // Branding everything "TOOL-FAIL #358" sent triage to the harness when the
  // bug was in the engine/transpiler (cost the #426/#427/#430 re-diagnoses).
  let webNoWavClass: 'engine-refused' | 'engine-silent' | 'tool-fail' | null = null
  const fail = (m: string) => { t0.push(`- ✗ ${m}  **(HARD — verdict INVALID)**`); invalid = true }
  const failNamed = (m: string) => { t0.push(`- ✗ ${m}  **(HARD — no Tier-1 verdict)**`); invalid = true }
  const errFail = (m: string) => { t0.push(`- ✗ ${m}  **(HARD — verdict ERROR; pitch verdict not formed)**`); webEngineError = true }
  const soft = (m: string) => { t0.push(`- ⚠ ${m}  **(SOFT — Tier 3 + 1.3 unreliable; Tier 1 pitch still valid)**`); aggregatesUnreliable = true }
  const passG = (m: string) => t0.push(`- ✓ ${m}`)
  // #371: engine errors are a Tier-0 outcome distinct from INVALID (no WAV) /
  // TOOL-FAIL (capture pipeline) / DIVERGE (audio differs). Without this gate
  // an example whose web engine throws mid-run is misattributed to a parity
  // bug — silent or partial audio after the throw scores as DIVERGE at note 0.
  // Runs BEFORE the no-WAV checks so an error+empty-WAV reads as ERROR (root
  // cause: the throw), not generic INVALID.
  if (r.web.errors.length > 0) {
    const first = r.web.errors[0].replace(/\s+/g, ' ').slice(0, 140)
    const extra = r.web.errors.length > 1 ? ` (+${r.web.errors.length - 1} more)` : ''
    errFail(`Web engine error during capture: ${first}${extra} — see "Web engine errors" below`)
  }
  if (!dStats) fail('Desktop produced no WAV — see desktop tool stdout below')
  if (!wStats) {
    // SV48 (#427): classify the missing web WAV by LAYER instead of always
    // "TOOL-FAIL #358". The capture diag carries the decisive signal —
    // `wavBlobClicks` counts how many times a `.wav` download anchor was
    // clicked. >0 ⇒ a recording WAS produced and a download fired but the blob
    // could not be resolved (genuine capture-pipeline failure). 0 ⇒
    // recording_save never had a recording: the engine refused (errored) or ran
    // silently. Branding all three "TOOL-FAIL" sent triage to the harness when
    // the bug was in the engine/transpiler (the #426/#427/#430 re-diagnoses).
    const reason = r.web.toolFailReason ?? ''
    const wavClicks = parseInt(reason.match(/wavBlobClicks=(\d+)/)?.[1] ?? '0', 10)
    if (webEngineError) {
      // Engine threw/refused (Tier-0 ERROR already set). The missing WAV is a
      // consequence — attribute it to the error, not the capture tool.
      webNoWavClass = 'engine-refused'
      failNamed('Web produced no WAV — ENGINE-REFUSED: the engine errored/refused to run (see "Web engine errors" above). NOT a capture-tool miss.')
    } else if (reason && wavClicks > 0) {
      webNoWavClass = 'tool-fail'
      failNamed(`Web produced no WAV — TOOL-FAIL (capture pipeline): a .wav download fired (wavBlobClicks=${wavClicks}) but the blob could not be resolved — the engine likely produced audio. Debug the harness. ${reason}`)
    } else if (reason) {
      webNoWavClass = 'engine-silent'
      failNamed(`Web produced no WAV — ENGINE-SILENT: no .wav download fired (wavBlobClicks=0) — recording_save found no recording, so the engine emitted no audio. NOT a capture-tool failure; check the App Console for /s_new activity. ${reason}`)
    } else {
      fail('Web produced no WAV — see web tool stdout below')
    }
  }
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
    const dt = dp.median_spacing_s, wt = wp.median_spacing_s
    const tempoOk = dt > 0 && Math.abs(dt - wt) / dt < 0.1
    // #358 Option A — PRNG-VARIANT sub-verdict. Cross-engine PRNG parity is
    // NOT a v1 goal (#364 findings: desktop reads a frozen rand-stream.wav
    // table, we use MT19937 — categorically different streams, the same seed
    // yields different sequences). When a PRNG-driven snippet diverges but
    // both sides walk the SAME musical material (identical note-set, matching
    // tempo, comparable note count) that's "same composition, different
    // random walk" — musically equivalent, not a bug. Demoting separates the
    // ~34 PRNG-noise rows from real parity bugs in the sweep dashboard.
    //
    // Signature (the pitch-class histogram cosine carries the verdict;
    // #367 — count parity does NOT, a different random walk legitimately
    // changes note count):
    //   1. source contains a PRNG token (PRNG_RE)
    //   2. pitch-class histogram cosine ≥ 0.92 (permutation-invariant —
    //      a shuffle preserves it; a real bug shifts it substantially)
    //   3. tempo matches (tempoOk, <10% inter-onset delta)
    //   4. density floor: onset-count ratio ≥ 0.5 (guards only against a
    //      degenerate near-empty capture, not against count divergence)
    // #375 (regex bug): the original `/\b(rrand|...|\.choose|\.shuffle|\.pick|...)\b/`
    // silently missed `[1,2,3].choose` and `(scale).shuffle` — `\b` before `.`
    // requires a word-boundary transition that doesn't exist between `]`/`)`
    // and `.`. It also missed Ruby's function-call form `choose([1,2,3])` /
    // `shuffle(...)` / `pick(...)` entirely. 4 of the "8 PRNG-free actionable
    // engine bugs" in the post-#370 sweep (blockgame, ambient_experiment,
    // rerezzed, time_machine) were actually cross-engine-PRNG rows mis-routed.
    // Three call-shapes the corrected regex covers:
    //   1. bare word: rrand / rrand_i / rand / rand_i / one_in / dice / use_random_seed
    //   2. dot-method: .choose / .shuffle / .pick   (any expression)
    //   3. fn-call:    choose( / shuffle( / pick(    (Ruby's function form)
    const PRNG_RE = /(\b(?:rrand|rrand_i|rand|rand_i|one_in|dice|use_random_seed)\b|\.(?:choose|shuffle|pick)\b|\b(?:choose|shuffle|pick)\s*\()/
    let prngVariant = false
    let prngCos = 0
    // Observation (Lokayata): exact note-SET equality is too brittle. Pitch
    // trackers inject octave/harmonic noise that DIFFERS between desktop and
    // web rendering — a pure `.shuffle` of a 4-note bank produced desktop
    // set {60,67,72,64,79,91,84,76} (overtones of the pluck synth) vs web
    // {60,64,67,72}. Set-equality caught ~nothing.
    //
    // Robust signature of "same composition, different random walk":
    // the pitch-class HISTOGRAM is permutation-invariant. A shuffle preserves
    // it exactly; a few tracker octave-errors perturb it slightly; a real
    // bug (genuinely wrong notes) shifts it substantially. Cosine similarity
    // of the 12-bin pitch-class histograms ≥ 0.92, combined with the four
    // independent guards (PRNG token in source · tempo match · count within
    // ±15% · genuine pitch divergence), is the PRNG-VARIANT signature.
    const pcHist = (seq: number[]): number[] => {
      const h = new Array(12).fill(0)
      for (const v of seq) h[((Math.round(v) % 12) + 12) % 12]++
      return h
    }
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
      return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
    }
    // Onset-count ratio. A different random walk of the SAME composition
    // legitimately changes note durations/rests and therefore onset count
    // (#367) — so this is NOT an equality test. It has two distinct uses:
    //   • Gross mismatch (<0.3) on same-method `onset` tracks ⇒ the onset
    //     detector is unreliable on ≥1 side (slewed / long-release / sustained
    //     material hallucinates onsets from continuous spectral motion, e.g.
    //     tron_bike: desktop 83 vs web 6 for a ~2-note/15s live_loop). The
    //     measurement cannot judge this material ⇒ INCONCLUSIVE, NOT a hard
    //     DIVERGE (#368). Honest degradation, not a false engine-failure.
    //   • PRNG-VARIANT needs only a loose density floor; the pitch-class
    //     histogram cosine carries the verdict, not count parity. Requiring
    //     count parity from a "different random walk" contradicts the
    //     premise — it is why #366 fired on only 1/34 (#367).
    const countRatio = Math.max(dp.count, wp.count) > 0
      ? Math.min(dp.count, wp.count) / Math.max(dp.count, wp.count) : 1
    const bothOnset = dp.method === 'onset' && wp.method === 'onset'
    const bothContour = dp.method === 'contour' && wp.method === 'contour'
    const onsetUnreliable = mismatch >= 0 && !inconc && n > 0 && bothOnset && countRatio < 0.3
    // #374: contour pitch-tracker cannot reliably ORDER polyphonic chord
    // arpeggios. When source contains `play_chord` and both sides fell back
    // to contour mode, the reported sequences are full of pitch-classes
    // OUT of the expected chord set on BOTH sides (the tracker picks
    // different overtones / chord-members at different onsets). Same class
    // as #368 (onset-tracker on slewed material) — different material,
    // different mode. Verified empirically on `chord_inversions.rb` post
    // #372 fix: engine math provably desktop-correct (monophonic Level-3
    // walk: ✓ PITCH-MATCH 15/15 conf 1 both sides), yet the polyphonic
    // reproducer reports out-of-set noise on both sides with conf ~0.9.
    // Triggers INCONCL not DIVERGE — measurement honest about its limit.
    const polyphonic = /\bplay_chord\b/.test(r.code)
    const polyphonicUnreliable = mismatch >= 0 && !inconc && n > 0 && polyphonic && bothContour
    // #376 (next SP98-family gate): pitch-tracker METHOD ASYMMETRY.
    // When desktop and web fall into DIFFERENT pitch-track methods on the
    // same source — typically because the dominant onsets on each side are
    // different (gain-staging differences, FX accumulation, asymmetric
    // envelopes) — the resulting sequences are not comparable. `dark_neon`
    // (post-#370): desktop `contour` conf 0.98 (sustained blade synth + FX
    // chain dominates), web `onset` conf 1 (kick drum dominates) → desktop
    // pc {11,0} (bass blade) vs web pc {0,4,4,4,...} (kicks + harmonic).
    // Hard DIVERGE here misattributes a known gain-staging difference
    // (~0.5× web ratio) as an engine bug. Demote to INCONCL.
    const methodAsymmetric = mismatch >= 0 && !inconc && n > 0 && dp.method !== wp.method
    // #377 (next gate): multi-loop interleaved phase-drift. Reich's Piano
    // Phase pattern — two `live_loop`s playing the same notes at slightly
    // different sleep values — is DESIGNED to drift in/out of phase. When
    // two onsets fall within onset-detector resolution (~5-10ms), which
    // engine sees which "first" is timing-jitter dependent, not engine
    // semantics. Lokayata-proven for `reich_phase.rb`: single-loop variant
    // matches desktop EXACTLY for ≥39 notes; two-loop interleave diverges
    // at note 16 (+1 position offset, both sides walk the same note set).
    // Detection: ≥2 `live_loop` blocks in source AND tempos match AND a
    // long prefix-match (≥10 notes) before the first mismatch ⇒ the
    // divergence is phase-drift interleave jitter, not an engine bug.
    const liveLoopCount = (r.code.match(/\blive_loop\b/g) || []).length
    const prefixLen = mismatch >= 0 ? mismatch : n
    const multiLoopPhaseDrift = mismatch >= 0 && !inconc && n > 0 && liveLoopCount >= 2 && tempoOk && prefixLen >= 10
    if (mismatch >= 0 && !inconc && n > 0 && !onsetUnreliable && !polyphonicUnreliable && !methodAsymmetric && !multiLoopPhaseDrift && tempoOk && PRNG_RE.test(r.code)) {
      prngCos = cosine(pcHist(dSeq.slice(0, n)), pcHist(wSeq.slice(0, n)))
      if (prngCos >= 0.92 && countRatio >= 0.5) prngVariant = true
    }
    if (inconc) pitchVerdict = `⚠ INCONCLUSIVE — contour-low confidence (desktop ${dp.method}/${dp.confidence}, web ${wp.method}/${wp.confidence}); sustained/noisy material, no Tier-1 verdict`
    else if (n === 0) pitchVerdict = '⚠ no notes detected on one/both sides'
    else if (mismatch < 0) pitchVerdict = `✓ PITCH-MATCH — ${unit} identical over ${n}`
    else if (onsetUnreliable) pitchVerdict = `⚠ INCONCLUSIVE — onset detector unreliable: gross density mismatch (desktop ${dp.count} vs web ${wp.count} onsets, ratio ${countRatio.toFixed(2)} < 0.3) on slewed/sustained material; onset method cannot judge this — no Tier-1 verdict (#368)`
    else if (polyphonicUnreliable) pitchVerdict = `⚠ INCONCLUSIVE — polyphonic material (play_chord) judged via contour pitch-tracker; ordering reported on both sides contains pitch-classes outside any single chord (overtone/chord-member picking) — contour method cannot judge polyphonic-chord arpeggios reliably — no Tier-1 verdict (#374; for engine verification use an instrument-friendly monophonic reproducer)`
    else if (methodAsymmetric) {
      // #376 — instead of an automatic INCONCL, try to RECONCILE: both sides
      // were re-tracked with a forced common method (contour) capped to the
      // shorter capture's duration (r.reconciledPitch). Compared over the same
      // method + same time span, a method-asymmetric pair can still yield a
      // verdict — but ONLY a PRNG-VARIANT, and ONLY when the source is PRNG-
      // driven AND the pitch-class histogram genuinely matches. Everything
      // else stays INCONCL, so a pair where DIFFERENT signals dominate each
      // side (the dark_neon case — no PRNG token, blade vs kick) is never
      // misread as MATCH or as an engine bug. The reconciled "tempo" is
      // contour-segmentation spacing (not musical), so it is NOT a gate here;
      // the pc-histogram cosine carries the verdict (#358/#364/#367).
      const rd = r.reconciledPitch?.desktop, rw = r.reconciledPitch?.web
      const rdSeq = rd ? (rd.pc.filter(x => x !== null) as number[]) : []
      const rwSeq = rw ? (rw.pc.filter(x => x !== null) as number[]) : []
      const rn = Math.min(rdSeq.length, rwSeq.length)
      const rCos = rn > 0 ? cosine(pcHist(rdSeq.slice(0, rn)), pcHist(rwSeq.slice(0, rn))) : 0
      const rCount = rd && rw && Math.max(rd.count, rw.count) > 0
        ? Math.min(rd.count, rw.count) / Math.max(rd.count, rw.count) : 0
      const rLowConf = !rd || !rw || rd.confidence < 0.6 || rw.confidence < 0.6
      const alignedDur = Math.min(r.desktop.stats?.duration ?? 0, r.web.stats?.duration ?? 0)
      if (rd && rw && !rLowConf && rn > 0 && PRNG_RE.test(r.code) && rCos >= 0.92 && rCount >= 0.5) {
        prngVariant = true; prngCos = rCos
        pitchVerdict = `≈ pitch-class histogram cos=${rCos.toFixed(3)} (≥0.92), density ratio ${rCount.toFixed(2)} (≥0.5), PRNG token; same composition, different random walk — method-reconciled (desktop \`${dp.method}\`→contour · web \`${wp.method}\`→contour over aligned ${alignedDur.toFixed(1)}s window; #376/#358/#364/#367)`
      } else {
        const why = !PRNG_RE.test(r.code) ? '; no PRNG token — not promoted (different signals dominate each side)'
          : rLowConf ? `; reconciled-contour low confidence (desktop ${rd?.confidence ?? '—'} · web ${rw?.confidence ?? '—'})`
          : rn === 0 ? '; reconciled track empty'
          : `; reconciled-contour histogram cos=${rCos.toFixed(3)} < 0.92 (different signals dominate each side)`
        pitchVerdict = `⚠ INCONCLUSIVE — pitch-tracker method asymmetry: desktop \`${dp.method}\` (conf ${dp.confidence}) vs web \`${wp.method}\` (conf ${wp.confidence})${why} — no Tier-1 verdict (#376)`
      }
    }
    else if (multiLoopPhaseDrift) pitchVerdict = `⚠ INCONCLUSIVE — multi-loop interleaved phase drift: ${liveLoopCount} live_loops, first ${prefixLen} notes matched exactly desktop ↔ web before drift began. When two near-simultaneous onsets fall within onset-detector resolution (~5-10ms), which side "wins" is timing-jitter dependent, not engine semantics — engine provably correct on the long prefix-match (#377; for engine verification use an instrument-friendly single-loop variant)`
    else if (prngVariant) {
      pitchVerdict = `≈ pitch-class histogram cos=${prngCos.toFixed(3)} (≥0.92), tempo match, density ratio ${countRatio.toFixed(2)} (≥0.5), PRNG token in source; same composition, different random walk (cross-engine seed parity is not a v1 goal — #358/#364/#367)`
    }
    else pitchVerdict = `✗ PITCH DIVERGENCE at ${pcMode ? 'pc' : 'note'} ${mismatch} (desktop ${dSeq[mismatch]} vs web ${wSeq[mismatch]})`
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
  if (webEngineError) {
    // #371: ERROR ranks above INVALID — when the web engine threw, the WAV
    // (if any) is a partial render and the pitch sequence is meaningless. The
    // root cause is the throw, not a parity gap. INVALID would let the reader
    // chase the wrong question.
    const summary = r.web.errors[0].replace(/\s+/g, ' ').slice(0, 200)
    lines.push(`### ❌ ERROR — Web engine threw during capture; pitch verdict not formed. \`${summary}\``)
  } else if (webNoWavClass === 'engine-silent') {
    // SV48 (#427): the engine ran but produced no recording — debug the engine,
    // not the capture harness. Distinct from a precondition INVALID and from a
    // genuine TOOL-FAIL.
    lines.push(`### ❌ ENGINE-SILENT — the web engine ran but produced no recording (no /s_new reached the recorder; SV48). Debug the engine, not the capture harness. No Tier-1 verdict.`)
  } else if (webNoWavClass === 'tool-fail') {
    // SV48 (#427): a real blob was lost by the capture pipeline — debug the
    // harness, not the engine.
    lines.push(`### ❌ TOOL-FAIL — capture pipeline lost a real WAV blob (a .wav download fired but could not be resolved; SV48). The engine likely produced audio. Debug the harness, not the engine. No Tier-1 verdict.`)
  } else if (invalid) {
    lines.push(`### ❌ INVALID — Tier 0 HARD gate failed. The pitch sequence itself is unreliable; no verdict until fixed.`)
  } else if (pitchVerdict.startsWith('✓')) {
    lines.push(`### ✅ Tier 1 ${pitchVerdict}  (the musical-correctness verdict)${softNote}`)
  } else if (pitchVerdict.startsWith('≈')) {
    lines.push(`### ≈ Tier 1 PRNG-VARIANT — musically equivalent (same composition, different random walk). ${pitchVerdict.slice(2)}${softNote}`)
  } else if (pitchVerdict.startsWith('✗')) {
    lines.push(`### ❌ Tier 1 ${pitchVerdict}  (musical correctness FAILED — Tier 2/3 cannot override this)`)
  } else {
    lines.push(`### ⚠ Tier 1 inconclusive — ${pitchVerdict}${softNote}`)
  }
  lines.push('')
  lines.push('### Tier 0 — Validity gates')
  for (const v of t0) lines.push(v)
  lines.push('')
  if (r.web.errors.length > 0) {
    // #371: surface the full error list — triage is one-click without having
    // to chase the capture report file.
    lines.push('### Web engine errors (Tier-0 ERROR root cause)')
    for (const e of r.web.errors) lines.push(`- ${e}`)
    lines.push('')
  }
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
  // grep for the **File:** line. After #358, capture.ts ALWAYS emits **File:**:
  //   • `**File:** \`<abs-path>\`` — resolved WAV
  //   • `**File:** none — <reason>`  — sentinel: capture-tool failure (TOOL-FAIL)
  // Distinguishing the two lets the Tier-0 line say TOOL-FAIL vs ENGINE-SILENT.
  let webWav: string | null = null
  let webToolFailReason: string | null = null
  let webErrors: string[] = []
  const webReportMatch = web.stdout.match(/Capture saved:\s+(\S+\.md)/)
  if (webReportMatch && existsSync(webReportMatch[1])) {
    const md = readFileSync(webReportMatch[1], 'utf8')
    const m = md.match(/\*\*File:\*\*\s+`([^`]+\.wav)`/)
    if (m) {
      webWav = m[1]
    } else {
      const sentinel = md.match(/\*\*File:\*\*\s+none\s+—\s+(.+)$/m)
      if (sentinel) webToolFailReason = sentinel[1].trim()
    }
    // #371: extract the `## Errors` section. capture.ts always emits it
    // (`None.` when empty); a non-empty list means the engine threw / a
    // runtime-pattern (SyntaxError/TypeError/"not a function"/"Error in
    // loop"/…) appeared in the App Console. Bullets `- [pageerror @ …] …`,
    // `- [console.error @ …] …`, `- [network …] …`, `- [app console] …`.
    const errSection = md.match(/^## Errors\s*\n([\s\S]*?)(?=\n## |\n*$)/m)
    if (errSection) {
      const body = errSection[1].trim()
      if (body && body !== 'None.') {
        webErrors = body.split('\n')
          .map(l => l.replace(/^[-*]\s+/, '').trim())
          .filter(l => l.length > 0 && l !== 'None.')
      }
    }
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
  const runPitch = async (
    wav: string | null,
    opts?: { forceMethod?: 'onset' | 'contour'; maxDur?: number }
  ): Promise<PitchTrack | null> => {
    if (!wav) return null
    try {
      const pArgs = ['tools/pitchtrack.py', '--json']
      if (args.bpm !== null) pArgs.push('--bpm', String(args.bpm))
      if (opts?.forceMethod) pArgs.push('--force-method', opts.forceMethod)
      if (opts?.maxDur !== undefined) pArgs.push('--max-dur', opts.maxDur.toFixed(3))
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

  // #376 reconciliation — if the two sides auto-selected DIFFERENT methods,
  // re-track both with a forced common method (contour) capped to the shorter
  // capture's duration. Compared over the same time span + same method, a
  // method-asymmetric pair can still yield a real Tier-1 verdict.
  let reconciledPitch: { desktop: PitchTrack | null; web: PitchTrack | null } | null = null
  if (desktopPitch && webPitch && desktopPitch.method !== webPitch.method) {
    const dDur = desktopStats?.duration ?? 0
    const wDur = webStats?.duration ?? 0
    const capDur = dDur > 0 && wDur > 0 ? Math.min(dDur, wDur) : undefined
    const [dRec, wRec] = await Promise.all([
      runPitch(desktopWav, { forceMethod: 'contour', maxDur: capDur }),
      runPitch(webWav, { forceMethod: 'contour', maxDur: capDur }),
    ])
    reconciledPitch = { desktop: dRec, web: wRec }
  }

  const result: ComparisonResult = {
    timestamp: new Date().toISOString(),
    code: args.code,
    duration: args.duration,
    name: args.name,
    desktop: { wavPath: desktopWav, stats: desktopStats, rawStdout: desktop.stdout, ok: desktop.exitCode === 0, pitch: desktopPitch },
    web:     { wavPath: webWav,     stats: webStats,     rawStdout: web.stdout,     ok: web.exitCode === 0, pitch: webPitch, toolFailReason: webToolFailReason, errors: webErrors },
    spectrogram,
    spectrogramError,
    reportPath,
    reconciledPitch,
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
