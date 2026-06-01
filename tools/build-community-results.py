#!/usr/bin/env python3
"""Mirror community-sweep artifacts into test_results/community/<fixture>/
and emit a static test_results/community.html viewer.

Sister to tools/build-e2e-results.py — same per-card layout (desktop+web
players, 3-panel spectrogram, snippet, metrics), but groups fixtures by
their parent directory (community vs in-thread-forum) with a sticky
nav for jump-to. Failed captures (no WAV one side or both) get a
muted card with the error narrative inline.

Usage: python3 tools/build-community-results.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CAPTURES = REPO / ".captures" / "community-sweep"
SUITE_ROOT = REPO / "tests" / "book-examples"
OUT = REPO / "test_results"
OUT_COMMUNITY = OUT / "community"
OUT_HTML = OUT / "community.html"
OUT_JSON = OUT / "community.json"


# ─── Scoring + classification, mirrors tools/fx-sweep.ts ───────────────────
import math


def _ratio_score(r: float | None) -> float:
    if r is None or r <= 0:
        return 0.0
    return max(0.0, 100.0 - 50.0 * abs(math.log2(r)))


def _l2_score(v: float | None) -> float:
    return 0.0 if v is None else max(0.0, 100.0 - 2.0 * v)


def _mfcc_score(v: float | None) -> float:
    return 0.0 if v is None else max(0.0, 100.0 - 0.2 * v)


def consistency_score(rms_r, peak_r, l2_db, mfcc):
    if rms_r is None or peak_r is None or l2_db is None or mfcc is None:
        return None
    return (0.30 * _ratio_score(rms_r) + 0.15 * _ratio_score(peak_r) +
            0.30 * _l2_score(l2_db) + 0.25 * _mfcc_score(mfcc))


def classify(score, mfcc, desktop_silent: bool) -> str:
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


def parse_name(name: str) -> tuple[str, str]:
    """`community__01_tilburg_2` → ('community', '01_tilburg_2')."""
    if "__" in name:
        parent, base = name.split("__", 1)
        return parent, base
    return "unknown", name


def mirror_fixture(name: str, sidecar: dict) -> dict:
    parent, base = parse_name(name)
    fdir = OUT_COMMUNITY / parent / base
    fdir.mkdir(parents=True, exist_ok=True)

    desktop = sidecar.get("desktop", {}) or {}
    web = sidecar.get("web", {}) or {}
    spec = sidecar.get("spectrogram", {}) or {}
    desktop_wav = desktop.get("wavPath")
    web_wav = web.get("wavPath")
    spec_png = spec.get("spectrogram_png")
    per_beat = spec.get("per_beat") or {}
    perbeat_png = per_beat.get("per_beat_png")
    report = sidecar.get("reportPath")

    snippet_src = SUITE_ROOT / parent / f"{base}.rb"
    sidecar_src = CAPTURES / f"{name}.json"

    ok_desktop = copy_if_exists(desktop_wav, fdir / "desktop.wav")
    ok_web = copy_if_exists(web_wav, fdir / "web.wav")
    ok_spec = copy_if_exists(spec_png, fdir / "spectrogram.png")
    ok_perbeat = copy_if_exists(perbeat_png, fdir / "perbeat.png")
    ok_snippet = copy_if_exists(snippet_src, fdir / "snippet.rb")
    ok_metrics = copy_if_exists(sidecar_src, fdir / "metrics.json")
    ok_report = copy_if_exists(report, fdir / "report.md")

    d = desktop.get("stats") or {}
    w = web.get("stats") or {}
    rms_ratio = (w.get("rms", 0) / d["rms"]) if d.get("rms") else None
    peak_ratio = (w.get("peak", 0) / d["peak"]) if d.get("peak") else None
    l2_db = spec.get("l2_mel_db")
    mfcc = spec.get("mfcc_distance")

    desktop_silent = bool(d) and d.get("peak", 0) == 0 and d.get("rms", 0) == 0
    score = consistency_score(rms_ratio, peak_ratio, l2_db, mfcc)
    verdict = classify(score, mfcc, desktop_silent or not d or not w)
    preconds = spec.get("preconditions") or {}

    return {
        "name": name,
        "parent": parent,
        "base": base,
        "duration_ms": sidecar.get("duration"),
        "desktop_ok": bool(d),
        "web_ok": bool(w),
        "desktop": d,
        "web": w,
        "rms_ratio": rms_ratio,
        "peak_ratio": peak_ratio,
        "l2_mel_db": l2_db,
        "mfcc_distance": mfcc,
        "frames_compared": spec.get("frames_compared"),
        "desktop_peak_freq_hz": spec.get("desktop_peak_freq_hz"),
        "web_peak_freq_hz": spec.get("web_peak_freq_hz"),
        "spec_error": sidecar.get("spectrogramError"),
        "score": score,
        "verdict": verdict,
        "bpm": per_beat.get("bpm"),
        "beats": per_beat.get("beats"),
        "mean_per_beat_mfcc": per_beat.get("mean_per_beat_mfcc_distance"),
        "most_divergent_beats": per_beat.get("most_divergent_beats") or [],
        "precondition_violated": bool(preconds.get("violated")),
        "artifacts": {
            "desktop_wav": f"community/{parent}/{base}/desktop.wav" if ok_desktop else None,
            "web_wav": f"community/{parent}/{base}/web.wav" if ok_web else None,
            "spectrogram": f"community/{parent}/{base}/spectrogram.png" if ok_spec else None,
            "perbeat": f"community/{parent}/{base}/perbeat.png" if ok_perbeat else None,
            "snippet": f"community/{parent}/{base}/snippet.rb" if ok_snippet else None,
            "metrics": f"community/{parent}/{base}/metrics.json" if ok_metrics else None,
            "report": f"community/{parent}/{base}/report.md" if ok_report else None,
        },
    }


def fmt_ratio(x: float | None) -> str:
    return "—" if x is None else f"{x:.2f}×"


def ratio_class(x: float | None) -> str:
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
    base = entry["base"]
    parent = entry["parent"]
    d = entry["desktop"] or {}
    w = entry["web"] or {}

    snippet_path = SUITE_ROOT / parent / f"{base}.rb"
    code_html = ""
    if snippet_path.exists():
        code = snippet_path.read_text(errors="replace")
        code_html = (
            code.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

    # Failure mode: one or both sides produced nothing.
    failed = not entry["desktop_ok"] or not entry["web_ok"]
    fail_note = ""
    if failed:
        bits = []
        if not entry["desktop_ok"]:
            bits.append("desktop: no WAV")
        if not entry["web_ok"]:
            bits.append("web: no WAV")
        fail_note = (
            f'<div class="fail-note">⚠ Capture failed — {", ".join(bits)}. '
            f'Snippet may have a parse/runtime error or take longer than '
            f'{(entry["duration_ms"] or 0) // 1000}s to produce signal.</div>'
        )

    rms_class = ratio_class(entry["rms_ratio"])
    peak_class = ratio_class(entry["peak_ratio"])
    spec_img = (
        f'<img src="{a["spectrogram"]}" alt="{name} spectrogram" />'
        if a["spectrogram"]
        else '<div class="no-spec">no spectrogram (capture incomplete)</div>'
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
    metrics_link = f'<a href="{a["metrics"]}" target="_blank">metrics.json</a>' if a["metrics"] else ""
    report_link = f' · <a href="{a["report"]}" target="_blank">report.md</a>' if a["report"] else ""

    fail_class = " failed" if failed else ""
    mfcc_str = f'{entry["mfcc_distance"]:.0f}' if entry["mfcc_distance"] else "—"
    l2_str = f'{entry["l2_mel_db"]:.1f}' if entry["l2_mel_db"] else "—"
    score_str = "—" if entry["score"] is None else f'{entry["score"]:.1f}'
    verdict = entry["verdict"]
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
            bits.append(f"most divergent: {', '.join(str(b) for b in div_beats[:5])}")
        pb_meta = f'<small>{" · ".join(bits)}</small>'
    precon_badge = ""
    if entry.get("precondition_violated"):
        precon_badge = '<span class="badge precon">PRECON</span>'

    return f"""
    <section class="fixture{fail_class}" id="{name}">
      <header>
        <h2>{base} <span class="parent-tag">{parent}</span></h2>
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
      {fail_note}
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
        </div>
        <div class="spec-card">
          <h3>Per-beat divergence (RMS, peak, MFCC distance per beat window)</h3>
          {perbeat_img}
          {pb_meta}
        </div>
        <details class="snippet">
          <summary>Source ({parent}/{base}.rb)</summary>
          <pre><code>{code_html}</code></pre>
        </details>
      </div>
      <footer>{metrics_link}{report_link}</footer>
    </section>
    """


def render_summary(entries: list[dict]) -> str:
    by_parent: dict[str, list[dict]] = {}
    for e in entries:
        by_parent.setdefault(e["parent"], []).append(e)
    rows = []
    for e in entries:
        if e["rms_ratio"] is None:
            continue
        rows.append(e)
    rms = sorted(r["rms_ratio"] for r in rows)
    peak = sorted(r["peak_ratio"] for r in rows)
    n = len(rms)
    median_rms = rms[n // 2] if n else 0
    median_peak = peak[n // 2] if n else 0
    in_band = sum(1 for r in rows if 0.6 <= r["rms_ratio"] <= 1.5)

    failed = [e for e in entries if not e["desktop_ok"] or not e["web_ok"]]
    succeeded = len(entries) - len(failed)

    pool_table = ""
    for parent in sorted(by_parent):
        pool = by_parent[parent]
        ok = sum(1 for e in pool if e["desktop_ok"] and e["web_ok"])
        pool_table += f'<tr><td><a href="#pool-{parent}">{parent}</a></td><td>{ok}/{len(pool)}</td></tr>'

    nav_links = ""
    for parent in sorted(by_parent):
        pool = by_parent[parent]
        nav_links += f'<a href="#pool-{parent}">{parent} ({len(pool)})</a> '

    def _mfcc_cell(e: dict) -> str:
        m = e.get("mfcc_distance")
        return f"{m:.0f}" if m else "—"

    def _capture_cell(e: dict) -> str:
        return "ok" if e["desktop_ok"] and e["web_ok"] else "FAIL"

    overview_rows = "".join(
        f'<tr><td><a href="#{e["name"]}">{e["base"]}</a></td>'
        f'<td><span class="parent-tag">{e["parent"]}</span></td>'
        f'<td class="{ratio_class(e["rms_ratio"])}">{fmt_ratio(e["rms_ratio"])}</td>'
        f'<td class="{ratio_class(e["peak_ratio"])}">{fmt_ratio(e["peak_ratio"])}</td>'
        f'<td>{_mfcc_cell(e)}</td>'
        f'<td>{_capture_cell(e)}</td></tr>'
        for e in entries
    )

    return f"""
    <p>{len(entries)} community + in-thread-forum fixtures · 30s each · post SP72 + SP75 + AMP=2.</p>
    <p>Captures succeeded: <b>{succeeded}/{len(entries)}</b> · in-band RMS (0.6×–1.5×): <b>{in_band}/{n}</b> of those that produced WAVs.</p>
    <p>Median RMS× <b class="{ratio_class(median_rms)}">{fmt_ratio(median_rms)}</b> · median peak× <b class="{ratio_class(median_peak)}">{fmt_ratio(median_peak)}</b>.</p>
    <table class="overview">
      <thead><tr><th>pool</th><th>captures ok</th></tr></thead>
      <tbody>{pool_table}</tbody>
    </table>
    <div class="jump-nav">{nav_links}</div>
    <details>
      <summary>All fixtures table ({len(entries)})</summary>
      <table class="overview">
        <thead><tr><th>fixture</th><th>pool</th><th>RMS×</th><th>peak×</th><th>MFCC</th><th>capture</th></tr></thead>
        <tbody>{overview_rows}</tbody>
      </table>
    </details>
    """


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Community + Forum Compositions — A/B Inspector</title>
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
  h1 {{ color: var(--accent); margin: 0 0 8px; }}
  h2 {{ margin: 0; color: var(--text); display: flex; align-items: baseline; gap: 12px; }}
  h2 .parent-tag {{ font-family: var(--mono); font-size: 11px; color: var(--text-dim); padding: 2px 8px; background: rgba(122,162,247,0.12); border-radius: 999px; text-transform: lowercase; letter-spacing: 0.04em; }}
  h3 {{ margin: 0 0 8px; color: var(--text-dim); font-size: 13px; font-weight: 600; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  small {{ color: var(--text-dim); display: block; margin-top: 6px; font-family: var(--mono); font-size: 11px; }}
  .nav {{ margin: 12px 0 24px; padding: 12px 16px; background: var(--bg2); border-radius: 6px; }}
  .nav a {{ margin-right: 16px; }}
  .summary {{ background: var(--bg2); padding: 16px 20px; border-radius: 8px; margin-bottom: 32px; }}
  .summary p:first-child {{ margin-top: 0; }}
  table.overview {{ width: 100%; border-collapse: collapse; margin: 12px 0; font-family: var(--mono); font-size: 12px; }}
  table.overview th, table.overview td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #2c3147; }}
  table.overview th {{ color: var(--text-dim); font-weight: 500; }}
  .jump-nav {{ margin: 12px 0; }}
  .jump-nav a {{ display: inline-block; padding: 4px 10px; margin-right: 8px; background: rgba(122,162,247,0.08); border-radius: 4px; font-family: var(--mono); font-size: 12px; }}
  .good {{ color: var(--good); font-weight: 600; }}
  .mid {{ color: var(--mid); font-weight: 600; }}
  .bad {{ color: var(--bad); font-weight: 600; }}
  .pool-header {{ font-family: var(--mono); font-size: 14px; color: var(--accent); padding: 12px 0 6px; border-bottom: 1px solid #2c3147; margin: 32px 0 16px; text-transform: lowercase; letter-spacing: 0.04em; }}
  .fixture {{ background: var(--bg2); border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }}
  .fixture.failed {{ opacity: 0.6; border-left: 3px solid var(--bad); }}
  .fail-note {{ background: rgba(247,118,142,0.08); border-left: 3px solid var(--bad); padding: 8px 12px; margin: 10px 0; font-size: 12px; color: var(--text-dim); border-radius: 0 4px 4px 0; }}
  .fixture header {{ display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #2c3147; gap: 16px; flex-wrap: wrap; }}
  .header-right {{ display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }}
  .verdict {{ display: flex; gap: 10px; align-items: center; font-family: var(--mono); }}
  .verdict .score {{ font-size: 22px; font-weight: 700; color: var(--text); line-height: 1; }}
  .verdict .score small {{ font-size: 11px; color: var(--text-dim); font-weight: 400; }}
  .badge {{ font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 3px; line-height: 1; display: inline-block; }}
  .badge.HIGH {{ background: rgba(158,206,106,0.15); color: var(--good); }}
  .badge.MID {{ background: rgba(224,175,104,0.15); color: var(--mid); }}
  .badge.LOW {{ background: rgba(247,118,142,0.15); color: var(--bad); }}
  .badge.INCONCLUSIVE {{ background: rgba(86,95,137,0.2); color: var(--text-dim); }}
  .badge.precon {{ background: rgba(224,175,104,0.18); color: var(--mid); border: 1px solid rgba(224,175,104,0.4); }}
  .ratios {{ display: flex; gap: 18px; font-family: var(--mono); font-size: 12px; color: var(--text-dim); }}
  .ratios b {{ color: var(--text); }}
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
  .parent-tag {{ font-family: var(--mono); font-size: 11px; padding: 2px 8px; background: rgba(122,162,247,0.12); border-radius: 999px; text-transform: lowercase; }}
</style>
</head>
<body>
<nav class="tab-bar">
  <a href="index.html">overview</a>
  <a href="examples-sweep.html">official <span class="count">34</span></a>
  <a href="book-examples-sweep.html">book <span class="count">18</span></a>
  <a href="e2e.html">e2e <span class="count">10</span></a>
  <a href="community.html" data-active="1">community + forum <span class="count">48</span></a>
  <a href="launch-gate.html">🚦 launch gate</a>
  <a href="fx-inspector.html">fx a/b <span class="count">40</span></a>
  <span class="spacer"></span>
  <span class="meta"><a href="raw-lpf.html">raw-lpf investigation</a></span>
</nav>
<div class="page">
<h1>Community + Forum Compositions — A/B Inspector</h1>
<div class="summary">
  <h2 style="border:none;padding:0;margin-bottom:10px">Summary</h2>
  {summary}
</div>
{cards}
<footer style="text-align: center; padding: 24px 0; color: var(--text-dim); font-size: 11px;">
  Generated by <code>tools/build-community-results.py</code>. Source: <code>.captures/community-sweep/</code>.
</footer>
</div>
</body>
</html>
"""


