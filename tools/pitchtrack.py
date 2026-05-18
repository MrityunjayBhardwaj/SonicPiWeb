#!/usr/bin/env python3
"""Tier-1 pitch-track: per-note dominant-frequency → MIDI sequence + tempo.

The musical-correctness verdict for desktop↔web audio comparison. Energy/MFCC
aggregates are blind to a wrong melody (catalogue SP93) and confounded by the
known ~0.5× web gain-staging and reverb-tail length — so the note SEQUENCE and
inter-onset TEMPO are the verdict, not RMS/MFCC.

Usage:  python3 tools/pitchtrack.py <wav>            # human-readable
        python3 tools/pitchtrack.py --json <wav>     # machine (comparator)
"""
import sys, json, numpy as np, wave

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def load(path):
    w = wave.open(path, 'rb')
    sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
    a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64)
    if ch == 2:
        a = a.reshape(-1, 2).mean(axis=1)
    a /= (np.abs(a).max() or 1.0)          # normalise away the 0.5× gain delta
    return a, sr


def f2midi(f):
    return None if f <= 0 else int(round(69 + 12 * np.log2(f / 440.0)))


def name(m):
    return None if m is None else f"{NAMES[m % 12]}{m // 12 - 1}"


def _onsets(a, sr, min_gap):
    """Energy-rise onsets with a minimum gap (seconds)."""
    hop = int(sr * 0.01)
    env = np.array([np.sqrt(np.mean(a[i:i + hop] ** 2))
                    for i in range(0, len(a) - hop, hop)])
    env /= (env.max() or 1.0)
    out = []
    for i in range(2, len(env) - 1):
        if env[i] > 0.12 and env[i] > env[i - 1] and env[i - 2] < 0.10:
            t = i * hop / sr
            if not out or t - out[-1] > min_gap:
                out.append(t)
    return out


def estimate_note_dt(a, sr):
    """#348: derive the note grid from the signal instead of hardcoding 0.25s.
    Coarse onset pass (4ms gap) → median inter-onset, clamped to [0.05, 2.0]."""
    coarse = _onsets(a, sr, 0.04)
    if len(coarse) < 3:
        return 0.25
    iois = np.diff(coarse)
    return float(np.clip(np.median(iois), 0.05, 2.0))


def track(path, note_dt=None):
    """Onset-based pitch-track. note_dt auto-estimated from the signal when
    not given (#348 — removes the hardcoded-0.25s assumption)."""
    a, sr = load(path)
    if note_dt is None:
        note_dt = estimate_note_dt(a, sr)
    notes = []
    for t in _onsets(a, sr, note_dt * 0.6):
        s = int(t * sr)
        seg = a[s:s + int(note_dt * 0.8 * sr)]
        if len(seg) < 512:
            continue
        win = seg * np.hanning(len(seg))
        sp = np.abs(np.fft.rfft(win))
        fr = np.fft.rfftfreq(len(win), 1 / sr)
        m = (fr > 80) & (fr < 2000)
        f0 = float(fr[m][np.argmax(sp[m])])
        notes.append({'t': round(t, 3), 'hz': round(f0, 1), 'midi': f2midi(f0)})
    return notes, note_dt, sr, len(a) / sr


def _ac_pitch(seg, sr):
    """Autocorrelation f0 for one frame, 80–2000 Hz. 0 = unvoiced.
    Fundamental-biased: among all autocorr peaks above 0.5×max, pick the one
    at the LONGEST lag (lowest f0). Plain argmax picks a high harmonic on
    harmonically-rich synths (prophet/saw) → octave-up errors (#348)."""
    seg = seg - seg.mean()
    if np.sqrt(np.mean(seg ** 2)) < 1e-3:
        return 0.0
    ac = np.correlate(seg, seg, 'full')[len(seg) - 1:]
    lo, hi = int(sr / 2000), int(sr / 80)
    if hi >= len(ac) or hi <= lo:
        return 0.0
    band = ac[lo:hi]
    if band.max() < 0.3 * ac[0]:        # weak periodicity → unvoiced
        return 0.0
    thresh = 0.5 * band.max()
    # local maxima above threshold; choose the largest lag (the fundamental).
    cand = [k for k in range(1, len(band) - 1)
            if band[k] >= thresh and band[k] >= band[k - 1] and band[k] >= band[k + 1]]
    peak = lo + (max(cand) if cand else int(np.argmax(band)))
    return sr / peak


