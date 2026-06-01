/**
 * build-aggregate-index.ts — the aggregate parity dashboard at
 * test_results/index.html.
 *
 * Reads the freshly-built per-roster manifests and renders one landing page
 * that (a) links every roster viewer, (b) surfaces each pool's headline
 * verdict counts, and (c) shows the Tier-1 launch-gate hero. Reproducible:
 * re-run after any sweep and the numbers refresh from the manifests.
 *
 * Inputs (graceful if missing — the card says "not built"):
 *   test_results/examples-sweep.json       official 34   — Tier-1 pitch scheme
 *   test_results/book-examples-sweep.json   book 18       — Tier-1 pitch scheme
 *   test_results/e2e.json                    e2e 10        — consistency scheme
 *   test_results/community.json              community 48  — consistency scheme
 *   test_results/launch-gate.json            7-row gate
 *
 * HONESTY CONTRACT (SV46): official/book are graded on Tier-1 pitch parity
 * (the verdict). e2e/community are graded on a consistency score (Tier-2/3
 * timbre+level) which is BLIND to wrong melody and may never stand as a
 * musical-correctness verdict. The two schemes are presented SEPARATELY and
 * each pool's scheme is labelled — never silently merged into one number.
 *
 * The FX A/B Inspector that previously lived at index.html is preserved at
 * fx-inspector.html (this generator does not touch it; the build step copies
 * the old index.html there before overwriting).
 *
 * Usage: npx tsx tools/build-aggregate-index.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TR = resolve(ROOT, 'test_results')

function readJson<T>(name: string): T | null {
  const p = join(TR, name)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return null }
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── Manifest shapes (only the fields we read) ──────────────────────────────
interface PitchManifest {
  generatedAt?: string
  counts: { match: number; diverge: number; prngVariant: number; invalid: number; inconcl: number; error: number; prng: number; prngFreeReal: number; heavy: number; totalRows: number }
}
interface ConsistencyManifest {
  generatedAt?: string
  total: number
  captured?: number
  subPools?: Record<string, number>
  counts: { HIGH: number; MID: number; LOW: number; INCONCLUSIVE: number }
  schemeNote?: string
}
interface GateManifest {
  denominator: number; passCount: number; pct: number; thresholdPct: number; passed: boolean
  rows: { example: string; gateVerdict: string; pass: boolean; gradedVia: string; detail: string }[]
  exclusions?: { example: string; reason: string }[]
}

const official = readJson<PitchManifest>('examples-sweep.json')
const book = readJson<PitchManifest>('book-examples-sweep.json')
const e2e = readJson<ConsistencyManifest>('e2e.json')
const community = readJson<ConsistencyManifest>('community.json')
const gate = readJson<GateManifest>('launch-gate.json')

// ── chip rendering ─────────────────────────────────────────────────────────
function chip(label: string, n: number, cls: string): string {
  if (!n) return ''
  return `<span class="chip ${cls}" title="${esc(label)}">${esc(label)} <b>${n}</b></span>`
}

function pitchCard(title: string, count: number, viewer: string, m: PitchManifest | null, builder: string): string {
  if (!m) {
    return `<a class="pool-card missing" href="${viewer}">
      <div class="pool-head"><span class="pool-title">${esc(title)}</span><span class="pool-n">${count}</span></div>
      <div class="pool-note">manifest not built — run <code>${esc(builder)}</code></div>
    </a>`
  }
  const c = m.counts
  // PRNG-free actionable divergences are the launch-relevant number.
  const chips = [
    chip('MATCH', c.match, 'pass'),
    chip('PRNG-variant', c.prngVariant, 'accent'),
    chip('DIVERGE', c.diverge, 'fail'),
    chip('INCONCL', c.inconcl, 'incon'),
    chip('ERROR', c.error, 'faildark'),
    chip('INVALID', c.invalid, 'incon'),
  ].filter(Boolean).join('')
  const stamp = m.generatedAt ? new Date(m.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''
  return `<a class="pool-card" href="${viewer}">
    <div class="pool-head"><span class="pool-title">${esc(title)}</span><span class="pool-n">${c.totalRows}</span></div>
    <div class="scheme tier1">Tier-1 pitch parity · the verdict (SV46)</div>
    <div class="chips">${chips}</div>
    <div class="pool-foot">
      <span><b>${c.prngFreeReal}</b> PRNG-free real divergence${c.prngFreeReal === 1 ? '' : 's'} · ${c.prng} PRNG-driven · ${c.heavy} heavy-tool-fail</span>
      <span class="stamp">${esc(stamp)}</span>
    </div>
  </a>`
}

function consistencyCard(title: string, count: number, viewer: string, m: ConsistencyManifest | null, builder: string): string {
  if (!m) {
    return `<a class="pool-card missing" href="${viewer}">
      <div class="pool-head"><span class="pool-title">${esc(title)}</span><span class="pool-n">${count}</span></div>
      <div class="pool-note">manifest not built — run <code>${esc(builder)}</code></div>
    </a>`
  }
  const c = m.counts
  const chips = [
    chip('HIGH', c.HIGH, 'pass'),
    chip('MID', c.MID, 'flag'),
    chip('LOW', c.LOW, 'fail'),
    chip('INCONCL', c.INCONCLUSIVE, 'incon'),
  ].filter(Boolean).join('')
  const stamp = m.generatedAt ? new Date(m.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''
  const sub = m.subPools ? Object.entries(m.subPools).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : ''
  const cap = m.captured != null ? `${m.captured}/${m.total} captured` : ''
  return `<a class="pool-card" href="${viewer}">
    <div class="pool-head"><span class="pool-title">${esc(title)}</span><span class="pool-n">${m.total}</span></div>
    <div class="scheme tier23">⚠ consistency score · Tier-2/3 timbre+level · NOT pitch (SV46)</div>
    <div class="chips">${chips}</div>
    <div class="pool-foot">
      <span>${esc([cap, sub].filter(Boolean).join(' · '))}</span>
      <span class="stamp">${esc(stamp)}</span>
    </div>
  </a>`
}

// ── launch gate hero ───────────────────────────────────────────────────────
function gateHero(g: GateManifest | null): string {
  if (!g) {
    return `<a class="gate-hero missing" href="launch-gate.html">
      <div class="gate-verdict">🚦 Launch gate</div>
      <div class="gate-sub">manifest not built — run <code>tools/gate-report.ts</code></div>
    </a>`
  }
  const verdict = g.passed ? 'PASS' : 'NOT MET'
  const cls = g.passed ? 'pass' : 'fail'
  const rows = g.rows.map(r =>
    `<div class="grow ${r.pass ? 'p' : 'f'}"><span>${r.pass ? '✓' : '✗'}</span><code>${esc(r.example)}</code><em>${esc(r.gateVerdict)} · ${esc(r.gradedVia)}</em></div>`
  ).join('')
  const excl = g.exclusions?.length
    ? `<div class="gate-excl">excluded: ${g.exclusions.map(e => esc(e.example)).join(', ')} (PRNG non-goal SV49)</div>` : ''
  return `<a class="gate-hero ${cls}" href="launch-gate.html">
    <div class="gate-left">
      <div class="gate-verdict">🚦 Tier-1 launch gate</div>
      <div class="gate-big"><b>${g.passCount}/${g.denominator}</b> <span>= ${g.pct}%</span></div>
      <div class="gate-badge ${cls}">${verdict} <small>(≥ ${g.thresholdPct}%)</small></div>
      ${excl}
    </div>
    <div class="gate-rows">${rows}</div>
  </a>`
}

// ── page ───────────────────────────────────────────────────────────────────
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SonicPi.js — Parity Dashboard</title>
<style>
  :root {
    --bg:#1a1b26; --bg-elev:#1f2335; --bg-card:#16161e; --border:#2a2e46;
    --text:#c0caf5; --text-dim:#7a85b3; --text-mute:#565f89;
    --accent:#7aa2f7; --accent2:#ff1493;
    --pass:#9ece6a; --flag:#e0af68; --fail:#f7768e; --incon:#565f89; --faildark:#bb5560;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-size:13px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  a{color:inherit;text-decoration:none}
  .tab-bar{height:38px;display:flex;align-items:stretch;background:var(--bg-elev);
    border-bottom:1px solid var(--border);padding:0 16px;gap:2px}
  .tab-bar a{display:inline-flex;align-items:center;gap:6px;padding:0 14px;font-size:12px;
    color:var(--text-dim);border-bottom:2px solid transparent;font-family:var(--mono);
    text-transform:lowercase;letter-spacing:.04em}
  .tab-bar a:hover{color:var(--text)}
  .tab-bar a[data-active]{color:var(--accent2);border-bottom-color:var(--accent2)}
  .tab-bar .count{font-size:10px;background:var(--bg-card);color:var(--text-mute);
    padding:1px 6px;border-radius:8px}
  .tab-bar .spacer{flex:1}
  .tab-bar .meta{align-self:center;font-size:11px;color:var(--text-mute);font-family:var(--mono)}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 24px 60px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .sub{color:var(--text-dim);font-size:12.5px;margin:0 0 22px;font-family:var(--mono)}
  .sub b{color:var(--text)}
  /* launch gate hero */
  .gate-hero{display:flex;gap:24px;background:var(--bg-card);border:1px solid var(--border);
    border-radius:12px;padding:20px 22px;margin-bottom:26px;align-items:stretch}
  .gate-hero.pass{border-color:#39502f}
  .gate-hero.fail{border-color:#5a2f38}
  .gate-hero:hover{border-color:var(--accent)}
  .gate-left{min-width:230px;display:flex;flex-direction:column;gap:8px}
  .gate-verdict{font-family:var(--mono);font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em}
  .gate-big{font-size:40px;line-height:1;font-family:var(--mono)}
  .gate-big b{color:var(--text)}
  .gate-big span{font-size:18px;color:var(--text-dim)}
  .gate-badge{display:inline-block;width:fit-content;padding:3px 12px;border-radius:7px;font-family:var(--mono);
    font-weight:700;font-size:14px}
  .gate-badge.pass{background:#243218;color:var(--pass)}
  .gate-badge.fail{background:#321820;color:var(--fail)}
  .gate-badge small{font-weight:400;color:var(--text-mute);font-size:11px}
  .gate-excl{font-size:11px;color:var(--text-mute);font-family:var(--mono);margin-top:2px}
  .gate-rows{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;align-content:center}
  .grow{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px}
  .grow span{width:14px}
  .grow.p span{color:var(--pass)} .grow.f span{color:var(--fail)}
  .grow code{color:var(--text)} .grow em{color:var(--text-mute);font-style:normal;font-size:11px}
  /* pool grid */
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
  .pool-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;
    padding:16px 18px;display:flex;flex-direction:column;gap:10px;transition:border-color .1s}
  .pool-card:hover{border-color:var(--accent)}
  .pool-card.missing{opacity:.6}
  .pool-head{display:flex;align-items:baseline;justify-content:space-between}
  .pool-title{font-size:15px;font-weight:700}
  .pool-n{font-family:var(--mono);font-size:12px;color:var(--text-mute)}
  .scheme{font-family:var(--mono);font-size:10.5px;letter-spacing:.02em;padding:2px 0}
  .scheme.tier1{color:var(--pass)}
  .scheme.tier23{color:var(--flag)}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-family:var(--mono);font-size:11px;padding:2px 9px;border-radius:20px;
    background:var(--bg-elev);color:var(--text-dim)}
  .chip b{color:var(--text);margin-left:2px}
  .chip.pass{background:#1f2a16;color:var(--pass)}
  .chip.flag{background:#2a2412;color:var(--flag)}
  .chip.fail{background:#2a151b;color:var(--fail)}
  .chip.faildark{background:#241016;color:var(--faildark)}
  .chip.accent{background:#16213a;color:var(--accent)}
  .chip.incon{background:#1a1c26;color:var(--text-mute)}
  .pool-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;
    font-family:var(--mono);font-size:11px;color:var(--text-dim);border-top:1px solid var(--border);padding-top:9px}
  .pool-foot b{color:var(--text)}
  .pool-foot .stamp{color:var(--text-mute);white-space:nowrap}
  .pool-note{font-family:var(--mono);font-size:11.5px;color:var(--text-mute)}
  .pool-note code{color:var(--text-dim)}
  .section-h{font-size:12px;font-family:var(--mono);color:var(--text-dim);text-transform:uppercase;
    letter-spacing:.08em;margin:30px 0 12px}
  .caveat{background:#1d1a13;border:1px solid #3a3017;border-radius:10px;padding:14px 16px;
    margin:26px 0 0;font-size:12px;color:var(--text-dim);line-height:1.55}
  .caveat b{color:var(--flag)}
  .links{display:flex;flex-wrap:wrap;gap:14px;margin-top:18px;font-family:var(--mono);font-size:12px}
  .links a{color:var(--accent);border-bottom:1px solid transparent}
  .links a:hover{border-bottom-color:var(--accent)}
  footer{margin-top:36px;color:var(--text-mute);font-family:var(--mono);font-size:11px;
    border-top:1px solid var(--border);padding-top:14px}
</style>
</head>
<body>
<nav class="tab-bar">
  <a href="index.html" data-active>overview</a>
  <a href="examples-sweep.html">official <span class="count">34</span></a>
  <a href="book-examples-sweep.html">book <span class="count">18</span></a>
  <a href="e2e.html">e2e <span class="count">10</span></a>
  <a href="community.html">community + forum <span class="count">48</span></a>
  <a href="launch-gate.html">🚦 launch gate</a>
  <a href="fx-inspector.html">fx a/b <span class="count">40</span></a>
  <span class="spacer"></span>
  <span class="meta">desktop ↔ web parity · #424 ordered-fx-bundle</span>
</nav>
<div class="wrap">
  <h1>SonicPi.js — Parity Dashboard</h1>
  <p class="sub">Desktop Sonic Pi ↔ browser engine, every example pool. Built <b>${esc(now)}</b> from the freshly-captured manifests. <b>Tier-1 pitch is the verdict</b> (SV46); consistency scores are timbre/level support only.</p>

  ${gateHero(gate)}

  <div class="section-h">Tier-1 pitch parity — the musical-correctness verdict</div>
  <div class="grid">
    ${pitchCard('Official examples', 34, 'examples-sweep.html', official, 'tools/build-examples-sweep.ts')}
    ${pitchCard('Book / curriculum', 18, 'book-examples-sweep.html', book, 'tools/build-examples-sweep.ts --roster book-examples')}
  </div>

  <div class="section-h">Consistency score — timbre + level support (⚠ not a pitch verdict)</div>
  <div class="grid">
    ${consistencyCard('E2E suite', 10, 'e2e.html', e2e, 'tools/build-e2e-results.py')}
    ${consistencyCard('Community + in-thread-forum', 48, 'community.html', community, 'tools/build-community-results.py')}
  </div>

  <div class="caveat">
    <b>Why two schemes?</b> Official + book are graded on <b>Tier-1 pitch</b> (note progression, the verdict — a MATCH means the right notes at the right time). E2E + community are graded on a <b>consistency score</b> (RMS/peak ratio + mel-L2 + MFCC = timbre &amp; level), which per the project's 6-Tier standard is <b>blind to wrong melody</b> and can never stand as a musical-correctness verdict. A HIGH there means "sounds tonally/loudness-similar to desktop", not "plays the right notes". MFCC is further confounded by the known ~0.5× web gain (#268) + reverb tail. PRNG-driven divergence is a declared v1 non-goal (SV49) and is classified, not counted as a defect.
  </div>

  <div class="links">
    <a href="examples-sweep.html">official sweep →</a>
    <a href="book-examples-sweep.html">book sweep →</a>
    <a href="e2e.html">e2e →</a>
    <a href="community.html">community + forum →</a>
    <a href="launch-gate.html">🚦 launch gate →</a>
    <a href="fx-inspector.html">fx a/b inspector →</a>
    <a href="mono-sample-sp107.html">SP107 mono-sample investigation →</a>
    <a href="raw-lpf.html">raw-lpf investigation →</a>
  </div>

  <footer>Generated by <code>tools/build-aggregate-index.ts</code> from test_results/{examples-sweep,book-examples-sweep,e2e,community,launch-gate}.json. Re-run after any sweep to refresh.</footer>
</div>
</body>
</html>
`

writeFileSync(join(TR, 'index.html'), html)
console.log(`✓ wrote test_results/index.html (aggregate dashboard)`)
console.log(`  official=${official ? 'ok' : 'MISSING'} · book=${book ? 'ok' : 'MISSING'} · e2e=${e2e ? 'ok' : 'MISSING'} · community=${community ? 'ok' : 'MISSING'} · gate=${gate ? 'ok' : 'MISSING'}`)
