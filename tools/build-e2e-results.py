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
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CAPTURES = REPO / ".captures" / "e2e-sweep"
SUITE = REPO / "tools" / "audio_comparison" / "e2e_test_suite"
OUT = REPO / "test_results"
OUT_E2E = OUT / "e2e"
OUT_HTML = OUT / "e2e.html"


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
    report = sidecar.get("reportPath")

    snippet_src = SUITE / f"{name}.rb"
    sidecar_src = CAPTURES / f"{name}.json"

    ok_desktop = copy_if_exists(desktop_wav, fdir / "desktop.wav")
    ok_web = copy_if_exists(web_wav, fdir / "web.wav")
    ok_spec = copy_if_exists(spec_png, fdir / "spectrogram.png")
    ok_snippet = copy_if_exists(snippet_src, fdir / "snippet.rb")
    ok_metrics = copy_if_exists(sidecar_src, fdir / "metrics.json")
    ok_report = copy_if_exists(report, fdir / "report.md")

    d = sidecar.get("desktop", {}).get("stats", {})
    w = sidecar.get("web", {}).get("stats", {})
    rms_ratio = (w.get("rms", 0) / d["rms"]) if d.get("rms") else None
    peak_ratio = (w.get("peak", 0) / d["peak"]) if d.get("peak") else None

    return {
        "name": name,
        "duration_ms": sidecar.get("duration"),
        "code_first_line": sidecar.get("code", "").split("\n")[0],
        "desktop": d,
        "web": w,
        "rms_ratio": rms_ratio,
        "peak_ratio": peak_ratio,
        "l2_mel_db": spec.get("l2_mel_db"),
        "mfcc_distance": spec.get("mfcc_distance"),
        "frames_compared": spec.get("frames_compared"),
        "desktop_peak_freq_hz": spec.get("desktop_peak_freq_hz"),
        "web_peak_freq_hz": spec.get("web_peak_freq_hz"),
        "artifacts": {
            "desktop_wav": f"e2e/{name}/desktop.wav" if ok_desktop else None,
            "web_wav": f"e2e/{name}/web.wav" if ok_web else None,
            "spectrogram": f"e2e/{name}/spectrogram.png" if ok_spec else None,
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
        f'<img src="{a["spectrogram"]}" alt="{name} spectrogram" loading="lazy" />'
        if a["spectrogram"]
        else '<div class="no-spec">no spectrogram</div>'
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
    return f"""
    <section class="fixture" id="{name}">
      <header>
        <h2>{name}</h2>
        <div class="ratios">
          <span>RMS× <b class="{rms_class}">{fmt_ratio(entry["rms_ratio"])}</b></span>
          <span>peak× <b class="{peak_class}">{fmt_ratio(entry["peak_ratio"])}</b></span>
          <span>MFCC <b>{entry["mfcc_distance"]:.0f}</b></span>
          <span>L2 dB <b>{entry["l2_mel_db"]:.1f}</b></span>
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
    margin: 0; padding: 24px 48px; line-height: 1.5; max-width: 1280px; margin: 0 auto;
  }}
  h1 {{ color: var(--accent); margin: 0 0 8px; }}
  h2 {{ margin: 0; color: var(--text); }}
  h3 {{ margin: 0 0 8px; color: var(--text-dim); font-size: 13px; font-weight: 600; }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  small {{ color: var(--text-dim); display: block; margin-top: 6px; font-family: var(--mono); font-size: 11px; }}
  .nav {{ margin: 12px 0 24px; padding: 12px 16px; background: var(--bg2); border-radius: 6px; }}
  .nav a {{ margin-right: 16px; }}
  .summary {{ background: var(--bg2); padding: 16px 20px; border-radius: 8px; margin-bottom: 32px; }}
  table.overview {{ width: 100%; border-collapse: collapse; margin: 12px 0; font-family: var(--mono); font-size: 12px; }}
  table.overview th, table.overview td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #2c3147; }}
  table.overview th {{ color: var(--text-dim); font-weight: 500; }}
  .good {{ color: var(--good); font-weight: 600; }}
  .mid {{ color: var(--mid); font-weight: 600; }}
  .bad {{ color: var(--bad); font-weight: 600; }}
  .fixture {{ background: var(--bg2); border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }}
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
</style>
</head>
<body>
<h1>E2E Composition Suite — A/B Inspector</h1>
<div class="nav">
  <a href="index.html">← FX inspector</a>
  <a href="raw-lpf.html">raw-lpf investigation →</a>
</div>
<div class="summary">
  <h2>Summary</h2>
  {summary}
</div>
{cards}
<footer style="text-align: center; padding: 24px 0; color: var(--text-dim); font-size: 11px;">
  Generated by <code>tools/build-e2e-results.py</code>. Source data: <code>.captures/e2e-sweep/</code>.
</footer>
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
    print(f"[e2e-builder] open: file://{OUT_HTML}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