def main() -> int:
    if not CAPTURES.exists():
        print(f"[community-builder] no sweep at {CAPTURES} — run tools/community-sweep.sh first", file=sys.stderr)
        return 2

    sidecars = sorted(CAPTURES.glob("*.json"))
    if not sidecars:
        print(f"[community-builder] no sidecars in {CAPTURES}", file=sys.stderr)
        return 2

    print(f"[community-builder] mirroring {len(sidecars)} fixtures...")
    OUT_COMMUNITY.mkdir(parents=True, exist_ok=True)

    entries = []
    for sc in sidecars:
        name = sc.stem
        sidecar = json.loads(sc.read_text())
        entry = mirror_fixture(name, sidecar)
        entries.append(entry)

    # Sort by parent-pool then base name (stable, predictable scroll).
    entries.sort(key=lambda e: (e["parent"], e["base"]))

    # Group by parent for pool headers.
    by_parent: dict[str, list[dict]] = {}
    for e in entries:
        by_parent.setdefault(e["parent"], []).append(e)

    cards_parts = []
    for parent in sorted(by_parent):
        pool = by_parent[parent]
        cards_parts.append(f'<div class="pool-header" id="pool-{parent}">{parent} ({len(pool)} fixtures)</div>')
        for e in pool:
            cards_parts.append(render_card(e))
    cards_html = "\n".join(cards_parts)

    summary_html = render_summary(entries)
    html = HTML_TEMPLATE.format(summary=summary_html, cards=cards_html)
    OUT_HTML.write_text(html)

    ok = sum(1 for e in entries if e["desktop_ok"] and e["web_ok"])
    print(f"[community-builder] {ok}/{len(entries)} fixtures with both-sides captures")
    print(f"[community-builder] wrote {OUT_HTML}")

    # JSON summary manifest for tools/build-aggregate-index.ts. Verdict scheme is
    # consistency-score (Tier-2/3 timbre+level) — NOT Tier-1 pitch (SV46 caveat).
    counts: dict[str, int] = {"HIGH": 0, "MID": 0, "LOW": 0, "INCONCLUSIVE": 0}
    for e in entries:
        counts[e["verdict"]] = counts.get(e["verdict"], 0) + 1
    captured = sum(1 for e in entries if e["desktop_ok"] and e["web_ok"])
    by_pool: dict[str, int] = {}
    for e in entries:
        by_pool[e["parent"]] = by_pool.get(e["parent"], 0) + 1
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pool": "community",
        "scheme": "consistency-score",
        "schemeNote": "Tier-2/3 timbre+level (HIGH/MID/LOW/INCONCLUSIVE) — NOT Tier-1 pitch; blind to wrong melody per SV46.",
        "viewer": "community.html",
        "total": len(entries),
        "captured": captured,
        "subPools": by_pool,
        "counts": counts,
        "entries": [
            {
                "name": e["name"], "parent": e["parent"], "base": e["base"],
                "verdict": e["verdict"], "score": e["score"],
                "captured": bool(e["desktop_ok"] and e["web_ok"]),
                "rms_ratio": e["rms_ratio"], "peak_ratio": e["peak_ratio"],
                "mfcc_distance": e["mfcc_distance"], "l2_mel_db": e["l2_mel_db"],
            } for e in entries
        ],
    }
    OUT_JSON.write_text(json.dumps(manifest, indent=2))
    print(f"[community-builder] wrote {OUT_JSON}  ({counts})")
    print(f"[community-builder] open: file://{OUT_HTML}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
