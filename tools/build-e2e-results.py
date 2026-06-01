#!/usr/bin/env python3
"""Mirror e2e-sweep artifacts into test_results/e2e/<fixture>/ and emit a
static test_results/e2e.html viewer with desktop+web audio players,
spectrograms, snippets, and metrics for all 10 fixtures.

Companion to tools/build-test-results.ts (FX inspector). E2E is structurally
flat (no per-beat per-FX search/filter), so a static HTML table is enough.

Usage: npx tsx tools/build-e2e-results.py    (or: python3 tools/build-e2e-results.py)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CAPTURES = REPO / ".captures" / "e2e-sweep"
SUITE = REPO / "tools" / "audio_comparison" / "e2e_test_suite"
OUT = REPO / "test_results"
OUT_E2E = OUT / "e2e"
OUT_HTML = OUT / "e2e.html"
OUT_JSON = OUT / "e2e.json"


# ─────────────────────────────────────────────────────────────────────────────
# Scoring + classification — mirrors tools/fx-sweep.ts so e2e fixtures land
# on the same parity scale as FX entries.
import math


def _ratio_score(r: float | None) -> float:
    if r is None or r <= 0:
        return 0.0
    return max(0.0, 100.0 - 50.0 * abs(math.log2(r)))


def _l2_score(v: float | None) -> float:
    if v is None:
        return 0.0
    return max(0.0, 100.0 - 2.0 * v)


def _mfcc_score(v: float | None) -> float:
    if v is None:
        return 0.0
    return max(0.0, 100.0 - 0.2 * v)


def consistency_score(rms_r: float | None, peak_r: float | None,
                      l2_db: float | None, mfcc: float | None) -> float | None:
    """Composite 0-100 score (100 = identical to desktop).
    Same weighting as tools/fx-sweep.ts: 30% rms ratio, 15% peak ratio,
    30% L2 (mel-dB), 25% MFCC distance."""
    if rms_r is None or peak_r is None or l2_db is None or mfcc is None:
        return None
    return (0.30 * _ratio_score(rms_r) +
            0.15 * _ratio_score(peak_r) +
            0.30 * _l2_score(l2_db) +
            0.25 * _mfcc_score(mfcc))


def classify(score: float | None, mfcc: float | None,
             desktop_silent: bool) -> str:
    if desktop_silent or score is None:
        return "INCONCLUSIVE"
    if score >= 70 and mfcc is not None and mfcc <= 180:
        return "HIGH"
    if score >= 50:
        return "MID"
    return "LOW"


def copy_if_exists(src: Path | str | None, dst: Path) -> bool:
    if not src:
        return False
    p = Path(src)
    if not p.exists():
        return False
    shutil.copyfile(p, dst)
    return True


def mirror_fixture(name: str, sidecar: dict) -> dict:
    fdir = OUT_E2E / name
    fdir.mkdir(parents=True, exist_ok=True)

    desktop_wav = sidecar.get("desktop", {}).get("wavPath")
    web_wav = sidecar.get("web", {}).get("wavPath")
    spec = sidecar.get("spectrogram", {}) or {}
    spec_png = spec.get("spectrogram_png")
    per_beat = spec.get("per_beat") or {}
    perbeat_png = per_beat.get("per_beat_png")
    report = sidecar.get("reportPath")

    snippet_src = SUITE / f"{name}.rb"
    sidecar_src = CAPTURES / f"{name}.json"

    ok_desktop = copy_if_exists(desktop_wav, fdir / "desktop.wav")
    ok_web = copy_if_exists(web_wav, fdir / "web.wav")
    ok_spec = copy_if_exists(spec_png, fdir / "spectrogram.png")
    ok_perbeat = copy_if_exists(perbeat_png, fdir / "perbeat.png")
    ok_snippet = copy_if_exists(snippet_src, fdir / "snippet.rb")
    ok_metrics = copy_if_exists(sidecar_src, fdir / "metrics.json")
    ok_report = copy_if_exists(report, fdir / "report.md")

    d = sidecar.get("desktop", {}).get("stats", {})
    w = sidecar.get("web", {}).get("stats", {})
    rms_ratio = (w.get("rms", 0) / d["rms"]) if d.get("rms") else None
    peak_ratio = (w.get("peak", 0) / d["peak"]) if d.get("peak") else None
    l2_db = spec.get("l2_mel_db")
    mfcc = spec.get("mfcc_distance")

    desktop_silent = bool(d) and d.get("peak", 0) == 0 and d.get("rms", 0) == 0
    score = consistency_score(rms_ratio, peak_ratio, l2_db, mfcc)
    verdict = classify(score, mfcc, desktop_silent)
    preconds = spec.get("preconditions") or {}
    precon_violated = bool(preconds.get("violated"))

    return {
        "name": name,
        "duration_ms": sidecar.get("duration"),
        "code_first_line": sidecar.get("code", "").split("\n")[0],
        "desktop": d,
        "web": w,
        "rms_ratio": rms_ratio,
        "peak_ratio": peak_ratio,
        "l2_mel_db": l2_db,
        "mfcc_distance": mfcc,
        "frames_compared": spec.get("frames_compared"),
        "desktop_peak_freq_hz": spec.get("desktop_peak_freq_hz"),
        "web_peak_freq_hz": spec.get("web_peak_freq_hz"),
        "score": score,
        "verdict": verdict,
        "bpm": per_beat.get("bpm"),
        "beats": per_beat.get("beats"),
        "mean_per_beat_mfcc": per_beat.get("mean_per_beat_mfcc_distance"),
        "most_divergent_beats": per_beat.get("most_divergent_beats") or [],
        "precondition_violated": precon_violated,
        "preconditions": preconds,
        "artifacts": {
            "desktop_wav": f"e2e/{name}/desktop.wav" if ok_desktop else None,
            "web_wav": f"e2e/{name}/web.wav" if ok_web else None,
            "spectrogram": f"e2e/{name}/spectrogram.png" if ok_spec else None,
            "perbeat": f"e2e/{name}/perbeat.png" if ok_perbeat else None,
            "snippet": f"e2e/{name}/snippet.rb" if ok_snippet else None,
            "metrics": f"e2e/{name}/metrics.json" if ok_metrics else None,
            "report": f"e2e/{name}/report.md" if ok_report else None,
        },
    }


def fmt_ratio(x: float | None) -> str:
    if x is None:
        return "—"
    return f"{x:.2f}×"


def ratio_class(x: float | None) -> str:
    """Color coding: parity (0.85–1.15) green; mild (0.6–0.85, 1.15–1.5) amber; outlier red."""
    if x is None:
        return ""
    if 0.85 <= x <= 1.15:
        return "good"
    if 0.6 <= x <= 1.5:
        return "mid"
    return "bad"


def render_card(entry: dict) -> str:
    a = entry["artifacts"]
    name = entry["name"]
    d = entry["desktop"] or {}
    w = entry["web"] or {}
    code = ""
    snippet_path = SUITE / f"{name}.rb"
    if snippet_path.exists():
        code = snippet_path.read_text()
    code_html = (
        code.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    rms_class = ratio_class(entry["rms_ratio"])
    peak_class = ratio_class(entry["peak_ratio"])
    spec_img = (
        f'<img src="{a["spectrogram"]}" alt="{name} spectrogram" />'
        if a["spectrogram"]
        else '<div class="no-spec">no spectrogram</div>'
    )
    perbeat_img = (
        f'<img src="{a["perbeat"]}" alt="{name} per-beat" />'
        if a["perbeat"]
        else '<div class="no-spec">no per-beat chart</div>'
    )
    desktop_audio = (
        f'<audio controls preload="metadata" src="{a["desktop_wav"]}"></audio>'
        if a["desktop_wav"]
        else '<div class="no-spec">no desktop wav</div>'
    )
    web_audio = (
        f'<audio controls preload="metadata" src="{a["web_wav"]}"></audio>'
        if a["web_wav"]
        else '<div class="no-spec">no web wav</div>'
    )
    metrics_link = (
        f'<a href="{a["metrics"]}" target="_blank">metrics.json</a>'
        if a["metrics"]
        else ""
    )
    report_link = (
        f' · <a href="{a["report"]}" target="_blank">report.md</a>'
        if a["report"]
        else ""
    )
    score_str = "—" if entry["score"] is None else f'{entry["score"]:.1f}'
    verdict = entry["verdict"]
    mfcc_str = "—" if entry["mfcc_distance"] is None else f'{entry["mfcc_distance"]:.0f}'
    l2_str = "—" if entry["l2_mel_db"] is None else f'{entry["l2_mel_db"]:.1f}'
    bpm = entry.get("bpm")
    beats = entry.get("beats")
    mean_pb = entry.get("mean_per_beat_mfcc")
    div_beats = entry.get("most_divergent_beats") or []
    pb_meta = ""
    if bpm and beats:
        bits = [f"bpm {bpm:.0f}", f"beats {beats}"]
        if mean_pb is not None:
            bits.append(f"mean per-beat MFCC {mean_pb:.0f}")
        if div_beats:
            bits.append(f"most divergent beats: {', '.join(str(b) for b in div_beats[:5])}")
        pb_meta = f'<small>{" · ".join(bits)}</small>'
    precon_badge = ""
    if entry.get("precondition_violated"):
        precon_badge = '<span class="badge precon">PRECON</span>'
    return f"""
    <section class="fixture" id="{name}">
      <header>
        <h2>{name}</h2>
        <div class="header-right">
          <div class="ratios">
            <span>RMS× <b class="{rms_class}">{fmt_ratio(entry["rms_ratio"])}</b></span>
            <span>peak× <b class="{peak_class}">{fmt_ratio(entry["peak_ratio"])}</b></span>
            <span>MFCC <b>{mfcc_str}</b></span>
            <span>L2 dB <b>{l2_str}</b></span>
          </div>
          <div class="verdict">
            <span class="badge {verdict}">{verdict}</span>
            <span class="score">{score_str}<small>/100</small></span>
            {precon_badge}
          </div>
        </div>
      </header>

      <div class="grid">
        <div class="audio-pair">
          <div class="audio-card">
            <h3>Desktop</h3>
            {desktop_audio}
            <small>peak {d.get("peak", 0):.3f} · RMS {d.get("rms", 0):.4f} · {d.get("duration", 0):.2f}s @ {d.get("sampleRate", 0)}Hz</small>
          </div>
          <div class="audio-card">
            <h3>Web</h3>
            {web_audio}
            <small>peak {w.get("peak", 0):.3f} · RMS {w.get("rms", 0):.4f} · {w.get("duration", 0):.2f}s @ {w.get("sampleRate", 0)}Hz</small>
          </div>
        </div>

        <div class="spec-card">
          <h3>Spectrogram (mel-dB · 3 panels: desktop / web / |Δ|)</h3>
          {spec_img}
          <small>{entry["frames_compared"]} frames · desktop peak freq {entry["desktop_peak_freq_hz"]:.1f} Hz · web {entry["web_peak_freq_hz"]:.1f} Hz</small>
        </div>

        <div class="spec-card">
          <h3>Per-beat divergence (RMS, peak, MFCC distance per beat window)</h3>
          {perbeat_img}
          {pb_meta}
        </div>

        <details class="snippet">
          <summary>Source ({name}.rb)</summary>
          <pre><code>{code_html}</code></pre>
        </details>
      </div>

      <footer>
        {metrics_link}{report_link}
      </footer>
    </section>
    """


def render_summary(entries: list[dict]) -> str:
    rms_ratios = [e["rms_ratio"] for e in entries if e["rms_ratio"] is not None]
    peak_ratios = [e["peak_ratio"] for e in entries if e["peak_ratio"] is not None]
    rms_ratios.sort()
    peak_ratios.sort()
    n = len(rms_ratios)
    median_rms = rms_ratios[n // 2] if n else 0
    median_peak = peak_ratios[n // 2] if n else 0
    in_band = sum(1 for r in rms_ratios if 0.85 <= r <= 1.15)
    return f"""
    <p>10 fixtures · 20s each · post SP72 + AMP=3 · SR-consistent at 48 kHz.</p>
    <table class="overview">
      <thead>
        <tr><th>fixture</th><th>RMS×</th><th>peak×</th><th>MFCC</th><th>L2 dB</th></tr>
      </thead>
      <tbody>
        {''.join(f'<tr><td><a href="#{e["name"]}">{e["name"]}</a></td>'
                 f'<td class="{ratio_class(e["rms_ratio"])}">{fmt_ratio(e["rms_ratio"])}</td>'
                 f'<td class="{ratio_class(e["peak_ratio"])}">{fmt_ratio(e["peak_ratio"])}</td>'
                 f'<td>{e["mfcc_distance"]:.0f}</td>'
                 f'<td>{e["l2_mel_db"]:.1f}</td></tr>' for e in entries)}
      </tbody>
    </table>
    <p>Median RMS× <b class="{ratio_class(median_rms)}">{fmt_ratio(median_rms)}</b> ·
       median peak× <b class="{ratio_class(median_peak)}">{fmt_ratio(median_peak)}</b> ·
       {in_band}/{n} fixtures within ±15% RMS.</p>
    """


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>E2E Composition Suite — A/B Inspector</title>
<style>
  :root {{
    --bg: #1a1b26; --bg2: #24283b; --text: #c0caf5; --text-dim: #9aa5ce;
    --accent: #7aa2f7; --good: #9ece6a; --mid: #e0af68; --bad: #f7768e;
    --mono: 'JetBrains Mono', 'Menlo', monospace;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    background: var(--bg); color: var(--text);
    font-family: -apple-system, system-ui, sans-serif;
    margin: 0; line-height: 1.5;
  }}
  .page {{ max-width: 1280px; margin: 0 auto; padding: 24px 48px; }}
  h1 {{ color: var(--accent); margin: 0 0 8px; }}
  h2 {{ margin: 0; color: var(--text); }}
  h3 {{ margin: 0 0 8px; color: var(--text-dim); font-size: 13px; font-weight: 600; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  small {{ color: var(--text-dim); display: block; margin-top: 6px; font-family: var(--mono); font-size: 11px; }}
  /* unified tab bar — same chrome across index.html / e2e.html / community.html */
  .tab-bar {{
    height: 38px; display: flex; align-items: stretch;
    background: #1f2335; border-bottom: 1px solid #2a2e46;
    padding: 0 16px; gap: 4px;
  }}
  .tab-bar a {{
    display: inline-flex; align-items: center; gap: 6px;
    padding: 0 16px; font-size: 12px; color: var(--text-dim);
    text-decoration: none; border-bottom: 2px solid transparent;
    font-family: var(--mono); text-transform: lowercase; letter-spacing: 0.04em;
  }}
  .tab-bar a:hover {{ color: var(--text); text-decoration: none; }}
  .tab-bar a[data-active="1"] {{ color: var(--accent); border-bottom-color: var(--accent); }}
  .tab-bar .count {{
    font-size: 10px; color: #565f89; background: rgba(86,95,137,0.2);
    padding: 1px 6px; border-radius: 999px;
  }}
  .tab-bar a[data-active="1"] .count {{
    background: rgba(255,20,147,0.15); color: var(--accent);
  }}
  .tab-bar .spacer {{ flex: 1; }}
  .tab-bar .meta {{ align-self: center; font-size: 11px; color: #565f89; font-family: var(--mono); }}
  .tab-bar .meta a {{ padding: 0; font-size: 11px; }}
  .summary {{ background: var(--bg2); padding: 16px 20px; border-radius: 8px; margin-bottom: 32px; }}
  table.overview {{ width: 100%; border-collapse: collapse; margin: 12px 0; font-family: var(--mono); font-size: 12px; }}
  table.overview th, table.overview td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #2c3147; }}
  table.overview th {{ color: var(--text-dim); font-weight: 500; }}
  .good {{ color: var(--good); font-weight: 600; }}
  .mid {{ color: var(--mid); font-weight: 600; }}
  .bad {{ color: var(--bad); font-weight: 600; }}
  .fixture {{ background: var(--bg2); border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }}
  .fixture header {{ display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #2c3147; gap: 16px; flex-wrap: wrap; }}
  .header-right {{ display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }}
  .ratios {{ display: flex; gap: 18px; font-family: var(--mono); font-size: 12px; color: var(--text-dim); }}
  .ratios b {{ color: var(--text); }}
  .verdict {{ display: flex; gap: 10px; align-items: center; font-family: var(--mono); }}
  .verdict .score {{ font-size: 22px; font-weight: 700; color: var(--text); line-height: 1; }}
  .verdict .score small {{ font-size: 11px; color: var(--text-dim); font-weight: 400; }}
  .badge {{ font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 3px; line-height: 1; display: inline-block; }}
  .badge.HIGH {{ background: rgba(158,206,106,0.15); color: var(--good); }}
  .badge.MID {{ background: rgba(224,175,104,0.15); color: var(--mid); }}
  .badge.LOW {{ background: rgba(247,118,142,0.15); color: var(--bad); }}
  .badge.INCONCLUSIVE {{ background: rgba(86,95,137,0.2); color: var(--text-dim); }}
  .badge.precon {{ background: rgba(224,175,104,0.18); color: var(--mid); border: 1px solid rgba(224,175,104,0.4); }}
  .grid {{ display: flex; flex-direction: column; gap: 16px; }}
  .audio-pair {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
  .audio-card {{ background: rgba(122, 162, 247, 0.05); padding: 10px 12px; border-radius: 6px; }}
  .audio-card audio {{ width: 100%; }}
  .spec-card img {{ width: 100%; height: auto; border-radius: 4px; background: #1a1b26; }}
  .no-spec {{ padding: 12px; color: var(--text-dim); font-style: italic; font-size: 12px; }}
  .snippet {{ background: rgba(122, 162, 247, 0.05); border-radius: 6px; padding: 8px 12px; }}
  .snippet summary {{ cursor: pointer; font-size: 12px; color: var(--text-dim); user-select: none; }}
  .snippet pre {{ font-family: var(--mono); font-size: 11px; line-height: 1.5; max-height: 360px; overflow-y: auto; background: var(--bg); padding: 12px; border-radius: 4px; margin: 10px 0 0; }}
  .fixture footer {{ margin-top: 14px; padding-top: 10px; border-top: 1px solid #2c3147; font-family: var(--mono); font-size: 11px; color: var(--text-dim); }}
</style>
</head>
<body>
<nav class="tab-bar">
  <a href="index.html">overview</a>
  <a href="examples-sweep.html">official <span class="count">34</span></a>
  <a href="book-examples-sweep.html">book <span class="count">18</span></a>
  <a href="e2e.html" data-active="1">e2e <span class="count">10</span></a>
  <a href="community.html">community + forum <span class="count">48</span></a>
  <a href="launch-gate.html">🚦 launch gate</a>
  <a href="fx-inspector.html">fx a/b <span class="count">40</span></a>
  <span class="spacer"></span>
  <span class="meta"><a href="raw-lpf.html">raw-lpf investigation</a></span>
</nav>
<div class="page">
<h1>E2E Composition Suite — A/B Inspector</h1>
<div class="summary">
  <h2>Summary</h2>
  {summary}
</div>
{cards}
<footer style="text-align: center; padding: 24px 0; color: var(--text-dim); font-size: 11px;">
  Generated by <code>tools/build-e2e-results.py</code>. Source data: <code>.captures/e2e-sweep/</code>.
</footer>
</div>
</body>
</html>
"""


