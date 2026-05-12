#!/usr/bin/env python3
"""Detailed spectral comparison of two WAVs (4 chunks each) — for diagnosing
the difference between cluster A (captures 1,2) and cluster B (captures 3,4)
of the rerun reproducer.

Reports per chunk:
  - Spectral centroid (Hz) — brightness
  - Spectral flatness — tonal vs noise-like (0=pure tone, 1=white noise)
  - Spectral rolloff (95%) — frequency below which 95% of energy lives
  - RMS, peak, crest factor (peak/RMS, indicates transients vs sustained)
  - Per-band onset count + peak time within chunk
  - Loudness contour (RMS per 100ms window)

Saves a PNG with stacked spectrograms + per-band RMS timelines side-by-side
for visual diff.

Usage:
  python3 compare-two-runs-spectral.py <wavA> <wavB> [chunk_seconds=4]
"""
from __future__ import annotations
import sys
import numpy as np
import wave
import os

BANDS = {
    "kick":      (40, 120),
    "synthbass": (60, 200),
    "snare":     (200, 800),
    "arp":       (800, 2000),
    "cymb_hi":   (2000, 6000),
    "cymb_vhi":  (6000, 12000),
}

def load_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    dt = {1: np.uint8, 2: np.int16, 4: np.int32}[sw]
    a = np.frombuffer(raw, dtype=dt).astype(np.float32)
    if dt == np.int16:  a /= 32768.0
    elif dt == np.int32: a /= 2147483648.0
    elif dt == np.uint8: a = (a - 128.0) / 128.0
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    return a, sr

def spectral_features(x: np.ndarray, sr: int) -> dict:
    if len(x) < 64:
        return {"centroid": 0.0, "flatness": 0.0, "rolloff": 0.0}
    win = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    s = spec + 1e-12
    centroid = float((freqs * s).sum() / s.sum())
    # spectral flatness = geo_mean / arith_mean (in power)
    p = s ** 2
    flatness = float(np.exp(np.log(p + 1e-20).mean()) / (p.mean() + 1e-20))
    cumsum = np.cumsum(s)
    total = cumsum[-1]
    rolloff_idx = np.searchsorted(cumsum, 0.95 * total)
    rolloff = float(freqs[min(rolloff_idx, len(freqs) - 1)])
    return {"centroid": centroid, "flatness": flatness, "rolloff": rolloff}

