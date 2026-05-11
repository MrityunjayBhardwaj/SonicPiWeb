# Sonic Pi Web

**Your Sonic Pi code, now portable.**

<p align="center">
  <img src="assets/sonicpi_screenshot.png" alt="Sonic Pi Web — live coding in the browser" width="100%">
</p>

[![CI](https://github.com/MrityunjayBhardwaj/SonicPi.js/actions/workflows/ci.yml/badge.svg)](https://github.com/MrityunjayBhardwaj/SonicPi.js/actions/workflows/ci.yml)
[![Deploy](https://github.com/MrityunjayBhardwaj/SonicPi.js/actions/workflows/deploy.yml/badge.svg)](https://github.com/MrityunjayBhardwaj/SonicPi.js/actions/workflows/deploy.yml)
[![npm latest](https://img.shields.io/npm/v/@mjayb/sonicpijs?label=npm%20latest)](https://www.npmjs.com/package/@mjayb/sonicpijs)
[![npm beta](https://img.shields.io/npm/v/@mjayb/sonicpijs/beta?label=npm%20beta&color=orange)](https://www.npmjs.com/package/@mjayb/sonicpijs/v/beta)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**[Try it now at sonicpi.cc](https://sonicpi.cc)**

> v1.5 is in **beta** — published under both the `latest` and `beta` npm tags during stabilization. `npm install @mjayb/sonicpijs` gets you the current beta; pin with `@1.5.0-beta.3` for a fixed version.

---

## Make music with code. In your browser.

Sonic Pi Web is a browser-native reimplementation of [Sonic Pi](https://sonic-pi.net/)'s live coding engine. Same Ruby DSL. Same synths. Same samples. No install.

I built this because Sonic Pi changed how I think about music and code, and I wanted that experience to be one click away for anyone with a browser.

All thanks to:
- **Sonic Pi** & Sam Aaron — for proving that code is a musical instrument
- **SuperSonic** — the WebAssembly port of SuperCollider that makes real synthesis possible in the browser
- **AudioWorklet** — the browser API that makes low-latency audio processing work
- **Algorave community** — for building a culture where live coding is performance art

---

## The core idea: `sleep` as a scheduler-controlled Promise

Ruby's `sleep` blocks the thread. JavaScript can't — block the main thread and the UI freezes. Previous browser ports either gave up on multi-loop timing or simulated it with `setTimeout`, which drifts under load.

The trick we landed on: `sleep` returns a Promise that **only the VirtualTimeScheduler can resolve**. User code `await`s the sleep; the scheduler advances virtual time and resolves Promises in deterministic order. The result is cooperative concurrency with virtual time across any number of `live_loop`s, with audio events scheduled ahead of the AudioWorklet callback so they stay sample-accurate.

This means the JS engine inherits Sonic Pi's full temporal model — `sync`, `cue`, `time_warp`, `with_fx`, hot-swap — not a simplified approximation.

- **Ruby DSL → JS via Tree-sitter.** Your Sonic Pi code is parsed into an AST and transpiled to JavaScript builder chains. Full structural awareness of blocks, symbols, and Ruby semantics. No regex hacks.
- **Real SuperCollider synthesis.** Audio runs through SuperSonic (scsynth compiled to WebAssembly via AudioWorklet). Same synth definitions, same sound — not a simplified approximation.

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
```

Press Run. Now add this while the drums are playing:

```ruby
live_loop :bass do
  use_synth :tb303
  play :e2, release: 0.3, cutoff: rrand(60, 120)
  sleep 0.25
end
```

The bass joins in. Change a number. Hit Run again. The music updates instantly. That's live coding.

---

## What can I do with it?

**Write Sonic Pi code** — the same Ruby DSL you know from desktop. `live_loop`, `play`, `sleep`, `sample`, `with_fx`, `use_synth`, `sync`, `cue` — it all works.

**Perform live** — 10 buffers, hot-swap on Re-run, Alt+R/Alt+S shortcuts, fullscreen mode, spectrum visualizer. Built for the stage.

**Teach** — zero setup means students open a URL and start coding. Friendly error messages with line numbers. Built-in examples from simple beats to full compositions.

**Embed anywhere** — drop the engine into any web page, LMS, or creative coding tool as an [npm package](https://www.npmjs.com/package/@mjayb/sonicpijs).

---

## Getting Started

### Option 1: Just open the website

**[sonicpi.cc](https://sonicpi.cc)** — nothing to install.

### Option 2: Run locally

```bash
npx sonicpijs@beta
```

### Option 3: Embed in your app

```bash
npm install @mjayb/sonicpijs@beta
```

```ts
import { SonicPiEngine } from '@mjayb/sonicpijs'

const engine = new SonicPiEngine()
await engine.init()
await engine.evaluate(`
  live_loop :beat do
    sample :bd_haus
    sleep 0.5
  end
`)
engine.play()
```

---

## What's included

| Feature | Details |
|---------|---------|
| **62 synths** (66 exposed, 3 upstream LOAD-FAIL) | beep, saw, prophet, tb303, supersaw, blade, hollow, pluck, piano, and more |
| **197 samples** | Kicks, snares, hats, loops, ambient, bass, electronic, tabla |
| **42 FX** | reverb, echo, distortion, flanger, slicer, wobble, chorus, pitch_shift, and more |
| **~148 DSL functions** (~87% of upstream) | live_loop, with_fx, define, defonce, in_thread, sync/cue/sync_bpm, density, time_warp, use_osc/osc, run_code, with_synth_defaults, with_sample_defaults |
| **Per-loop audio isolation** | Each `live_loop` gets its own analyser bus — first Sonic Pi implementation to ship this |
| **Music theory** | 30+ chord types, 50+ scales, rings, spreads, Euclidean rhythms |
| **10 buffers** | Switch between code tabs like desktop Sonic Pi |
| **Scope visualizer** | Mono, stereo, lissajous, mirror, spectrum — all 5 Desktop SP modes |
| **Cue Log** | Live cue/sync event stream in a dedicated panel |
| **Live mixer** | Pre-amp and Amp sliders in Prefs push to scsynth on drag |
| **Recording** | Capture your session to WAV (raw float32, lossless) |
| **18 examples** | From "Hello Beep" to a full Blade Runner x Techno composition |
| **Autocomplete** | Code hints with inline descriptions |
| **Help panel** | 311 entries — functions, synths, FX, and samples with params and examples |
| **Preferences** | Audio, visuals, editor, and performance settings |
| **Resizable panels** | Drag splitters to resize scope, log, cue log, and help panel |
| **Custom samples** | Upload your own WAV/MP3/OGG files |
| **Save/Load** | Export and import your code as files |
| **Friendly errors** | 20 error patterns with "did you mean?" suggestions and line highlighting |
| **Report Bug** | One-click bug report with pre-filled GitHub issue |
| **FX A/B inspector** (`npm run inspect`) | Side-by-side desktop ↔ web spectrograms for every FX, with MFCC parity scoring |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Enter / Alt+R | Run code |
| Escape / Alt+S | Stop all |
| Ctrl+/ | Toggle comment |
| F11 | Fullscreen |
| A- / A+ | Font size |

---

## Tech stack

TypeScript, Vite, Vitest (929 tests across 29 files), CodeMirror 6, Web Audio API, WebAssembly (SuperCollider scsynth via SuperSonic).

---

## Compatibility with Desktop Sonic Pi

929 unit tests + 49 community forum compositions verified passing end-to-end in Chromium. Concretely, current coverage:

- **62/66 synths** working end-to-end (3 upstream WASM LOAD-FAIL)
- **197/197 samples**
- **42/42 FX** wired (4 HIGH / 26 MID / 8 LOW / 2 INCONCLUSIVE on the WAV-level parity comparator; composite parity ~89.5%)
- **~148/170 DSL functions** (~87% of upstream's user-facing surface)

**Identical to desktop:** seeded PRNG (Mersenne Twister), synth definitions, sample library, music theory, timing semantics, hot-swap, sync/cue.

**Different in the browser:**
- Audio output is calibrated for browser WASM headroom (Sonic Tau's gain staging, `pre_amp=0.3`, `amp=0.8`), not Desktop SP's driver-attenuated levels. Comparator tools should RMS-normalise before A/B.
- OSC output requires a host-provided transport (hook-based) — browsers can't open raw UDP sockets.
- MIDI is wired internally but the device-picker UI ships in v1.6 (Tier D). Web MIDI works for input.
- No filesystem access — sample paths from directories, `eval_file`, and user samples from disk are out of scope until the browser sandbox model changes.

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for permanent constraints and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for current beta-blocker bugs.

### How does this compare to Sonic Tau?

[Sonic Tau](https://sonic-pi.net/tau/) is Sam Aaron's official next-gen Sonic Pi for the browser, built on Elixir + Phoenix LiveView. Sonic Pi Web is an independent JS-native engine you can `npm install` and embed in any web page. Tau is the future of the Sonic Pi project; this is for embedding the live-coding model into your own apps, courses, and tools.

---

## What's new in v1.5-beta

- **Engine audit pass:** 33 bugs fixed since v1.4, including 4 hot-swap state bugs (SP78–SP81) caught by Playwright + WAV reproducers
- **Real-world corpus:** 56 compositions verified — MagPi Essentials chapters, 15 wizard/sorcerer/magician examples, 13 community forum compositions
- **New DSL:** `use_sample_bpm`, `midi` shorthand, `use_osc`/`osc`, `with_fx reps:`, `with_synth_defaults`, `with_sample_defaults`, `use_density`, `use_debug`, `defonce`, `sync_bpm`, `run_code`, `live_audio :stop`
- **Tooling:** FX A/B inspector (`npm run inspect`), e2e parity suite (`test_results/e2e.html`), capture tool with audio recording
- **Mixer:** live Pre-Amp / Amp sliders, gain staging aligned to Sonic Tau (browser-WASM safe headroom)
- **Per-loop audio isolation** — first Sonic Pi implementation to ship this

Full changelog: [Releases](https://github.com/MrityunjayBhardwaj/SonicPi.js/releases).

---

## Coming next

- **Tier C/D DSL completion** — remaining ~22 helpers (with_synth, use_arg_checks, sample_paths, MIDI device picker UI, `midi_pc`/`midi_raw`/`midi_sysex`)
- **Tutorial system port** — desktop Sonic Pi's 50+ chapter tutorial adapted for the browser
- **Ableton Link** — UDP-over-WebSocket relay
- **Cross-browser CI matrix** — Firefox + Safari coverage

---

## Check out these cool projects

- **[Sonic Tau](https://sonic-pi.net/tau/)** — Sam Aaron's official next-gen Sonic Pi for the browser. Built with Elixir + Phoenix LiveView. The future of Sonic Pi.
- **[Strudel](https://strudel.cc/)** — Alex McLean's live coding pattern language for the browser. Different paradigm (TidalCycles-inspired), equally mind-blowing.
- **[Tone.js](https://tonejs.github.io/)** — Web Audio framework for building interactive music in the browser.

---

## Contributing

Issues and PRs welcome. Pick an issue from the [SonicPi.js Roadmap](https://github.com/users/MrityunjayBhardwaj/projects) board — `area: audio`, `area: scheduler`, and `area: transpiler` labels are good entry points. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow.

## License

MIT. See [LICENSE](LICENSE).
