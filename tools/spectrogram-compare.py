#!/usr/bin/env python3
"""
Side-by-side spectrogram comparison for desktop ↔ web parity.

Inputs:  two WAV file paths (desktop, web)
Outputs:
  - <out>.png    side-by-side mel-spectrograms (desktop | web | diff)
  - <out>.json   {l2_distance, mfcc_distance, peak_freq_*, per_beat: [...], ...}

Per-beat windowed analysis fires when --beats N (and optionally --bpm M)
are given. Each window is `60/bpm` seconds wide, sliced from t=0. For
each beat we record per-side RMS, peak, and MFCC vector; cross-side we
record an L2 distance per beat. A second PNG (`<out>_perbeat.png`) plots
the per-beat distance bar chart and per-beat RMS comparison.

Usage:
  python3 tools/spectrogram-compare.py <desktop.wav> <web.wav> <out-prefix>
                                       [--bpm 120] [--beats 16]

Called by tools/compare-desktop-vs-web.ts. Standalone-runnable for ad-hoc use.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from scipy.io import wavfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

try:
    import librosa
    import librosa.display
except ImportError:
    os.system("pip3 install librosa")
    import librosa
    import librosa.display


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

N_MELS = 128
N_FFT = 2048
HOP_LENGTH = 512


def load_mono(path: str) -> tuple[np.ndarray, int]:
    """Load WAV, downmix to mono float32 in [-1, 1]."""
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    else:
        data = data.astype(np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return data, sr


def mel_db(audio: np.ndarray, sr: int) -> np.ndarray:
    spec = librosa.feature.melspectrogram(
        y=audio, sr=sr, n_mels=N_MELS, n_fft=N_FFT, hop_length=HOP_LENGTH
    )
    return librosa.power_to_db(spec, ref=np.max)


def mfcc_distance(a: np.ndarray, sr_a: int, b: np.ndarray, sr_b: int) -> float:
    """Mean Euclidean distance between MFCC frames after length alignment.

    A small distance (< 30) means broadly similar timbral envelope. Values
    over ~80 mean very different content."""
    mfcc_a = librosa.feature.mfcc(y=a, sr=sr_a, n_mfcc=13)
    mfcc_b = librosa.feature.mfcc(y=b, sr=sr_b, n_mfcc=13)
    # Align lengths — truncate to the shorter
    n = min(mfcc_a.shape[1], mfcc_b.shape[1])
    if n == 0:
        return float("nan")
    return float(np.mean(np.linalg.norm(mfcc_a[:, :n] - mfcc_b[:, :n], axis=0)))


def l2_spectral_distance(mel_a: np.ndarray, mel_b: np.ndarray) -> float:
    """Per-frame L2 distance, averaged. Both inputs are mel-dB matrices."""
    n = min(mel_a.shape[1], mel_b.shape[1])
    if n == 0:
        return float("nan")
    diff = mel_a[:, :n] - mel_b[:, :n]
    return float(np.sqrt(np.mean(diff * diff)))


def peak_frequency(audio: np.ndarray, sr: int) -> float:
    """Dominant frequency from the average magnitude spectrum (Hz)."""
    spec = np.abs(np.fft.rfft(audio))
    freqs = np.fft.rfftfreq(len(audio), 1 / sr)
    if spec.sum() == 0:
        return 0.0
    return float(freqs[int(np.argmax(spec))])


# ---------------------------------------------------------------------------
# Precondition probes (SV29 candidate)
#
# l2_spectral_distance, mfcc_distance, and per_beat_compare all silently
# assume the two WAVs share signal shape — similar onset density, similar
# tempo, similar total energy. When that assumption is violated (codec
# round-trip damage, use_bpm scope leak, stuck-renderer artifact, etc.)
# the metrics still return a number, but it answers a different question
# than the caller meant. The probes below detect three common violation
# classes BEFORE the score-bearing metrics run, so the comparator can
# refuse to interpret a confounded comparison.
# ---------------------------------------------------------------------------

def _envelope_at_hop(audio: np.ndarray, sr: int, hop_s: float) -> np.ndarray:
    """RMS envelope at hop_s seconds, smoothed over the same window."""
    win = max(1, int(hop_s * sr))
    smoothed = np.sqrt(np.convolve(audio.astype(np.float64) ** 2, np.ones(win) / win, mode="same"))
    step = max(1, int(sr * hop_s))
    return smoothed[::step]


def count_onset_clusters(audio: np.ndarray, sr: int, hop_s: float = 0.005) -> int:
    """Count distinct hit clusters in audio.

    Envelope-cluster onset count: rising edges through 30% of the max
    envelope value, then merge edges within 100ms into one cluster (the
    envelope rise of a single drum hit can spawn several adjacent edges).
    Returns 0 for silent or near-silent input.
    """
    env = _envelope_at_hop(audio, sr, hop_s)
    if env.size == 0:
        return 0
    peak = float(env.max())
    if peak < 1e-4:
        return 0
    above = env > peak * 0.30
    edges = np.where(np.diff(above.astype(np.int8)) > 0)[0]
    if edges.size == 0:
        return 0
    clusters = 1
    last = edges[0]
    merge_gap_steps = max(1, int(0.1 / hop_s))
    for e in edges[1:]:
        if e - last >= merge_gap_steps:
            clusters += 1
        last = e
    return clusters


def envelope_best_lag_ms(audio_d: np.ndarray, audio_w: np.ndarray, sr: int, hop_s: float = 0.01) -> float:
    """Best alignment lag (ms) between two RMS envelopes via cross-correlation.

    Both inputs must be at the same sample rate. Returns the absolute lag at
    which the cross-correlation peaks; 0 means perfect time alignment, large
    values mean one side leads/lags the other (tempo divergence, dropped
    leading silence, etc.). Computed on a 10ms-hop envelope so the FFT cost
    is small even for multi-second WAVs.
    """
    env_d = _envelope_at_hop(audio_d, sr, hop_s)
    env_w = _envelope_at_hop(audio_w, sr, hop_s)
    n = min(env_d.size, env_w.size)
    if n < 4:
        return 0.0
    a = env_d[:n] - env_d[:n].mean()
    b = env_w[:n] - env_w[:n].mean()
    if not np.any(a) or not np.any(b):
        return 0.0
    xc = np.correlate(a, b, mode="full")
    best = int(np.argmax(xc))
    lag_steps = best - (n - 1)
    return float(abs(lag_steps) * hop_s * 1000.0)


def verify_preconditions(
    audio_d: np.ndarray, sr_d: int, audio_w: np.ndarray, sr_w: int,
) -> dict:
    """Run three precondition probes; report per-probe pass/fail + summary.

    Probes (cheap, run in ~tens of ms on a few-second WAV):
      1. onset_count  — distinct hit clusters per side, ratio in [0.7, 1.4].
                        Catches tempo divergence, dropped events, doubled events.
                        Skipped (probe marked `skipped`) when both sides have
                        fewer than 3 hits — sample size too small to test.
      2. envelope_lag — best cross-correlation lag of RMS envelopes ≤ 100ms.
                        Catches drift, leading-silence mismatch, gross tempo
                        misalignment.
      3. energy_x_duration — (RMS² · duration) ratio in [0.5, 2.0].
                        Catches large total-energy divergence (silent side,
                        codec damage that drops energy non-uniformly).

    A probe is `ok=true` when within tolerance, `ok=false` (and named in
    `failed`) when out. `skipped=true` means the probe didn't have enough
    signal to test reliably and is not counted as a violation.

    Caller: spectrogram-compare main() — embeds the result in the JSON output
    as `comparison.preconditions`. When `violated=true`, downstream consumers
    should refuse to interpret the L2/MFCC/per-beat numbers as a parity score.
    """
    # Onsets — count per side (assumes sample rates are already normalized
    # by the caller, which they are at the call site below).
    n_d = count_onset_clusters(audio_d, sr_d)
    n_w = count_onset_clusters(audio_w, sr_w)
    if n_d < 3 and n_w < 3:
        onset_probe = {
            "desktop_hits": int(n_d),
            "web_hits": int(n_w),
            "ratio": None,
            "tolerance": "[0.7, 1.4]",
            "ok": True,
            "skipped": True,
            "skip_reason": "fewer than 3 hits on both sides — sample too small",
        }
    else:
        onset_ratio = (n_w + 1e-6) / (n_d + 1e-6)
        onset_ok = 0.7 <= onset_ratio <= 1.4
        onset_probe = {
            "desktop_hits": int(n_d),
            "web_hits": int(n_w),
            "ratio": round(onset_ratio, 3),
            "tolerance": "[0.7, 1.4]",
            "ok": bool(onset_ok),
            "skipped": False,
        }

    # Envelope lag — sample rates are normalized at the call site, so we
    # can pass the same sr to both.
    lag_ms = envelope_best_lag_ms(audio_d, audio_w, sr_d)
    lag_ok = lag_ms <= 100.0
    lag_probe = {
        "best_lag_ms": round(lag_ms, 1),
        "tolerance_ms": 100,
        "ok": bool(lag_ok),
        "skipped": False,
    }

    # Energy × duration — silent or much-quieter side flags as violation.
    rms_d = float(np.sqrt(np.mean(audio_d.astype(np.float64) ** 2)))
    rms_w = float(np.sqrt(np.mean(audio_w.astype(np.float64) ** 2)))
    dur_d = float(audio_d.size / sr_d) if sr_d else 0.0
    dur_w = float(audio_w.size / sr_w) if sr_w else 0.0
    e_d = rms_d * rms_d * dur_d
    e_w = rms_w * rms_w * dur_w
    if e_d < 1e-9 and e_w < 1e-9:
        energy_probe = {
            "desktop": round(e_d, 9),
            "web": round(e_w, 9),
            "ratio": None,
            "tolerance": "[0.5, 2.0]",
            "ok": True,
            "skipped": True,
            "skip_reason": "both sides effectively silent — no energy to compare",
        }
    else:
        energy_ratio = (e_w + 1e-9) / (e_d + 1e-9)
        energy_ok = 0.5 <= energy_ratio <= 2.0
        energy_probe = {
            "desktop": round(e_d, 9),
            "web": round(e_w, 9),
            "ratio": round(energy_ratio, 3),
            "tolerance": "[0.5, 2.0]",
            "ok": bool(energy_ok),
            "skipped": False,
        }

    probes = {
        "onset_count": onset_probe,
        "envelope_lag": lag_probe,
        "energy_x_duration": energy_probe,
    }
    failed = [k for k, v in probes.items() if not v["ok"] and not v.get("skipped")]
    return {
        "probes": probes,
        "violated": len(failed) > 0,
        "failed": failed,
    }


def slice_beats(audio: np.ndarray, sr: int, bpm: float, beats: int) -> list[np.ndarray]:
    """Slice audio into `beats` windows of (60/bpm) seconds each, from t=0.

    If audio is shorter than the full grid, the last few windows may be empty
    or partial — we pad with silence so MFCC frame count stays consistent."""
    samples_per_beat = int(round(sr * 60.0 / bpm))
    out: list[np.ndarray] = []
    for k in range(beats):
        start = k * samples_per_beat
        end = start + samples_per_beat
        if start >= len(audio):
            out.append(np.zeros(samples_per_beat, dtype=np.float32))
        else:
            window = audio[start:end]
            if len(window) < samples_per_beat:
                window = np.concatenate(
                    [window, np.zeros(samples_per_beat - len(window), dtype=audio.dtype)]
                )
            out.append(window)
    return out


def per_beat_compare(
    audio_d: np.ndarray, sr_d: int,
    audio_w: np.ndarray, sr_w: int,
    bpm: float, beats: int,
) -> dict:
    """Slice both audios at the beat grid; compute per-beat RMS, peak, and
    cross-side MFCC distance. Both sides must use the same beat grid; if
    sample rates differ we resample web → desktop sample rate first."""
    if sr_w != sr_d:
        audio_w = librosa.resample(audio_w.astype(np.float32), orig_sr=sr_w, target_sr=sr_d)
        sr_w = sr_d

    bins_d = slice_beats(audio_d, sr_d, bpm, beats)
    bins_w = slice_beats(audio_w, sr_w, bpm, beats)

    rows = []
    for k in range(beats):
        d, w = bins_d[k], bins_w[k]
        d_rms = float(np.sqrt(np.mean(d * d))) if len(d) else 0.0
        w_rms = float(np.sqrt(np.mean(w * w))) if len(w) else 0.0
        d_peak = float(np.max(np.abs(d))) if len(d) else 0.0
        w_peak = float(np.max(np.abs(w))) if len(w) else 0.0
        # MFCC distance for this beat — if either is silent, distance is the
        # other's overall MFCC norm (i.e. "max possible" for present-vs-silent).
        try:
            mfcc_d = librosa.feature.mfcc(y=d, sr=sr_d, n_mfcc=13)
            mfcc_w = librosa.feature.mfcc(y=w, sr=sr_d, n_mfcc=13)
            n = min(mfcc_d.shape[1], mfcc_w.shape[1])
            mfcc_dist = float(np.mean(np.linalg.norm(mfcc_d[:, :n] - mfcc_w[:, :n], axis=0))) if n > 0 else float("nan")
        except Exception:
            mfcc_dist = float("nan")
        rows.append({
            "beat": k,
            "desktop_rms": round(d_rms, 4),
            "web_rms": round(w_rms, 4),
            "desktop_peak": round(d_peak, 4),
            "web_peak": round(w_peak, 4),
            "mfcc_distance": round(mfcc_dist, 2) if not np.isnan(mfcc_dist) else None,
        })
    # Identify the most divergent beats (top 3 by MFCC distance)
    valid = [r for r in rows if r["mfcc_distance"] is not None]
    most_divergent = sorted(valid, key=lambda r: r["mfcc_distance"], reverse=True)[:3]
    return {
        "bpm": bpm,
        "beats": beats,
        "rows": rows,
        "most_divergent_beats": [r["beat"] for r in most_divergent],
        "mean_per_beat_mfcc_distance": (
            float(np.mean([r["mfcc_distance"] for r in valid])) if valid else float("nan")
        ),
    }


def plot_per_beat(per_beat: dict, out_png: str) -> None:
    rows = per_beat["rows"]
    beats = [r["beat"] for r in rows]
    d_rms = [r["desktop_rms"] for r in rows]
    w_rms = [r["web_rms"] for r in rows]
    mfcc = [r["mfcc_distance"] if r["mfcc_distance"] is not None else 0 for r in rows]

    fig, axes = plt.subplots(2, 1, figsize=(max(8, len(beats) * 0.5), 6), constrained_layout=True)

    # Top: per-beat RMS comparison
    width = 0.4
    x = np.arange(len(beats))
    axes[0].bar(x - width / 2, d_rms, width, label="Desktop", color="#444")
    axes[0].bar(x + width / 2, w_rms, width, label="Web", color="#cc4444")
    axes[0].set_xticks(x)
    axes[0].set_xticklabels(beats)
    axes[0].set_xlabel("Beat index")
    axes[0].set_ylabel("RMS")
    axes[0].set_title(f"Per-beat RMS (bpm={per_beat['bpm']}, beats={per_beat['beats']})")
    axes[0].legend()

    # Bottom: per-beat MFCC distance
    axes[1].bar(x, mfcc, color="#aa4488")
    axes[1].axhline(30, color="green", linestyle="--", linewidth=0.8, label="≤30 similar")
    axes[1].axhline(80, color="red", linestyle="--", linewidth=0.8, label=">80 unrelated")
    axes[1].set_xticks(x)
    axes[1].set_xticklabels(beats)
    axes[1].set_xlabel("Beat index")
    axes[1].set_ylabel("MFCC distance")
    axes[1].set_title("Per-beat MFCC distance (timbre divergence)")
    axes[1].legend(loc="upper right")

    fig.savefig(out_png, dpi=110)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> tuple[str, str, str, float | None, int | None]:
    if len(argv) < 4:
        return ("", "", "", None, None)
    desktop_path, web_path, out_prefix = argv[1], argv[2], argv[3]
    bpm: float | None = None
    beats: int | None = None
    i = 4
    while i < len(argv):
        if argv[i] == "--bpm":
            bpm = float(argv[i + 1])
            i += 2
        elif argv[i] == "--beats":
            beats = int(argv[i + 1])
            i += 2
        else:
            i += 1
    if beats is not None and bpm is None:
        bpm = 60.0  # Sonic Pi default
    return desktop_path, web_path, out_prefix, bpm, beats


def main() -> int:
    desktop_path, web_path, out_prefix, bpm, beats = parse_args(sys.argv)
    if not desktop_path:
        print(
            "Usage: spectrogram-compare.py <desktop.wav> <web.wav> <out-prefix> [--bpm N] [--beats K]",
            file=sys.stderr,
        )
        return 1
    out_png = f"{out_prefix}.png"
    out_json = f"{out_prefix}.json"

    if not os.path.exists(desktop_path):
        print(f"Desktop WAV not found: {desktop_path}", file=sys.stderr)
        return 1
    if not os.path.exists(web_path):
        print(f"Web WAV not found: {web_path}", file=sys.stderr)
        return 1

    audio_d, sr_d_raw = load_mono(desktop_path)
    audio_w, sr_w_raw = load_mono(web_path)

    # Sample-rate normalization (issue #266): if the two WAVs are at different
    # sample rates (44.1k vs 48k machines), every downstream metric — mel,
    # MFCC, peak-freq, l2 — would compare frames that don't align in time or
    # frequency, producing false divergence. Resample the lower-SR side up to
    # the higher SR so all metrics see a single consistent grid.
    sr = max(sr_d_raw, sr_w_raw)
    if sr_d_raw != sr:
        audio_d = librosa.resample(audio_d.astype(np.float32), orig_sr=sr_d_raw, target_sr=sr)
    if sr_w_raw != sr:
        audio_w = librosa.resample(audio_w.astype(np.float32), orig_sr=sr_w_raw, target_sr=sr)
    sr_d = sr_w = sr

    # Precondition probes (SV29 candidate). Run AFTER sample-rate normalization
    # so onset and lag measurements compare like-for-like, but BEFORE the
    # score-bearing metrics so the JSON output can flag a comparison as
    # uninterpretable without recomputing.
    preconditions = verify_preconditions(audio_d, sr_d, audio_w, sr_w)

    mel_d = mel_db(audio_d, sr_d)
    mel_w = mel_db(audio_w, sr_w)

    # Diff in mel-dB space (clipped for plotting)
    n_frames = min(mel_d.shape[1], mel_w.shape[1])
    diff = mel_d[:, :n_frames] - mel_w[:, :n_frames]

    # Plot — three panels, shared mel axis
    fig, axes = plt.subplots(1, 3, figsize=(18, 5), constrained_layout=True)
    librosa.display.specshow(
        mel_d, sr=sr_d, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[0], cmap="magma", vmin=-80, vmax=0,
    )
    axes[0].set_title(f"Desktop SP\n{os.path.basename(desktop_path)}\n{sr_d} Hz · {audio_d.shape[0]/sr_d:.2f}s")

    librosa.display.specshow(
        mel_w, sr=sr_w, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[1], cmap="magma", vmin=-80, vmax=0,
    )
    axes[1].set_title(f"SonicPi.js (web)\n{os.path.basename(web_path)}\n{sr_w} Hz · {audio_w.shape[0]/sr_w:.2f}s")

    img = librosa.display.specshow(
        diff, sr=sr_d, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[2], cmap="RdBu_r", vmin=-40, vmax=40,
    )
    axes[2].set_title("Diff (desktop − web), dB\nblue = web louder, red = desktop louder")
    fig.colorbar(img, ax=axes[2], format="%+2.0f dB")

    fig.savefig(out_png, dpi=110)
    plt.close(fig)

    # Numeric metrics
    metrics = {
        "desktop": {
            "path": desktop_path,
            "sample_rate": int(sr_d_raw),
            "sample_rate_normalized": int(sr_d),
            "duration_s": float(audio_d.shape[0] / sr_d),
            "peak_freq_hz": peak_frequency(audio_d, sr_d),
        },
        "web": {
            "path": web_path,
            "sample_rate": int(sr_w_raw),
            "sample_rate_normalized": int(sr_w),
            "duration_s": float(audio_w.shape[0] / sr_w),
            "peak_freq_hz": peak_frequency(audio_w, sr_w),
        },
        "comparison": {
            "l2_mel_db": l2_spectral_distance(mel_d, mel_w),
            "mfcc_distance": mfcc_distance(audio_d, sr_d, audio_w, sr_w),
            "frames_compared": int(n_frames),
            "spectrogram_png": out_png,
            "preconditions": preconditions,
        },
    }

    if beats is not None and bpm is not None:
        per_beat = per_beat_compare(audio_d, sr_d, audio_w, sr_w, bpm, beats)
        per_beat_png = f"{out_prefix}_perbeat.png"
        plot_per_beat(per_beat, per_beat_png)
        per_beat["per_beat_png"] = per_beat_png
        metrics["per_beat"] = per_beat

    with open(out_json, "w") as f:
        json.dump(metrics, f, indent=2)

    # Echo a one-line summary so the caller can grep stdout
    pre_tag = "PRECONDITION-VIOLATED " if preconditions["violated"] else ""
    summary = (
        f"spectrogram {pre_tag}OK · L2(mel-dB)={metrics['comparison']['l2_mel_db']:.2f} · "
        f"MFCC dist={metrics['comparison']['mfcc_distance']:.2f} · "
        f"png={out_png}"
    )
    if preconditions["violated"]:
        summary += f" · failed_probes={preconditions['failed']}"
    if "per_beat" in metrics:
        pb = metrics["per_beat"]
        summary += (
            f" · per-beat mean MFCC={pb['mean_per_beat_mfcc_distance']:.2f} · "
            f"divergent beats={pb['most_divergent_beats']}"
        )
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