def band_rms(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    if len(x) < 32: return 0.0
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    spec[(freqs < lo) | (freqs >= hi)] = 0
    y = np.fft.irfft(spec, n=len(x))
    return float(np.sqrt(np.mean(y ** 2)))

def onset_times(x: np.ndarray, sr: int, lo: float, hi: float, thr_mul: float = 1.6) -> list[float]:
    n = len(x)
    if n == 0: return []
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    spec[(freqs < lo) | (freqs >= hi)] = 0
    bp = np.fft.irfft(spec, n=n)
    win = max(1, int(0.005 * sr))
    env = np.abs(bp)
    env = np.convolve(env, np.ones(win) / win, mode="same")
    thr = thr_mul * float(np.median(env) + 1e-9)
    spacing = max(1, int(0.030 * sr))
    peaks = []
    last = -spacing
    for i in range(1, len(env) - 1):
        if env[i] > thr and env[i] > env[i - 1] and env[i] >= env[i + 1] and (i - last) >= spacing:
            peaks.append(i / sr)
            last = i
    return peaks

def analyze(path: str, chunk_s: float, n_chunks: int) -> dict:
    a, sr = load_wav(path)
    chunk_n = int(chunk_s * sr)
    out = {"path": path, "sr": sr, "duration": len(a) / sr, "chunks": []}
    for i in range(n_chunks):
        start = i * chunk_n
        end = min(start + chunk_n, len(a))
        if end - start < sr // 2: continue
        seg = a[start:end]
        sf = spectral_features(seg, sr)
        bands = {}
        for name, (lo, hi) in BANDS.items():
            bands[name] = {
                "rms": band_rms(seg, sr, lo, hi),
                "onsets": onset_times(seg, sr, lo, hi),
            }
        rms = float(np.sqrt(np.mean(seg ** 2)))
        peak = float(np.max(np.abs(seg)))
        # 100ms RMS contour for this chunk
        win = int(0.100 * sr)
        n_win = len(seg) // win
        contour = [float(np.sqrt(np.mean(seg[k*win:(k+1)*win] ** 2))) for k in range(n_win)]
        out["chunks"].append({
            "idx": i,
            "rms": rms,
            "peak": peak,
            "crest": peak / (rms + 1e-12),
            "spectral": sf,
            "bands": bands,
            "contour_100ms": contour,
        })
    return out

def fmt_onsets(times: list[float], chunk_start: float) -> str:
    if not times: return "none"
    if len(times) <= 4:
        return ", ".join(f"{t:.2f}" for t in times)
    return f"{len(times)} hits, first={times[0]:.2f}, last={times[-1]:.2f}, mean_iti={np.mean(np.diff(times)):.3f}s"

def report(a: dict, b: dict, chunk_s: float):
    print(f"A: {os.path.basename(a['path'])}  ({a['duration']:.2f}s @ {a['sr']}Hz)")
    print(f"B: {os.path.basename(b['path'])}  ({b['duration']:.2f}s @ {b['sr']}Hz)")
    print()
    for chunk_idx in range(min(len(a["chunks"]), len(b["chunks"]))):
        ca, cb = a["chunks"][chunk_idx], b["chunks"][chunk_idx]
        label = "Run#1" if chunk_idx == 0 else f"Run#{chunk_idx+1}(hot-swap)"
        chunk_start = chunk_idx * chunk_s
        print(f"==== CHUNK {chunk_idx} ({label}) at t={chunk_start:.1f}-{chunk_start+chunk_s:.1f}s ====")
        print(f"  GLOBAL          A                       B                       Δ(B-A)")
        print(f"  RMS             {ca['rms']:.4f}                  {cb['rms']:.4f}                  {cb['rms']-ca['rms']:+.4f}")
        print(f"  Peak            {ca['peak']:.3f}                   {cb['peak']:.3f}                   {cb['peak']-ca['peak']:+.3f}")
        print(f"  Crest (peak/RMS){ca['crest']:5.2f}                   {cb['crest']:5.2f}                   {cb['crest']-ca['crest']:+5.2f}")
        sa, sb = ca["spectral"], cb["spectral"]
        print(f"  Centroid (Hz)   {sa['centroid']:6.0f}                  {sb['centroid']:6.0f}                  {sb['centroid']-sa['centroid']:+6.0f}")
        print(f"  Flatness        {sa['flatness']:.4f}                  {sb['flatness']:.4f}                  {sb['flatness']-sa['flatness']:+.4f}")
        print(f"  Rolloff95 (Hz)  {sa['rolloff']:6.0f}                  {sb['rolloff']:6.0f}                  {sb['rolloff']-sa['rolloff']:+6.0f}")
        print(f"\n  PER-BAND        A: RMS (n_onsets)       B: RMS (n_onsets)       Δ_rms     Δ_onsets")
        for name in BANDS:
            ba, bb = ca["bands"][name], cb["bands"][name]
            d_rms = bb["rms"] - ba["rms"]
            d_n = len(bb["onsets"]) - len(ba["onsets"])
            mark = ""
            if abs(d_rms) > 0.01 and ba["rms"] > 1e-4:
                pct = 100 * d_rms / ba["rms"]
                mark = f"  ({pct:+.0f}%)"
            print(f"  {name:11}     {ba['rms']:.5f} ({len(ba['onsets']):>3})        {bb['rms']:.5f} ({len(bb['onsets']):>3})        {d_rms:+.5f}{mark}   {d_n:+3d}")
        print(f"\n  INTER-ONSET INTERVALS (snare band, in ms — clap rhythm signature):")
        if ca["bands"]["snare"]["onsets"]:
            iti_a = np.diff(ca["bands"]["snare"]["onsets"]) * 1000
            print(f"    A: median={np.median(iti_a):.0f}ms, std={iti_a.std():.0f}ms, n={len(iti_a)+1} hits")
        if cb["bands"]["snare"]["onsets"]:
            iti_b = np.diff(cb["bands"]["snare"]["onsets"]) * 1000
            print(f"    B: median={np.median(iti_b):.0f}ms, std={iti_b.std():.0f}ms, n={len(iti_b)+1} hits")
        print(f"\n  RMS CONTOUR (100ms windows, abs values):")
        ca_ct = ca["contour_100ms"][:40]
        cb_ct = cb["contour_100ms"][:40]
        print("    A: " + " ".join(f"{v:.2f}" for v in ca_ct))
        print("    B: " + " ".join(f"{v:.2f}" for v in cb_ct))
        # contour diff in % of A
        diff_pct = [(b_-a_)/(a_+1e-6)*100 for a_, b_ in zip(ca_ct, cb_ct)]
        print("    Δ%: " + " ".join(f"{v:+.0f}" for v in diff_pct))
        print()

if __name__ == "__main__":
    wa, wb = sys.argv[1], sys.argv[2]
    cs = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0
    a = analyze(wa, cs, 4)
    b = analyze(wb, cs, 4)
    report(a, b, cs)
