#!/usr/bin/env python3
"""
Harmonic content analysis for the SP108 raw-ugen test (issue #417).

For each WAV: crest factor (peak/RMS) + the magnitude of the fundamental and its
first N harmonics from an FFT of a steady mid-segment.

A pure sine ⇒ crest ≈ 1.414, single peak at f0, harmonics << fundamental.
A band-limited saw ⇒ crest ≈ 2.0+, harmonics following a ~1/n series.

Usage: python3 tools/harmonic-analysis.py <f0> file1.wav [file2.wav ...]
"""
import sys, wave, struct
import numpy as np


def read_wav(path):
    w = wave.open(path, 'rb')
    n, ch, sr, sw = w.getnframes(), w.getnchannels(), w.getframerate(), w.getsampwidth()
    raw = w.readframes(n)
    w.close()
    if sw != 2:
        raise SystemExit(f'{path}: expected 16-bit PCM, got {sw*8}-bit')
    data = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
    data = data.reshape(-1, ch)
    return data, sr, ch


def analyze(path, f0):
    data, sr, ch = read_wav(path)
    # pick the louder channel (mono-left bug awareness, SP107)
    rms_ch = [np.sqrt(np.mean(data[:, c] ** 2)) for c in range(ch)]
    c = int(np.argmax(rms_ch))
    x = data[:, c]
    # steady mid-segment: middle 50%
    s, e = int(len(x) * 0.25), int(len(x) * 0.75)
    seg = x[s:e]
    seg = seg[: (len(seg) // 2) * 2]
    if len(seg) < sr // 4:
        print(f'{path}: too short / silent (len={len(seg)})'); return
    peak = float(np.max(np.abs(seg)))
    rms = float(np.sqrt(np.mean(seg ** 2)))
    crest = peak / rms if rms > 0 else float('nan')

    # FFT magnitude spectrum (Hann window)
    win = np.hanning(len(seg))
    sp = np.abs(np.fft.rfft(seg * win))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    binhz = freqs[1] - freqs[0]

    def mag_at(f):
        if f >= sr / 2:
            return 0.0
        center = int(round(f / binhz))
        lo, hi = max(0, center - 3), min(len(sp), center + 4)
        return float(np.max(sp[lo:hi]))

    fund = mag_at(f0)
    print(f'\n{path}  (ch={c}, sr={sr})')
    print(f'  crest factor (peak/RMS) = {crest:.3f}   [sine≈1.414, saw≈2.0+]   peak={peak:.3f} rms={rms:.4f}')
    if fund <= 0:
        print('  fundamental is zero — silent or wrong f0'); return
    print(f'  harmonic series (relative to H1):')
    energy_above = 0.0
    for h in range(1, 13):
        m = mag_at(f0 * h)
        rel = m / fund
        bar = '#' * int(min(40, rel * 40))
        ideal = 1.0 / h  # ideal saw 1/n
        print(f'   H{h:2d} {f0*h:7.1f}Hz  {rel:6.3f}  {bar:<40} (saw ideal {ideal:.3f})')
        if h >= 2:
            energy_above += m * m
    thd_like = np.sqrt(energy_above) / fund
    print(f'  sum(H2..H12)/H1 (harmonic richness) = {thd_like:.3f}   [pure sine≈0, saw≫0]')


def main():
    if len(sys.argv) < 3:
        raise SystemExit('usage: harmonic-analysis.py <f0> file.wav ...')
    f0 = float(sys.argv[1])
    for p in sys.argv[2:]:
        analyze(p, f0)


if __name__ == '__main__':
    main()