def contour(path):
    """#348: pitch-contour fallback for sustained / slow-attack material that
    has no sharp onsets. Per-frame autocorrelation → median-filter → segment
    runs of stable MIDI into notes."""
    a, sr = load(path)
    fl, hop = int(sr * 0.046), int(sr * 0.01)
    midis = []
    for i in range(0, len(a) - fl, hop):
        f0 = _ac_pitch(a[i:i + fl] * np.hanning(fl), sr)
        midis.append(f2midi(f0) if f0 > 0 else None)
    # 5-frame median smoothing over voiced frames
    sm = list(midis)
    for i in range(2, len(midis) - 2):
        w = [x for x in midis[i - 2:i + 3] if x is not None]
        sm[i] = int(np.median(w)) if w else None
    notes, run, start = [], None, 0
    voiced = sum(1 for x in sm if x is not None)
    framed = 0                                            # frames in stable runs
    for i, m in enumerate(sm + [None]):
        if m != run:
            if run is not None and i - start >= 6:        # ≥60ms stable
                framed += i - start
                t = start * hop / sr
                notes.append({'t': round(t, 3),
                              'hz': round(440 * 2 ** ((run - 69) / 12), 1),
                              'midi': run})
            run, start = m, i
    # Confidence = fraction of voiced frames that settled into a stable run.
    # Jittery octave/harmonic noise → low confidence → reported inconclusive.
    conf = round(framed / voiced, 2) if voiced else 0.0
    return notes, sr, len(a) / sr, conf


def analyse(path, note_dt=None):
    on, ndt, sr, dur = track(path, note_dt)
    method, conf = 'onset', 1.0
    # Expected note count is unknown; fall back to contour when onset yields
    # implausibly few notes for the signal length (sustained/legato material).
    if len(on) < max(2, dur / (ndt * 8)):
        cn, _, _, ccon = contour(path)
        if len(cn) > len(on):
            on, conf = cn, ccon
            method = 'contour' if ccon >= 0.6 else 'contour-low'
    iv = [round(on[i + 1]['t'] - on[i]['t'], 3) for i in range(len(on) - 1)]
    midi = [n['midi'] for n in on]
    return {
        'method': method,
        'confidence': conf,
        'inconclusive': method == 'contour-low',
        # Cheap autocorrelation contour is octave-unstable (period doubling) but
        # octave-CONSISTENT, so parity must compare pitch CLASSES in contour
        # mode (octave error cancels desktop↔web). onset mode stays exact-MIDI.
        'compare': 'pitch_class' if method.startswith('contour') else 'midi',
        'note_dt': round(ndt, 4),
        'count': len(on),
        'median_spacing_s': float(np.median(iv)) if iv else 0.0,
        'midi': midi,
        'pc': [m % 12 if m is not None else None for m in midi],
        'names': [name(m) for m in midi],
        'notes': on,
    }


if __name__ == '__main__':
    args = sys.argv[1:]
    as_json = '--json' in args

    def opt(flag):
        return float(args[args.index(flag) + 1]) if flag in args else None
    note_dt = opt('--note-dt')
    bpm = opt('--bpm')
    if note_dt is None and bpm:                 # one beat = the default grid
        note_dt = 60.0 / bpm
    pos = [x for i, x in enumerate(args)
           if not x.startswith('--')
           and (i == 0 or args[i - 1] not in ('--note-dt', '--bpm'))]
    r = analyse(pos[0], note_dt)
    if as_json:
        print(json.dumps(r))
    else:
        tag = f"[{r['method']} conf={r['confidence']}]"
        warn = '  ⚠ INCONCLUSIVE (sustained/noisy — not a Tier-1 verdict)' if r['inconclusive'] else ''
        print(f"{tag} {r['count']} notes, "
              f"median spacing {r['median_spacing_s']:.3f}s "
              f"(note_dt={r['note_dt']}s){warn}")
        print("MIDI:", r['midi'][:32])
        print("name:", r['names'][:16])
