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
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CAPTURES = REPO / ".captures" / "community-sweep"
SUITE_ROOT = REPO / "tests" / "book-examples"
OUT = REPO / "test_results"
OUT_COMMUNITY = OUT / "community"
OUT_HTML = OUT / "community.html"


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
    report = sidecar.get("reportPath")

    snippet_src = SUITE_ROOT / parent / f"{base}.rb"
    sidecar_src = CAPTURES / f"{name}.json"

    ok_desktop = copy_if_exists(desktop_wav, fdir / "desktop.wav")
    ok_web = copy_if_exists(web_wav, fdir / "web.wav")
    ok_spec = copy_if_exists(spec_png, fdir / "spectrogram.png")
    ok_snippet = copy_if_exists(snippet_src, fdir / "snippet.rb")
    ok_metrics = copy_if_exists(sidecar_src, fdir / "metrics.json")
    ok_report = copy_if_exists(report, fdir / "report.md")

    d = desktop.get("stats") or {}
    w = web.get("stats") or {}
    rms_ratio = (w.get("rms", 0) / d["rms"]) if d.get("rms") else None
    peak_ratio = (w.get("peak", 0) / d["peak"]) if d.get("peak") else None

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
        "l2_mel_db": spec.get("l2_mel_db"),
        "mfcc_distance": spec.get("mfcc_distance"),
        "frames_compared": spec.get("frames_compared"),
        "desktop_peak_freq_hz": spec.get("desktop_peak_freq_hz"),
        "web_peak_freq_hz": spec.get("web_peak_freq_hz"),
        "spec_error": sidecar.get("spectrogramError"),
        "artifacts": {
            "desktop_wav": f"community/{parent}/{base}/desktop.wav" if ok_desktop else None,
            "web_wav": f"community/{parent}/{base}/web.wav" if ok_web else None,
            "spectrogram": f"community/{parent}/{base}/spectrogram.png" if ok_spec else None,
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
        f'<img src="{a["spectrogram"]}" alt="{name} spectrogram" loading="lazy" />'
        if a["spectrogram"]
        else '<div class="no-spec">no spectrogram (capture incomplete)</div>'
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

    return f"""
    <section class="fixture{fail_class}" id="{name}">
      <header>
        <h2>{base} <span class="parent-tag">{parent}</span></h2>
        <div class="ratios">
          <span>RMS× <b class="{rms_class}">{fmt_ratio(entry["rms_ratio"])}</b></span>
          <span>peak× <b class="{peak_class}">{fmt_ratio(entry["peak_ratio"])}</b></span>
          <span>MFCC <b>{mfcc_str}</b></span>
          <span>L2 dB <b>{l2_str}</b></span>
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
    padding: 24px 48px; line-height: 1.5; max-width: 1280px; margin: 0 auto;
  }}
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
  .fixture header {{ display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #2c3147; }}
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
<h1>Community + Forum Compositions — A/B Inspector</h1>
<div class="nav">
  <a href="index.html">← FX inspector</a>
  <a href="e2e.html">e2e suite →</a>
  <a href="raw-lpf.html">raw-lpf investigation</a>
</div>
<div class="summary">
  <h2 style="border:none;padding:0;margin-bottom:10px">Summary</h2>
  {summary}
</div>
{cards}
<footer style="text-align: center; padding: 24px 0; color: var(--text-dim); font-size: 11px;">
  Generated by <code>tools/build-community-results.py</code>. Source: <code>.captures/community-sweep/</code>.
</footer>
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
    print(f"[community-builder] open: file://{OUT_HTML}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
