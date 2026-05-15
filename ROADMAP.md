# SonicPi.js Roadmap

> Live at [sonicpi.cc](https://sonicpi.cc) | npm: [`@mjayb/sonicpijs`](https://www.npmjs.com/package/@mjayb/sonicpijs)

---

## Stable releases

| Version | Highlights |
|---------|------------|
| **v1.0.0** | Engine, standalone app, 35 synths, 34 samples, sandbox, CLI |
| **v1.1.0** | Full MIDI I/O, beat_stretch/pitch_stretch, Ring fixes |
| **v1.2.0** | stop_loop, multi-line continuation, ternary operator |
| **v1.3.0** | Tree-sitter sole transpiler, SoundLayer parity, 100% data parity (66 synths, 197 samples, 42 FX), param validation, scope rewrite (5 modes), runtime semantics, full UI overhaul |
| **v1.4.0** | Help panel (311 entries), resizable panels, cue log wired, error handling overhaul (20 patterns, block validation, line highlighting, hot-swap rollback), Report Bug button, CI workflow, TypeScript 6 |

## Prereleases

| Version | npm dist-tag | Highlights |
|---------|--------------|------------|
| **v1.5.0-beta.2** | `beta` | Transpiler consolidation (#165): `synth :NAME` idiom, top-level `use_synth` ordering, sole TreeSitter path (legacy regex transpiler removed), `.zip` / `.each_with_index` array helpers. P2 credibility features (#166): `use_real_time`, MIDI dual cue paths (`/midi:*:ch/type` + `/midi/type`), wildcard sync/cue (`*`, `?`), `synth :sound_in` / `:sound_in_stereo` via `getUserMedia`. Four review-caught engine bugs fixed: #167 sound_in routing (`.node.input` fallback), #168 external-source fireCue fallback, #169 mic lifecycle (Stop release + idempotent per-dispatch + hot-swap reconcile), #170 `get[:key]` Proxy wrap. New automated E2E coverage under `tests/p2-credibility.spec.ts`. Install: `npm install @mjayb/sonicpijs@beta`. |
| **v1.5.0-beta.0** | `beta` | Engine audit: 33 bugs fixed. Tutorial/book/community parity: 56 real-world compositions verified in Chromium (MagPi Essentials chapters, 15 official Sonic Pi wizard/sorcerer/magician examples, 13 community forum compositions). New DSL: `use_sample_bpm`, `midi` shorthand, `use_osc`/`osc`, `with_fx reps:`, `with_synth_defaults`, `with_sample_defaults`, `use_density`, `use_debug` exposed. Sandbox fixes: `b`→`__b` rename, `get()` Proxy→function. Bridge fixes: `in_thread` inside `with_fx` inherits `outBus`, lazy-load race conditions, `freeBus` guard. Install: `npm install @mjayb/sonicpijs@beta`. |

---

## v1.5.0 — Beta Testing

**Status:** Currently in beta (see Prereleases table above for the current version). Real-user testing via Sonic Pi community forum. Fix regressions until the bug discovery curve flattens, then promote via RC to stable. Full cycle criteria in [`RELEASE.md`](./RELEASE.md#release-cycle-transition-criteria).

### Known gaps to address before stable

#### Level 3 audio verification follow-ups (beta.2 features)
These features are wired and Level-2 verified (events, logs, WAV-free E2E tests) but still owe perceptual/fidelity verification against hardware:
- [ ] **`use_real_time` latency measurement** — the keyword flips `schedAheadTime` to `0` for the current thread, but the resulting latency drop from the ~150ms default has only been verified via the code path, not against a real MIDI controller or a differential-onset WAV test. Follow-up: build `tools/level3-p2.ts` with a two-loop differential test (one loop `use_real_time`, one not, both firing on the same cue) and measure the onset delta in the captured WAV.
- [ ] **`synth :sound_in` fidelity test** — the mic is confirmed to reach scsynth end-to-end (routing verified, lifecycle verified, manual hardware testing passes), but no automated test feeds a known tone through the mock getUserMedia and checks the output WAV for that tone's presence. Follow-up: extend the mock in `tests/p2-credibility.spec.ts` to generate a 617Hz sine, then add single-bin DFT onset detection to the captured audio.

#### Sandbox polish
- [ ] **#137 — Sandbox `Proxy.has()` returns true for all properties, allowing sandbox detection.** Low impact (no security bypass, just detectability via `'fetch' in scope === true` even though `fetch` returns `undefined`), intentional design for the `with(__scope__)` pattern to work. Fix is surgical: maintain an explicit blocklist of real globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `localStorage`, `document`, `window`, `parent`, `top`, `frames`, most of `navigator`) and return `false` from `has()` for those, while keeping `true` for DSL functions and user variables. See the analysis subsection below for the design landscape.

  **How the world solves sandbox detectability in `with()`-based Proxies:**

  1. **Browser-level isolation (iframe / Worker)** — CodePen, JSFiddle, Replit previews, Figma plugins, Observable notebooks. Cross-origin iframe per cell gives its own realm + its own globals. Isolation happens at the HTML level, not JS. **Tradeoff:** ~20ms+ of message-passing latency per call, unacceptable for our main-thread virtual-time scheduler that needs direct access to `AudioContext.currentTime`.

  2. **Different JS engine (QuickJS / V8 isolates)** — Figma plugins ship QuickJS compiled to WASM. Deno uses V8 isolates. Complete isolation. **Tradeoff:** bundle size (~1MB gzipped for QuickJS), startup cost, no native V8 JIT for the user's hot loop.

  3. **`ShadowRealm` (TC39 Stage 3)** — [proposal-shadowrealm](https://github.com/tc39/proposal-shadowrealm) adds `new ShadowRealm()` for a new realm without iframe overhead. Shipping in Node 22+, Chrome behind a flag, no Firefox/Safari yet. **Will eventually be the right answer** — when browsers ship it, `has()` becomes irrelevant because the realm has its own `globalThis`.

  4. **SES / Hardened JavaScript** (the gold standard) — [endojs/endo](https://github.com/endojs/endo) (Agoric, MetaMask, Firefox PDF viewer). `Compartment` is a curated `with`-based sandbox with an honest `has()` trap: it returns `true` only for what's in the compartment's curated `globalThis` + explicitly exposed locals, `false` for everything else. Blocked globals simply aren't present in the compartment. Also freezes intrinsics to block prototype-pollution attacks. `endojs/endo/packages/ses/src/scope-handler.js` is the ~200 lines worth stealing.

  5. **Compile-time rewrite (no Proxy)** — parse user code, rewrite bare identifiers to explicit `__scope__.x` references. CoffeeScript, Opal (Ruby→JS) do this. **Tradeoff:** any bug in the rewrite is a sandbox escape; SES chose Proxy over rewrite because Proxy has a smaller attack surface.

  **Sonic Pi Web's peer niche:** among browser live-coding DSLs (Hydra, Strudel, Gibber, Flok, Ripple), **nobody sandboxes at all** — they all use `eval` + a scope object and trust the user. Sonic Pi Web is unusually disciplined for even attempting this. The current Proxy+`with()` pattern is already stronger than any peer.

  **Recommended path (in order of cost):**
  - **(a) Surgical `has()` fix — ~1–2 hours.** Hardcoded blocklist of real globals. Matches the issue body's proposal. Fixes detectability without touching the `with` pattern. **This is the right call for v1.5.x.**
  - **(b) Steal from SES — ~1–2 days.** Adapt `scope-handler.js`'s globalLookup table. Inherits more hardening discipline without taking the full SES dep.
  - **(c) Migrate to SES `Compartment` — ~1–2 weeks.** Full dep, probably overkill for our threat model (protecting against accidental self-foot-shots, not malicious DeFi actors).
  - **(d) Wait for `ShadowRealm` — ~2 years.** The right answer long-term; not actionable now.

  Scheduling: queue for v1.5.x post-beta.2, NOT a release blocker. Beta community testing may find issues in the current sandbox that drive a real fix prioritization.

#### Test tooling
- [ ] **Add `--batch` flag to `tools/capture.ts`** — batch-run a directory of `.rb` files through `captureRun(browser, code, opts)` with one shared Chromium session instead of one browser per file. Currently `capture.ts` spawns a fresh browser per file, which makes regression runs against `tests/book-examples/` (46 files) take ~15 min. A batch mode that reuses the browser + engine (pay CDN + scsynth boot once, hot-swap between files) cuts that to ~3-4 min and still does per-file WAV capture + peak/RMS/clipping stats — the same Level 3 output `capture.ts` already produces for single files. The `captureRun` signature already takes a `browser` parameter precisely for this; someone planned batch mode and never wired the iterator. Unblocks a "re-run the beta.0 regression set" pre-release gate that's practical to run on every release candidate.

  Blocks this pattern (deliberate anti-pattern worth documenting): during v1.5.0-beta.2 prep I wrote a stripped-down batch runner (`tools/verify-book-examples.ts`, deleted in the same commit that added this roadmap item) that reused one browser but dropped WAV analysis entirely — Level 2 only. Getting speed by dropping fidelity is the wrong tradeoff for a release gate. The right fix is batch mode INSIDE `capture.ts`, not a second tool.

#### Release hygiene — mechanical gates for anvideck path leaks
- [ ] **Pre-commit hook + issue/PR template lint for anvideck path references in user-facing content.** The project's dev artifacts live in an external private directory (Ground Truth docs, catalogues, investigations, research), and both `CHANGELOG.md` (v1.4.0 release notes) and the repo's design explicitly claim "the public repo is clean." The discipline is currently enforced by human memory — which fails. Concrete instances in v1.5.0-beta.2 prep alone: issue #167 body referenced the full external path to a SuperSonic doc when a `samaaron/supersonic` upstream reference would have been equally informative and not leaked the directory structure; issue #171 body referenced the external catalogue path for SP37 when a generic "acceptance criterion" phrasing would have carried the same meaning without the leak. Both were caught and redacted retroactively, but retroactive fixes don't clean up the git history, don't clean up subscriber email notifications, and don't scale as more contributors file issues and PRs.

  This is another instance of SP37 Subtype B (documentation-promised discipline, no mechanical enforcement). The cure is the same as the beta.2 composition-pair test: turn the discipline into a mechanical gate that fails closed.

  **Proposed enforcement (three layers, cheap to build):**
  1. **Pre-commit hook** — grep every staged `.md` file for external-directory patterns (e.g., `~/` paths pointing outside the repo, external dev-artifact directory names, `GROUND_TRUTH_`, `/ref/sources/`, etc.). Block the commit if found. **Exemption list:** `CLAUDE.md` is the designed exception — it intentionally contains those references so Claude Code knows where to find private dev context. Everything else fails closed.
  2. **GitHub Actions lint step** — same grep as a CI check on PRs, belt-and-suspenders for contributors who bypass the hook. Runs on `.md`, `.yml`, issue templates, and PR template files.
  3. **`gh issue create` / `gh pr create` wrapper** — optional shell wrapper or `.bashrc` function that scans the `--body` argument for the same patterns before invoking `gh`, surfacing a "are you sure?" prompt. Catches the dominant failure mode (typing external paths directly into an issue body) at the earliest possible moment. Not CI-enforceable since it's a client-side convenience.

  **Acceptance criterion:** removing any layer of the enforcement while re-adding a known-leaking issue body (e.g., the pre-redaction text of #167 or #171) must cause a visible failure. If the failure is silent, the enforcement is not real.

  **Priority:** low urgency (nothing critical leaked), high value per hour of work. The composition-pair test that caught the beta.2 `APP_VERSION` drift took ~30 minutes to write and saved a broken release. This is the same shape of fix.

#### Other
- [ ] Polish items from the v1.5.0 beta testing feedback loop (TBD based on community reports)

### Mobile / Touch
- [ ] Responsive toolbar — collapse buttons into hamburger menu on narrow screens
- [ ] Touch-friendly splitters — larger hit targets for panel resizing
- [ ] On-screen keyboard — tap to insert common DSL keywords (live_loop, play, sleep, sample)
- [ ] Swipe between buffers
- [ ] Test and fix layout on iOS Safari + Android Chrome

### Hot Reload Preferences
- [ ] Prefs changes apply immediately without re-run (volume, BPM, scope modes already do — extend to editor font size, line numbers, word wrap)
- [ ] Theme changes (scope colors, glow, trail) apply to running visualizer without restart

### Polish
- [ ] WASM boot progress indicator (loading bar during SuperSonic init)
- [ ] Test coverage reporting (Vitest coverage + badge)

---

## v1.6.0 — Post-Beta Feature Work

### OSC receive
- [ ] WebSocket-to-UDP bridge (bundled option, not just hook)
- [ ] `sync "/osc/..."` path delivery via WebSocket

### Tutorial system port (EPIC #309)

Port the ~90-chapter Desktop Sonic Pi tutorial as a first-class web subsystem — the largest remaining parity item (~98% target, lifts help coverage 311 → ~600 entries). Standalone `TutorialPanel` + structured corpus + ingest/validation tooling; `HelpPanel` (per-symbol reference) stays separate, mirroring desktop's dedicated tutorial pane. Dependency order: **T0 → T1 → {T2 → T3, T4} → T5** (~6.5 wk).

- [ ] **T0 — license & source gate (#310) — 🚧 BLOCKING: T1–T5 do not start until T0 closes GO**
- [ ] T1 — ingest pipeline + data model (#311)
- [ ] T2 — code-block validation gate, Level 2/3 (#312)
- [ ] T3 — web-adaptation overlay + "What's different from Desktop SP" chapter (#313)
- [ ] T4 — TutorialPanel UI (#314)
- [ ] T5 — polish (lazy-load, assets, search) + Level-3 observation (#315)

### Collaboration
- [ ] Ableton Link via WebRTC DataChannel
- [ ] Collaborative live coding (CRDT sync via Yjs + WebRTC)
- [ ] Code provenance — signed snapshots for LMS submission

### Architecture
- [ ] Monorepo split (`@mjayb/sonicpijs` engine, `@mjayb/sonicpijs-app` UI)
