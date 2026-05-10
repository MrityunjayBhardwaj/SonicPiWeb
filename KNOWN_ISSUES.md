# Known Issues — Sonic Pi Web (Beta)

> **This is a beta.** It runs in the browser, plays your Sonic Pi code, and gets ~85% of the way to the desktop experience. The other ~15% is what this document is about.
>
> **Beta means:** report bugs, expect rough edges, give us your patience. We move fast on issues that come with a clear repro. Open one at <https://github.com/MrityunjayBhardwaj/SonicPi.js/issues> — there's a "Report Bug" button in the toolbar that pre-fills the URL with your composition.

Last updated: 2026-05-11. Mirrors what we know honestly today; this list grows with the project.

---

## Quick reference: what works, what doesn't

| Area | Status | Notes |
|------|--------|-------|
| **Core scheduling** (`live_loop`, `sleep`, `cue`/`sync`, `in_thread`, hot-swap) | ✅ Works | First-of-its-kind virtual-time scheduler in JS. Per-loop audio isolation. |
| **Synths** | 🟡 88% (62 of ~68 user-facing) | 3 fail to load upstream. 2 mic-input synths are wired (`:sound_in`, `:sound_in_stereo`). |
| **Samples** | ✅ 197/197 wired | Lazy-loaded on first use. |
| **FX** | 🟡 ~75% parity | See FX matrix below. Some heavy-DSP effects diverge from desktop. |
| **DSL functions** | 🟡 ~87% (~148 of 170) | Common DSL covered. Long tail of obscure helpers still missing. |
| **Ring API, chords, scales** | ✅ 100% | Fully wired. |
| **MIDI** | 🟡 Chromium-only | Disabled in Firefox/Safari at the button level. |
| **Recording (WAV)** | ✅ Works | Raw float32 → WAV. Click ⏺ Rec to start, ⏺ Save to download. |
| **Custom samples** | ✅ Works | Drag-drop into the Samples menu, persists in IndexedDB. |
| **Cross-browser** | 🟡 Chromium first | See browser matrix below. |

Legend: ✅ ready · 🟡 partial / known limitations · ❌ broken / not implemented

---

## 1. Audio parity gaps

### 1.1 WASM gain deficit (~0.6× vs native scsynth)

**Symptom:** Playing the same code on Sonic Pi desktop and Sonic Pi Web at the same listening volume, the web version sounds quieter on per-hit transients. Sustained drones sound roughly equal.

**Root cause:** The WebAssembly build of scsynth has a uniform ~0.6× output deficit compared to native scsynth. This is upstream — we cannot fix it inside our engine.

**Workaround in place:** We compensate by setting `MIXER.AMP = 2` (was `1.2`) and `MIXER.PRE_AMP = 0.32` in our mixer node. At those values, web RMS lands at ~1.07× desktop on the canonical kick+clap composition — within tolerance of natural variance.

**What this means for you:** If you bring a desktop composition to the web, you may need to bump amplitudes slightly for parity, OR trust the calibration and live with whatever the web mixer produces.

### 1.2 FX parity matrix (40 of 42 measured)

We classify each FX into one of four parity tiers using a combined energy-axis (RMS) + timbre-axis (MFCC distance) score against desktop Sonic Pi:

- **HIGH** (4) — `panslicer`, `slicer`, `wobble`, `tremolo` — sustained-flavor effects, audibly close to desktop.
- **MID** (~26) — most other FX. Audibly Sonic Pi but with measurable level / timbral differences.
- **LOW** (~8) — filter family + normaliser — divergence is audible. Includes `nlpf` (non-resonant LPF) and several others. Use them but expect they won't sound identical to desktop.
- **INCONCLUSIVE** (2) — `delay`, `chorus` — desktop produces silence in our test bench; we can't classify until we have a desktop signal to compare against.

**Composition-level impact:** Two compositions in our 10-fixture e2e suite are outliers — `02_fx_chain` (0.11× desktop level) and a separate ambient case (2.46× desktop level after fixes). Long FX chains compound per-FX deficit / boost multiplicatively.

**Specific gotchas:**

- **`reverb` / `gverb` chained with other FX in ambient pieces** — over-amplifies (web > desktop). Currently 2.46× louder on the worst case.
- **Long filter chains** (e.g. forum compositions like `43_exploring_tb303`, `33_dub_reverb`) — under-amplifies (web 0.09–0.10× desktop). These compositions will sound very quiet without manual `amp:` boosts.
- **`nlpf`** — only LOW-tier filter that survived recent comparator fixes. Score ~47, MFCC distance ~280. Real divergence, not a measurement artifact.

### 1.3 `env_curve: 2` quirk in WASM scsynth

**Symptom:** Some synths (notably `:prophet`) used to produce silence on small attack values, or δ-spikes when used in multi-synth contexts.

