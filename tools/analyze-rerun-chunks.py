#!/usr/bin/env python3
"""Split a continuous WAV into N equal chunks and report per-chunk band energy
and onset counts for each frequency band that maps to a DJ_Dave instrument:

  kick     : 40-120 Hz       (bd_tek body)
  snare    : 200-800 Hz      (drum_snare_hard fundamentals)
  cymbal_hi: 2000-6000 Hz    (drum_cymbal_closed shimmer)
  cymbal_vhi: 6000-12000 Hz  (cymbal/crash high)
  synthbass: 60-200 Hz       (tech_saws low)
  arp_mid  : 800-2000 Hz     (beep melody)

A track that goes silent in chunk N shows as a band-energy drop of >40% vs
chunk 1 in that band. Onset count also drops to 0.

Usage:
  python3 analyze-rerun-chunks.py <wav> <chunk_seconds> <num_chunks>
"""
from __future__ import annotations
import sys
import numpy as np
import wave

BANDS = {
    "kick":      (40, 120),
    "synthbass": (60, 200),
    "snare":     (200, 800),
    "arp_mid":   (800, 2000),
    "cymbal_hi": (2000, 6000),
    "cymbal_vhi":(6000, 12000),
}

def load_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(n)
    if sw == 4:
        dt = np.int32
    elif sw == 2:
        dt = np.int16
    else:
        dt = np.uint8
    a = np.frombuffer(raw, dtype=dt).astype(np.float32)
    if dt == np.int16:
        a /= 32768.0
    elif dt == np.int32:
        a /= 2147483648.0
    elif dt == np.uint8:
        a = (a - 128.0) / 128.0
    if ch == 2:
        a = a.reshape(-1, 2).mean(axis=1)
    return a, sr

def band_energy(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    n = len(x)
    if n == 0:
        return 0.0
    # rfft
    spec = np.fft.rfft(x * np.hanning(n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    mask = (freqs >= lo) & (freqs < hi)
    if not mask.any():
        return 0.0
    mag = np.abs(spec[mask])
    return float(np.sqrt((mag ** 2).mean()))

def onset_count(x: np.ndarray, sr: int, lo: float, hi: float, thr_mul: float = 1.6) -> int:
    """Simple onset detector inside a band: bandpass + envelope + peak-pick."""
    # bandpass via fft
    n = len(x)
    if n == 0:
        return 0
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    spec[(freqs < lo) | (freqs >= hi)] = 0
    bp = np.fft.irfft(spec, n=n)
    # envelope
    win = max(1, int(0.005 * sr))
    env = np.abs(bp)
    env = np.convolve(env, np.ones(win) / win, mode="same")
    # peaks above thr_mul × median
    thr = thr_mul * float(np.median(env) + 1e-9)
    # require local maximum + spacing of 30ms
    spacing = max(1, int(0.030 * sr))
    peaks = []
    last = -spacing
    for i in range(1, len(env) - 1):
        if env[i] > thr and env[i] > env[i - 1] and env[i] >= env[i + 1] and (i - last) >= spacing:
            peaks.append(i)
            last = i
    return len(peaks)

def main():
    wav_path, chunk_s, n_chunks = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
    a, sr = load_wav(wav_path)
    chunk_n = int(chunk_s * sr)
    total_frames = a.size
    print(f"loaded {wav_path}: {total_frames / sr:.2f}s @ {sr}Hz mono")
    print(f"requested {n_chunks} chunks of {chunk_s}s = {n_chunks * chunk_n} frames")
    print()

    # Each chunk starts at the Rec start (chunk 0) and steps by chunk_n.
    # If Rec includes pre-roll, chunk 0 may have less material — that's fine,
    # the user only cares about relative loss across chunks.
    rows = []
    for i in range(n_chunks):
        start = i * chunk_n
        end = min(start + chunk_n, total_frames)
        if end - start < sr // 2:
            print(f"chunk {i}: too short ({(end - start) / sr:.2f}s) — skipping")
            continue
        seg = a[start:end]
        row = {"chunk": i, "label": "Run#1" if i == 0 else f"Run#{i + 1}(hot-swap)"}
        row["rms"] = float(np.sqrt(np.mean(seg ** 2)))
        row["peak"] = float(np.max(np.abs(seg)))
        for name, (lo, hi) in BANDS.items():
            row[f"e_{name}"] = band_energy(seg, sr, lo, hi)
            row[f"n_{name}"] = onset_count(seg, sr, lo, hi)
        rows.append(row)

    # Print table
    if not rows:
        print("no chunks analysed")
        return 1
    base = rows[0]
    hdr = f"{'chunk':6} {'label':22} {'RMS':>7} {'peak':>6} | " + " | ".join(
        f"{k:>11}" for k in BANDS
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        cells = [f"{r['chunk']:<6}", f"{r['label']:<22}", f"{r['rms']:7.4f}", f"{r['peak']:6.3f}", "|"]
        for name in BANDS:
            e = r[f"e_{name}"]
            n = r[f"n_{name}"]
            be = base[f"e_{name}"]
            ratio = (e / be) if be > 1e-9 else 0.0
            mark = ""
            if r["chunk"] > 0:
                if be > 1e-6 and ratio < 0.4:
                    mark = " DROP"
                elif be > 1e-6 and ratio > 2.0:
                    mark = " SPIKE"
            cells.append(f"{e:5.3f}({n:>2}){mark:>6}")
        print(" ".join(cells))

    # Verdict
    print()
    drops = []
    for r in rows[1:]:
        for name in BANDS:
            be = base[f"e_{name}"]
            e = r[f"e_{name}"]
            if be > 1e-6 and (e / be) < 0.4:
                drops.append((r["chunk"], r["label"], name, e / be))
    if drops:
        print("VERDICT: TRACK LOSS DETECTED on hot-swap")
        for c, lab, n, ratio in drops:
            print(f"  chunk {c} ({lab}): band {n} fell to {ratio:.0%} of baseline")
        return 1
    print("VERDICT: no >60% band drop across chunks — tracks appear to survive hot-swap")
    return 0

if __name__ == "__main__":
    sys.exit(main())
