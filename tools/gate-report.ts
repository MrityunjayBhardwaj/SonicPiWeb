/**
 * gate-report.ts — Launch-gate computation with reproducer-as-verdict overlay (#407).
 *
 * The raw sweep (test_results/examples-sweep.json) records unvarnished verdicts —
 * including INCONCL for rows the pitch-trackers cannot grade. That is honest
 * measurement, but INCONCL means "the instrument can't see," NOT "no bug" (SP106):
 * an INCONCL row may hide a real engine defect (it hid the note(octave:) bug).
 *
 * This script computes the LAUNCH GATE (launch_acceptance_criteria / dharana §28):
 * denominator = PRNG-free non-heavy official rows; pass = MATCH or PRNG-VARIANT;
 * threshold ≥70%. For instrument-blind rows it overlays the verdict of an
 * instrument-friendly PROJECTION (tools/gate-reproducers/, see manifest.json) that
 * exercises the SAME engine logic on gradeable material — annotated "graded via
 * projection." Rows with no faithful projection are listed as documented
 * limitations (NOT counted as pass). PRNG rows are excluded from the denominator
 * (SV49 non-goal).
 *
 * Usage: npx tsx tools/gate-report.ts
 *   Writes test_results/launch-gate.{json,md}.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SWEEP = join(ROOT, 'test_results/examples-sweep.json')
const MANIFEST = join(ROOT, 'tools/gate-reproducers/manifest.json')

interface SweepRow {
  example: string; verdict: string; prng: boolean; heavy: boolean
}
interface Evidence { report: string; verdict: string; method?: string; desktop?: string; web?: string; note?: string }
interface Reproducer { example: string; reproducer: string; blindReason: string; projection: string; requires: string[]; evidence: Evidence }
interface Limitation { example: string; verdict: string; reason: string; engineEvidence: string; countsAsPass: boolean }
interface Exclusion { example: string; reason: string; classifier: string }
interface Refreshed { example: string; reason: string; evidence: Evidence }
interface Manifest { gateThresholdPct: number; reproducers: Reproducer[]; limitations: Limitation[]; refreshed?: Refreshed[]; exclusions: Exclusion[] }

const sweep = JSON.parse(readFileSync(SWEEP, 'utf8'))
const rows: SweepRow[] = sweep.entries
const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

const isPass = (v: string) => v === 'match' || v === 'prng-variant' || v === 'prngVariant'

// Denominator: PRNG-free, non-heavy official rows.
const denom = rows.filter(r => !r.prng && !r.heavy)
const reproByEx = new Map(manifest.reproducers.map(r => [r.example, r]))
const limByEx = new Map(manifest.limitations.map(l => [l.example, l]))
const refreshedByEx = new Map((manifest.refreshed ?? []).map(r => [r.example, r]))

interface GateRow { example: string; rawVerdict: string; gateVerdict: string; pass: boolean; gradedVia: string; detail: string }
const gateRows: GateRow[] = denom.map(r => {
  const repro = reproByEx.get(r.example)
  if (repro) {
    const verdict = repro.evidence.verdict
    return {
      example: r.example, rawVerdict: r.verdict, gateVerdict: verdict, pass: isPass(verdict),
      gradedVia: 'projection', detail: `${repro.reproducer} → ${repro.evidence.report}${repro.requires.length ? ` · requires ${repro.requires.join('; ')}` : ''}`,
    }
  }
  const refreshed = refreshedByEx.get(r.example)
  if (refreshed) {
    const verdict = refreshed.evidence.verdict
    return { example: r.example, rawVerdict: r.verdict, gateVerdict: verdict, pass: isPass(verdict), gradedVia: 'raw-refreshed', detail: `re-measured → ${refreshed.evidence.report}` }
  }
  const lim = limByEx.get(r.example)
  if (lim) {
    return { example: r.example, rawVerdict: r.verdict, gateVerdict: lim.verdict, pass: lim.countsAsPass, gradedVia: 'documented-limitation', detail: lim.reason }
  }
  return { example: r.example, rawVerdict: r.verdict, gateVerdict: r.verdict, pass: isPass(r.verdict), gradedVia: 'raw-sweep', detail: '' }
})

const passCount = gateRows.filter(g => g.pass).length
const total = gateRows.length
const pct = total ? (passCount / total) * 100 : 0
const passed = pct >= manifest.gateThresholdPct

// ---- write JSON ----
const out = {
  generatedFrom: 'examples-sweep.json + tools/gate-reproducers/manifest.json',
  denominator: total, passCount, pct: +pct.toFixed(1), thresholdPct: manifest.gateThresholdPct, passed,
  rows: gateRows,
  exclusions: manifest.exclusions,
}
writeFileSync(join(ROOT, 'test_results/launch-gate.json'), JSON.stringify(out, null, 2))

// ---- write Markdown ----
const verdictIcon = (g: GateRow) => g.pass ? '✅' : (g.gateVerdict === 'inconcl' ? '⚠️' : '❌')
const md = [
  `# Launch Gate — PRNG-free non-heavy official roster`,
  ``,
  `**${passCount}/${total} = ${pct.toFixed(1)}%** · threshold ≥${manifest.gateThresholdPct}% · **${passed ? '✅ PASS' : '❌ NOT MET'}**`,
  ``,
  `> Pass = MATCH or PRNG-VARIANT. Rows the pitch-trackers cannot grade are graded via an instrument-friendly projection that exercises the same engine logic (see \`tools/gate-reproducers/\`). The raw sweep keeps the unvarnished verdicts; this is the launch-gate computation.`,
  ``,
  `> **Validity:** projection/refreshed verdicts are recorded evidence. The engine fixes they depend on — **#405** (play_pattern_timed, b4a2dc1) and **#409** (note octave, 8f38e2c) — are **merged to main**, and both projections were re-captured live against merged main (2026-05-29). Re-capture any reproducer with \`npx tsx tools/compare-desktop-vs-web.ts --file <reproducer.rb>\` and update the manifest evidence to refresh.`,
  ``,
  `| Row | raw sweep | gate verdict | graded via | detail |`,
  `|---|---|---|---|---|`,
  ...gateRows.map(g => `| ${verdictIcon(g)} ${g.example} | ${g.rawVerdict} | ${g.gateVerdict} | ${g.gradedVia} | ${g.detail} |`),
  ``,
  `## Excluded from denominator (SV49 — cross-engine PRNG is a v1 non-goal)`,
  ...manifest.exclusions.map(e => `- **${e.example}** — ${e.reason}`),
  ``,
  `_Generated by tools/gate-report.ts from test_results/examples-sweep.json + tools/gate-reproducers/manifest.json._`,
].join('\n')
writeFileSync(join(ROOT, 'test_results/launch-gate.md'), md)

console.log(`Launch gate: ${passCount}/${total} = ${pct.toFixed(1)}% — ${passed ? 'PASS' : 'NOT MET'}`)
console.log(`Wrote test_results/launch-gate.{json,md}`)
for (const g of gateRows) console.log(`  ${g.pass ? 'PASS' : 'fail'}  ${g.example.padEnd(20)} ${g.gateVerdict.padEnd(10)} (${g.gradedVia})`)