def main() -> int:
    if not CAPTURES.exists():
        print(f"[e2e-builder] no e2e sweep at {CAPTURES} — run tools/e2e-sweep.sh first", file=sys.stderr)
        return 2

    sidecars = sorted(CAPTURES.glob("*.json"))
    if not sidecars:
        print(f"[e2e-builder] no sidecars in {CAPTURES}", file=sys.stderr)
        return 2

    print(f"[e2e-builder] mirroring {len(sidecars)} fixtures...")
    OUT_E2E.mkdir(parents=True, exist_ok=True)

    entries = []
    for sc in sidecars:
        name = sc.stem
        sidecar = json.loads(sc.read_text())
        entry = mirror_fixture(name, sidecar)
        entries.append(entry)
        print(f"  ✓ {name} (RMS× {fmt_ratio(entry['rms_ratio'])}, peak× {fmt_ratio(entry['peak_ratio'])})")

    summary_html = render_summary(entries)
    cards_html = "\n".join(render_card(e) for e in entries)
    html = HTML_TEMPLATE.format(summary=summary_html, cards=cards_html)
    OUT_HTML.write_text(html)
    print(f"\n[e2e-builder] wrote {OUT_HTML}")

    # JSON summary manifest, consumed by tools/build-aggregate-index.ts so the
    # aggregate landing reads every pool's headline counts from a manifest.
    # NOTE the verdict scheme here is consistency-score (Tier-2/3 timbre+level),
    # NOT Tier-1 pitch — flagged explicitly so the aggregate never presents it
    # as a musical-correctness verdict (SV46: Tier-2/3 may not stand as verdict).
    counts: dict[str, int] = {"HIGH": 0, "MID": 0, "LOW": 0, "INCONCLUSIVE": 0}
    for e in entries:
        counts[e["verdict"]] = counts.get(e["verdict"], 0) + 1
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pool": "e2e",
        "scheme": "consistency-score",
        "schemeNote": "Tier-2/3 timbre+level (HIGH/MID/LOW/INCONCLUSIVE) — NOT Tier-1 pitch; blind to wrong melody per SV46.",
        "viewer": "e2e.html",
        "total": len(entries),
        "counts": counts,
        "entries": [
            {
                "name": e["name"], "verdict": e["verdict"], "score": e["score"],
                "rms_ratio": e["rms_ratio"], "peak_ratio": e["peak_ratio"],
                "mfcc_distance": e["mfcc_distance"], "l2_mel_db": e["l2_mel_db"],
            } for e in entries
        ],
    }
    OUT_JSON.write_text(json.dumps(manifest, indent=2))
    print(f"[e2e-builder] wrote {OUT_JSON}  ({counts})")
    print(f"[e2e-builder] open: file://{OUT_HTML}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
