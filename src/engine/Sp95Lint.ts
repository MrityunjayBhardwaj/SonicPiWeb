/**
 * SP95-Loud — RETIRED 2026-05-28 (SP95(d) Slices 1 & 2, EPIC #392).
 *
 * This module was a build-time detector that converted three SILENT-failure
 * patterns of the old build-once-then-interpret model into visible warnings
 * (the SP95 launch co-gate, PR #381 / SV50). All three patterns now produce
 * CORRECT, desktop-matching audio, so every warning here became a false
 * positive — and a false positive erodes the lint's trust budget worse than
 * the original silence did (SV50's own negative-control discipline). The
 * detectors are removed; `detectSp95Limitations` returns `[]`.
 *
 * What changed (why each pattern is no longer a limitation):
 *   • #350 cross-loop set/get — RESOLVED by the time-indexed `TimeState` +
 *     eager `b.set` at build `current_time()` + `b.get` reader-vt routing
 *     (Slice 2, commits e5e13e8→0fe871c). r1 director/section reads the
 *     cuer's same-vt value: desktop-matching {55,59} (Level-3 PITCH-MATCH ×3).
 *   • #351-payload (`cue :x, k: v` + `sync :x`) and #351-index
 *     (`e = sync :x; e[:k]`) — RESOLVED by build-time `sync` await returning
 *     the cue payload (Slice 1, commit 402f691). r3/r4 Level-3 PITCH-MATCH.
 *
 * The generic warning CHANNEL it introduced (SonicPiEngine.setWarningHandler /
 * emitWarning, Console.logWarning, capture.ts `## Engine Warnings`) is kept —
 * it is reusable infrastructure for any future build-time lint. Only the
 * SP95-specific detectors are gone. SV50 still holds as a discipline; it just
 * no longer has an SP95 pattern to apply to.
 *
 * REFS: SV47 (IMPLEMENTED), krama SK16/SK17, hetvabhasa SP95 (RESOLVED blocks),
 * dharana §26 (RESOLVED). Issues #350/#351 (done); #400 (Slice 3 deferred —
 * reversed-loop-order (t,p,i,d) total order, a wake-phase parity feature, NOT
 * a silent-failure pattern this lint would catch). Prior loud-path: PR #381.
 */

export interface Sp95Warning {
  pattern: string
  title: string
  message: string
}

/**
 * Run all SP95-loud detectors over the given Ruby source. All SP95 idioms are
 * now implemented (see module header), so this returns `[]`. Retained as the
 * integration point for the warning channel so a future build-time lint can
 * slot in here without re-wiring SonicPiEngine / App / capture.ts. Pure, O(1).
 */
export function detectSp95Limitations(_src: string): Sp95Warning[] {
  return []
}