**Status:** Worked around in our `SoundLayer` by NOT injecting `env_curve: 2` (Desktop SP's default). The synthdefs run with their compiled defaults instead. Audible result is correct in nearly all cases; an edge case may still hit a δ-spike under tight overlap.

---

## 2. Synth coverage

- **62 of ~68 user-facing synths working end-to-end.**
- **3 synths fail to load** because the upstream `supersonic-scsynth-synthdefs` package's compiled binary fails to instantiate. We've left them in the catalogue with a load-fail marker so you'll see a clear error instead of silence.
- **2 mic-input synths** (`:sound_in`, `:sound_in_stereo`) auto-start the microphone. Browser will prompt for mic permission on first use.

---

## 3. DSL function coverage

- **~148 of ~170 user-facing DSL functions implemented (~87%).**
- **Common DSL is fully covered:** `play`, `sample`, `synth`, `live_loop`, `with_fx`, `with_synth`, `at`, `sleep`, `sync`, `cue`, `use_bpm`, `use_synth`, `with_random_seed`, `tick`, `look`, the full ring API, chords, scales, MIDI output / input, `sample_duration`, `define`, `defonce`, `set` / `get`.
- **Missing or incomplete:** the long tail of obscure helpers. If you copy a forum composition and hit `NoMethodError: 'foo'`, it's likely we haven't wired `foo` yet. **Please report it** — adding a missing helper is usually quick once we know the community wants it.

---

## 4. Browser support matrix

| Browser | Audio | MIDI | Recording | Notes |
|---------|-------|------|-----------|-------|
| **Chrome / Edge / Brave / Opera** | ✅ Full | ✅ Full | ✅ Full | Primary development target. |
| **Firefox** | ✅ Audio works | ❌ Disabled | ✅ Works | MIDI button is disabled and shows "MIDI unsupported in this browser" because Firefox's Web MIDI implementation either lacks API support or enumerates zero devices in many configurations. Safari and Brave-with-shields have similar limitations. |
| **Safari** | 🟡 Recent versions | ❌ Disabled | 🟡 Untested | Safari 18+ should work. Older Safari may not. We have not yet run a full test pass in Safari. |
| **Mobile (any)** | 🟡 Untested | ❌ | 🟡 | Touch UX is not optimised for live coding. Audio should work on iOS Safari + Chrome Android, but layout is desktop-first. |

### Browser-specific gotchas

- **Firefox download handlers** — earlier in beta, the WAV recorder downloaded with `audio/wav` MIME, which caused Firefox to *autoplay* the WAV in a media viewer in certain configurations (sounded like the music was playing twice after pressing Save). We now ship the WAV with `application/octet-stream` MIME so Firefox always treats it as a download. Fixed; mentioning it here so you know what happened if you saw it before.
- **Tab backgrounding** — Browsers may suspend AudioContext or throttle setTimeout when the tab is hidden. We log a warning when this happens and try to resume on focus, but expect timing glitches if you alt-tab during playback.
- **Bluetooth audio output** — scsynth WASM locks its sample rate at boot to whatever device is current. Switching audio output devices mid-session (e.g. plugging in / unplugging Bluetooth headphones) can change the audio context's sample rate and produce subtle pitch / timing artifacts on subsequent runs. **Workaround:** finalize your audio output device before starting the engine, or refresh the page after switching.

---

## 5. Hot-swap & live-coding edge cases

The virtual-time scheduler is the project's most novel piece. It works, but live coding is the hardest test case. Recent things we caught and fixed (between v1.5.0-beta.0 and current):

- **Stop button could leave a tail of audio** for ~0.5–1 s as queued OSC bundles fired after `g_freeAll`. Fixed — `Stop` now drains both the JS-side and WASM-side scheduler queues.
- **No-op Update used to glitch** — pressing Run with the editor unchanged restarted every loop and re-created FX. Fixed — byte-identical re-evaluate is now a true no-op.
- **Removing a `live_loop` and re-running** could leak per-loop state (BPM, sync flags, tick state) into the next addition of a loop with the same name. Fixed.
- **Top-level `with_fx` wiring used to drop on hot-swap.** Fixed.

If you hit something that looks like a hot-swap glitch we haven't listed, **please open an issue with the exact code that triggered it** — we have a Playwright + WAV-analysis test harness that turns concrete repros into permanent regression nets within a day.

---

## 6. UI rough edges

- **Sample preview** plays each sample 5 times back-to-back (using `sample_duration` for spacing). Click ⏸ on the row to stop early. The button auto-reverts to ▶ after 60 s — long ambient samples may finish playing audibly while the button is already reset.
- **MIDI dropdown shows a "Loading MIDI devices…" state** on first open while Web MIDI permission is being granted. If you grant permission and the list is still empty, your devices may genuinely be invisible to the browser — try Chrome.
- **The progress preloader** (Sonic Pi Web logo + bar at startup) preloads the editor, parser, and audio runtime modules so first-Run is fast. If a CDN is slow or down, the preloader will continue past failed steps; the app's normal lazy paths will retry the same URL on first use.
- **No keyboard accessibility audit yet.** Tab navigation works in some places, not in others. Screen reader support is untested.

---

## 7. Performance & scale

- **Tested:** ~3-minute compositions with 2-4 simultaneous `live_loop`s, FX chains, and tick-based variation work reliably.
- **Untested:** very long compositions (>10 min), >8 simultaneous loops, sample-heavy ambient pieces with many parallel `sample` calls.
- **AudioContext stays alive across runs** so the scheduler memory grows over a session. We haven't profiled how much. Refresh the tab if you've been live-coding for hours and notice slowdown.
- **Scope visualisations** (waveform, spectrum, lissajous) run on an `AnalyserNode` tap. Fine on desktop GPUs. May stutter on integrated graphics with the spectrogram view active.

---

## 8. Things explicitly NOT supported (yet)

- **OSC input from external apps** — only OSC *output* (`use_osc`, `osc`) is wired. No incoming OSC handler.
- **Live audio in besides mic** — no system audio capture, no virtual loopback, no line-in selection. The two mic synths use the default browser audio input.
- **`load_sample` / `load_synthdef` from URL** — samples auto-load from the bundled CDN. Custom samples come via the upload UI, not via DSL.
- **Sysex MIDI** — disabled in `requestMIDIAccess({ sysex: false })` for safety. Most controllers don't need it.
- **Multi-cue blocking sync** — single-cue `sync :name` works. The variants with arrays of cues or with timeout values are partial.
- **`time_warp`** — partial. The block executes; subtle interactions with `live_loop` schedules may diverge from desktop.

---

## 9. How to report a bug

1. **Click "Report Bug" in the toolbar** — opens GitHub issues with the URL pre-filled.
2. **Include the exact code** that triggered it. Even better: paste the URL the editor produces (the editor encodes your buffer into the URL so we can repro by clicking).
3. **Tell us your browser + OS** — especially relevant after this beta document.
4. **If audio sounds wrong**, click ⏺ Rec, ⏺ Save, and attach the WAV. Audio bugs are 10× faster to fix when we can hear what you heard.

For the full triage workflow — severity ladder, label scheme, what makes a bug land fast — see [`TRIAGE.md`](./TRIAGE.md).

We use the project board at <https://github.com/MrityunjayBhardwaj/SonicPi.js/projects> to track active work. Bugs with clear repros usually land a fix within a few days.

---

## 10. What we're NOT promising

- **This is not a drop-in replacement for desktop Sonic Pi.** Desktop has the full Ruby runtime + the SuperCollider native build + 13 years of polish. We have the scheduling model, ~85% of the DSL, and the start of a comparable audio engine in the browser.
- **The audio is not bit-identical to desktop.** It is, on most code, audibly Sonic Pi. The matrix above says where it isn't.
- **APIs may shift in beta.** We try not to break anything that works, but if a parity fix changes timing or level, your composition may sound slightly different after an update. We'll call out those changes in release notes.
- **No long-term storage guarantees.** Buffers persist in `localStorage`; custom samples in IndexedDB. Both can be cleared by the browser. Save anything important locally too.

---

## 11. Privacy & analytics

We use [Plausible](https://plausible.io/) for analytics. It's privacy-friendly: no cookies, no IP tracking, no PII, GDPR/CCPA-clean. We never send your source code or error messages to analytics.

**What we track:**

- Pageviews
- `Run Code` — engagement (which browser)
- `Engine Init Failed` — CDN / WASM reliability (browser + error class)
- `Runtime Error` — error class only, never the message or your code
- `Sample Preview` — feature adoption
- `MIDI Opened` — including unsupported-browser clicks (sizes the limitation)
- `Recording Saved` — feature adoption
- `Example Loaded` — which built-in examples actually get tried (name only)
- `Preloader Complete` — real-world cold-start performance buckets

**To opt out:** open the browser console and run:
```js
localStorage.setItem('spw-disable-analytics', '1')
```
Refresh the tab. All `track(...)` calls become no-ops. To re-enable, delete the key.

Source: [`src/app/Analytics.ts`](./src/app/Analytics.ts) — every event call site is grep-able.

## 12. What this beta IS for

- **Live coding in the browser** without installing anything. Open a tab, code, hear it.
- **Sharing a piece via URL** — the editor encodes your buffer into the URL.
- **Teaching / workshops** where install friction is the blocker.
- **Sketching** — try a sample, audition a synth, prototype a beat.
- **Helping us find what's broken.** Especially compositions you'd love to play that don't work yet.

If you brought a real Sonic Pi piece to this and 80% of it Just Works, that's the win we shipped for. Tell us about the other 20%.
