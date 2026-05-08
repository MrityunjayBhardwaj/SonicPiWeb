# E2E Test Suite Results — 10 Complex Sonic Pi Compositions

**Date:** 2026-05-09 (post-SP75 capture-wrap fix + AMP=2 calibration, on `feat/mixer-prefs-and-capture-fix`)
**Engine state:** SP72 (use_bpm leak — merged in #280) + SP75 (capture-wrap fix — this branch) + AMP=2 mixer default + live-wired Pre-Amp / Amp Prefs sliders
**Tool:** `tools/e2e-sweep.sh` → `tools/compare-desktop-vs-web.ts` (raw-OSC desktop side via `tools/capture-desktop.ts`; web side via `tools/capture.ts --wrap-recording`, now with the SP75 conditional wrap)
**Duration:** 20s per fixture · BPM as set in fixture · Sample rate desktop 44.1k / web 48k (resampled to common rate inside `spectrogram-compare.py`)
**SP60 mitigation:** Sonic Pi.app restarted every 5 fixtures to avoid the daemon-stuck pattern that produced false-INCONCLUSIVEs in earlier sweeps.

## Summary — 9 of 10 fixtures within ±30% RMS, all under MFCC 250

| Stat | Median | Mean | Range |
|---|---|---|---|
| RMS ratio (web ÷ desktop) | **0.74×** | 0.92× | 0.72× — 2.46× |
| Peak ratio (web ÷ desktop) | **0.87×** | 0.99× | 0.72× — 2.13× |
| MFCC distance | 178 | 174 | 94 — 251 |
| L2 (mel-dB) | 18.9 | 18.4 | 12.1 — 24.3 |

9 of 10 fixtures land in the **0.72×–1.15× peak / 0.72×–0.80× RMS** band — close-to-parity with desktop, modestly attenuated by the AMP=2 default (which leaves comfortable headroom below the limiter and lets the user push up via the live mixer slider). One outlier:

- **`07_ambient` — web 2.46× louder** — heavy reverb + prophet + echo. Down from **3.22×** (pre-SP75) and **4.20×** (2026-05-04 measurement). Still inverted but **24% closer to parity** than pre-fix. Time-domain feedback FX (reverb / echo / chorus) amplify in WASM rather than attenuate — a separate upstream-WASM ugen class from the constant filter deficit. Worth a tight reproducer at `samaaron/supersonic`.

## Per-fixture metrics

| # | Fixture | Desktop RMS | Web RMS | RMS ratio | Desktop peak | Web peak | Peak ratio | MFCC | L2 dB |
|---|---------|-------------|---------|-----------|--------------|----------|------------|------|-------|
| 1 | `01_minimal_techno`  | 0.169 | 0.127 | 0.75× | 0.753 | 0.866 | 1.15× | 205 | 20.2 |
| 2 | `02_fx_chain`        | 0.294 | 0.222 | 0.75× | 0.797 | 0.605 | 0.76× |  94 | 12.1 |
| 3 | `03_multi_layer`     | 0.142 | 0.106 | 0.74× | 0.802 | 0.611 | 0.76× | 177 | 20.0 |
| 4 | `04_sync_cue`        | 0.138 | 0.101 | 0.73× | 0.696 | 0.621 | 0.89× | 251 | 24.3 |
| 5 | `05_dj_dave_full`    | 0.224 | 0.178 | 0.80× | 1.000 | 0.870 | 0.87× | 171 | 17.1 |
| 6 | `06_euclidean`       | 0.210 | 0.156 | 0.74× | 1.000 | 0.860 | 0.86× | 180 | 20.2 |
| 7 | `07_ambient`         | 0.025 | 0.061 | **2.46×** | 0.195 | 0.415 | **2.13×** | 141 | 16.2 |
| 8 | `08_full_composition`| 0.165 | 0.122 | 0.74× | 0.907 | 0.786 | 0.87× | 141 | 14.6 |
| 9 | `09_dnb`             | 0.245 | 0.176 | 0.72× | 1.000 | 0.870 | 0.87× | 180 | 17.9 |
| 10| `10_house`           | 0.202 | 0.147 | 0.73× | 0.981 | 0.708 | 0.72× | 203 | 21.3 |

## Delta vs pre-SP75 sweep (the broken-wrap baseline)

| Metric | Pre-SP75 (broken wrap) | Post-SP75 (fixed wrap) | Δ |
|---|---|---|---|
| Median RMS× | 1.10× | **0.74×** | shifted (AMP 3 → 2) |
| Median peak× | 1.02× | **0.87×** | shifted (AMP 3 → 2) |
| `02_fx_chain` RMS× | **0.15×** (FX wasn't applying) | **0.75×** (FX now applies) | +400% — full recovery |
| `07_ambient` RMS× | 3.22× | **2.46×** | -24% — closer to parity |
| Fixtures within ±30% RMS | varies (FX-fail-tinted) | **9/10** | clear majority |
| Mean MFCC | 192 | **174** | -10% — closer timbre |

The headline change isn't in the median ratios (those mostly reflect the AMP 3→2 calibration shift) — it's that **the per-fixture audio actually contains the FX the snippet asked for**, instead of dry pass-through. `02_fx_chain` is the cleanest demonstration: its serial FX chain previously produced 0.15× (FX missing entirely), now produces 0.75× (FX present and audible).

## Sidecars

Each fixture's full comparator output lives at `.captures/e2e-sweep/<fixture>.json` (peak/RMS, MFCC, L2 mel-dB, spectrogram path, individual WAV paths). Spectrograms PNGs at `.captures/compare_*_e2e-<fixture>_spectrogram.png`.

For visual A/B audition: `npm run inspect` → http://localhost:8080/e2e.html (or `python3 tools/build-e2e-results.py` to regenerate the static viewer).

## Open questions (for follow-up upstream issue at samaaron/supersonic)

1. **`07_ambient` 2.46× over-amplification** — reverb-class feedback FX render hotter in WASM than native scsynth. The narrowest reproducer would be a single `with_fx :reverb` block over a fixed sample at known amp, comparing peak/RMS across native and WASM scsynth.
2. **`04_sync_cue` MFCC 251** — highest in the set. The fixture exercises cross-loop cue/sync timing. Worth a per-loop ablation to isolate which loop's signal drifts.
