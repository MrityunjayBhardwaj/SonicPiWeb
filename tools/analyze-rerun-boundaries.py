#!/usr/bin/env python3
"""Slice the rerun WAV into fine windows around hot-swap boundaries and look
for short dropouts that 4s averaging hides.

Reports:
  - RMS per 100ms window for the full duration (timeline)
  - Per-band RMS at 200ms resolution for ±1s around each boundary (t=4,8,12)
  - Any window where RMS falls below 30% of the surrounding median

Usage:
  python3 analyze-rerun-boundaries.py <wav> [chunk_seconds=4]
"""
from __future__ import annotations
import sys
import numpy as np
import wave

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

def band_rms(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    if len(x) < 32: return 0.0
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    spec[(freqs < lo) | (freqs >= hi)] = 0
    y = np.fft.irfft(spec, n=len(x))
    return float(np.sqrt(np.mean(y ** 2)))

def main():
    wav = sys.argv[1]
    chunk_s = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    a, sr = load_wav(wav)
    dur = len(a) / sr
    print(f"loaded {wav}: {dur:.2f}s @ {sr}Hz")

    # 1. Timeline of overall RMS at 100ms resolution
    win = int(0.100 * sr)
    n_win = len(a) // win
    rms_timeline = np.array([
        np.sqrt(np.mean(a[i*win:(i+1)*win] ** 2)) for i in range(n_win)
    ])
    med = float(np.median(rms_timeline))
    low = rms_timeline < 0.3 * med
    low_idx = np.where(low)[0]
    print(f"\n[timeline] median RMS = {med:.4f}; low-RMS windows (< 30% median):")
    if low_idx.size == 0:
        print("  none")
    else:
        # cluster into runs
        clusters = []
        prev = -10
        cur = []
        for i in low_idx:
            if i - prev <= 2:
                cur.append(i)
            else:
                if cur: clusters.append(cur)
                cur = [i]
            prev = i
        if cur: clusters.append(cur)
        for c in clusters[:30]:
            t0, t1 = c[0] * 0.1, (c[-1] + 1) * 0.1
            print(f"  {t0:6.2f}-{t1:6.2f}s  (RMS dips to {rms_timeline[c].min():.4f})")

    # 2. Per-band RMS at 200ms resolution around boundaries
    boundaries = [chunk_s * i for i in range(1, int(dur // chunk_s) + 1)]
    bwin = int(0.200 * sr)
    pre_post = 1.0  # +/- 1s around each boundary
    n_steps = int(pre_post * 2 / 0.2)
    print(f"\n[boundary scan] ±{pre_post}s around each Run-click at 200ms resolution:")
    for b in boundaries:
        if b > dur - pre_post: continue
        print(f"\n  boundary t={b:.2f}s (hot-swap click)")
        hdr = f"    {'t(s)':>6} " + " ".join(f"{k:>8}" for k in BANDS)
        print(hdr)
        for s in range(n_steps + 1):
            t0 = b - pre_post + s * 0.2
            i0 = int(t0 * sr)
            if i0 < 0 or i0 + bwin > len(a): continue
            seg = a[i0:i0 + bwin]
            row = f"    {t0:>6.2f} "
            for name, (lo, hi) in BANDS.items():
                row += f" {band_rms(seg, sr, lo, hi):8.5f}"
            mark = "  <-- click" if abs(t0 - b) < 0.1 else ""
            print(row + mark)

if __name__ == "__main__":
    main()
