import { VirtualTimeScheduler, DEFAULT_SCHED_AHEAD_TIME } from './VirtualTimeScheduler'
import { ProgramBuilder } from './ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from './interpreters/AudioInterpreter'
import { queryLoopProgram, type QueryEvent } from './interpreters/QueryInterpreter'
import { SuperSonicBridge, type SuperSonicBridgeOptions } from './SuperSonicBridge'
import { Recorder } from './Recorder'
import { normalizeFxParams } from './SoundLayer'
import { ALL_FX_NAMES } from './FxNames'
import { DSL_NAMES } from './DslNames'
import { createIsolatedExecutor, validateCode, type ScopeHandle } from './Sandbox'
import { autoTranspileDetailed } from './TreeSitterTranspiler'
import { getExample, type Example } from './examples'
import { initTreeSitter } from './TreeSitterTranspiler'

/**
 * Matches SoundLayer.validateAndClamp output:
 *   `[Warning] play :synth — key: val clamped to N (min)`
 *   `[Warning] with_fx :name — key: val clamped to N (max)`
 *   `[Warning] sample :name — key: val clamped to N (min|max)`
 *   `[Warning] control — key: val clamped to N (min|max)`
 * Anything matching this is a deterministic clamp message and we only need
 * to surface each unique line once per evaluation (issue #202, G4).
 */
const CLAMP_WARN_RE = /clamped to .+ \((min|max)\)$/
import { friendlyError, formatFriendlyError, type FriendlyError } from './FriendlyErrors'
import { detectStratum, Stratum } from './Stratum'
import { SoundEventStream } from './SoundEventStream'
import { ring, knit, range, line, doubles, halves, Ring } from './Ring'
import { assert, assert_equal, assert_similar, assert_not, assert_error, inc, dec } from './Asserts'
import { MidiBridge } from './MidiBridge'
import { spread } from './EuclideanRhythm'
import { noteToMidi, midiToFreq, noteToFreq, hzToMidi, noteInfo } from './NoteToFreq'
import { chord, scale, chord_invert, note, note_range, chord_degree, degree, chord_names, scale_names } from './ChordScale'
import { getSampleNames, getCategories } from './SampleCatalog'
import { loadAllCustomSamples, type CustomSampleRecord } from './CustomSampleStore'
import type { Program } from './Program'

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** 4-character base-36 suffix — enough entropy for unique in-session loop names. */
const randomSuffix = (): string => Math.random().toString(36).slice(2, 6)

// ---------------------------------------------------------------------------
// Engine interfaces
// ---------------------------------------------------------------------------

export interface EngineComponents {
  /** Sound event stream for visualization and logging. */
  streaming: { eventStream: SoundEventStream }
  /** Audio context and analyser node for scope/recording. */
  audio: { analyser: AnalyserNode; analyserL?: AnalyserNode; analyserR?: AnalyserNode; audioCtx: AudioContext; trackAnalysers?: Map<string, AnalyserNode> }
  /** Capture query for deterministic (S1/S2) code introspection. */
  capture: { queryRange(begin: number, end: number): Promise<QueryEvent[]> }
}

// ---------------------------------------------------------------------------
// SonicPiEngine
// ---------------------------------------------------------------------------

export class SonicPiEngine {
  private scheduler: VirtualTimeScheduler | null = null
  private bridge: SuperSonicBridge | null = null
  private eventStream = new SoundEventStream()
  private initialized = false
  private playing = false
  private runtimeErrorHandler: ((err: Error) => void) | null = null
  private printHandler: ((msg: string) => void) | null = null
  private cueHandler: ((name: string, time: number) => void) | null = null
  private loadExampleHandler: ((example: Example) => void) | null = null
  /**
   * Per-evaluation dedup set for clamp/range warnings (issue #202, G4).
   * SoundLayer's validateAndClamp emits one warning per out-of-range param,
   * which fires every loop iteration → log floods. We dedup by exact message
   * so the user sees each unique clamp once per evaluation.
   * Cleared on each evaluate() call (re-running the user's code resets the
   * "what have we already told them" memory — they may have changed the
   * offending value, or want to be told again because they re-pressed Run).
   */
  private warnDedup = new Set<string>()
  private currentCode = ''
  private currentStratum: Stratum = Stratum.S1
  private bridgeOptions: SuperSonicBridgeOptions
  private schedAheadTime: number
  /** Maps DSL nodeRef → SuperSonic nodeId for control messages */
  private nodeRefMap = new Map<number, number>()
  /** Reusable inner FX nodes — persists across loop iterations. See issue #70.
   *  `killTimer` is the pending `setTimeout` handle that frees this FX 1s after
   *  its last iteration if no follow-up iteration cancels it. On hot-swap /
   *  stop we MUST clearTimeout these before dropping the map entries, otherwise
   *  the stale timer fires later and calls freeBus/freeGroup on what are by
   *  then NEW live FX resources — corrupting the bus pool and silently killing
   *  groups (issue #290). */
  private reusableFx = new Map<string, { bus: number; groupId: number; nodeId: number; outBus: number; killTimer?: ReturnType<typeof setTimeout> }>()
  /** Pending volume to apply when bridge initializes */
  private pendingVolume: number | null = null
  /** Stored builder functions for capture/query path */
  private loopBuilders = new Map<string, (b: ProgramBuilder) => void>()
  /** Per-loop seed counters for deterministic random */
  private loopSeeds = new Map<string, number>()
  /** Per-loop tick counters — persisted across iterations so ring.tick() advances correctly */
  private loopTicks = new Map<string, Map<string, number>>()
  /** Per-loop beat counter — persisted across iterations so current_beat keeps growing (#226) */
  private loopBeats = new Map<string, number>()
  /** Tracks which loops have completed their initial sync — persists across hot-swaps. */
  private loopSynced = new Set<string>()
  /**
   * Build-phase nesting depth (issue #198). Incremented around each
   * synchronous builderFn invocation. > 0 means we are currently
   * building one live_loop's iteration step array; any `live_loop`
   * call that fires now is a NESTED registration and gets sibling-once
   * semantics rather than re-binding on every outer tick.
   */
  private buildNestingDepth = 0
  /** Names that already received the "nested live_loop" warning so we don't spam. */
  private nestedWarned = new Set<string>()
  /**
   * The ProgramBuilder currently executing its synchronous builderFn (SP72).
   * Set in `asyncFn` around the `builderFn(builder)` call, restored on exit.
   * When a nested `live_loop` registers from inside another's builderFn,
   * `wrappedLiveLoop` reads `currentBuildBuilder.currentBpm` /
   * `currentBuildBuilder.currentDefaultSynth` to inherit the parent's
   * in-flight bpm/synth — which is what `b.use_bpm(N)` / `b.use_synth(:n)`
   * inside the parent's body just set. The engine-level `defaultBpm` /
   * `defaultSynth` are mutated only by *top-level* `use_bpm` / `use_synth`,
   * so they would yield the wrong value here (commonly 60 / 'beep' for
   * code wrapped in `in_thread` by capture tools).
   */
  private currentBuildBuilder: ProgramBuilder | null = null
  /** Persistent top-level FX state — keyed by scope ID, shared across loops in same with_fx. */
  private persistentFx = new Map<string, { buses: number[]; groups: number[]; outBus: number }>()
  /** Maps loop name → FX scope ID (loops under same with_fx share a scope). */
  private loopFxScope = new Map<string, string>()
  /** Maps FX scope ID → FX chain definition. */
  private fxScopeChains = new Map<string, Array<{ name: string; opts: Record<string, number> }>>()
  /** Compile-once cache: source code → transpiled JS. Reused on hot-swap with unchanged code (#8). */
  private transpileCache = new Map<string, string>()
  /**
   * MIDI I/O bridge — exposed for shell-level device management (listing devices,
   * opening ports, registering event handlers). Not intended for direct note
   * triggering from application code; use the DSL functions (`midi_note_on`,
   * `midi_cc`, etc.) inside `live_loop` blocks instead, so events are
   * scheduler-aware and time-stamped correctly.
   */
  readonly midiBridge = new MidiBridge()
  /** Global key-value store — shared across all loops via get/set */
  private globalStore = new Map<string | symbol, unknown>()
  /** User-defined functions — `define`/`ndefine` register here. Seeded back into the
   *  next eval's scopeBase so removing a `define` line from the buffer does not
   *  break a still-running live_loop that calls it. (#215) */
  private definedFns = new Map<string, (...args: unknown[]) => unknown>()
  /**
   * True only while evaluating the synchronous top-level body of user code
   * (the window between `sandbox.execute(...)` start and resolve in
   * `evaluate()`). Used by `run_code` and `load_example` to refuse calls
   * that come from inside a live_loop body's later async iteration —
   * re-entering `evaluate` from there would dispose the running scheduler
   * mid-iteration. (#240 / #241)
   */
  private inTopLevelEval = false
  /** Cached `defonce` values (#212 / #233). Survive across re-evals — that's
   *  the whole point. Cleared only on full engine reset / dispose. */
  private defonceCache = new Map<string, unknown>()
  /** Host-provided OSC send handler. Engine fires this; host wires to actual transport. */
  private oscHandler: ((host: string, port: number, path: string, ...args: unknown[]) => void) | null = null
  /** Active Recorder instance (#228). Null when not recording. */
  private recorder: Recorder | null = null
  /** Last completed recording, awaiting recording_save / recording_delete (#228). */
  private lastRecording: Blob | null = null
  /**
   * In-flight stop+encode promise (#228). recording_stop is async — the
   * MediaRecorder.onstop fires after a chunk flush, then we decode webm and
   * re-encode as WAV. recording_save must await this so the natural pattern
   *   recording_start; play …; recording_stop; recording_save "x.wav"
   * does not save before the blob is ready.
   */
  private pendingRecordingStop: Promise<void> | null = null

  get schedAhead(): number { return this.schedAheadTime }

  constructor(options?: {
    bridge?: SuperSonicBridgeOptions
    schedAheadTime?: number
  }) {
    this.bridgeOptions = options?.bridge ?? {}
    this.schedAheadTime = options?.schedAheadTime ?? DEFAULT_SCHED_AHEAD_TIME
  }

  /**
   * Initialize the engine. Must be called once before `evaluate()`.
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * Audio initializes via SuperSonic (WebAssembly). If that fails (e.g. in
   * test environments or when WebAssembly is blocked), the engine continues
   * without audio — the scheduler still runs and `capture` queries still work.
   * Check `hasAudio` after `init()` to know whether audio is available.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    this.bridge = new SuperSonicBridge(this.bridgeOptions)
    // Forward clamp/validation warnings from SoundLayer (for samples) to the
    // UI log. Handles the case where setPrintHandler was called before init.
    if (this.printHandler) this.bridge.warnHandler = this.printHandler

    // Initialize SuperSonic and tree-sitter in parallel
    const bridgeInit = this.bridge.init()
      .then(() => {
        if (this.pendingVolume !== null) {
          this.bridge!.setMasterVolume(this.pendingVolume)
        }
        // Wire OSC trace logging — shows exactly what params are sent to scsynth,
        // matching desktop Sonic Pi's trace format for easy comparison.
        this.bridge!.setOscTraceHandler((msg) => {
          if (this.printHandler) this.printHandler(msg)
        })
        // Preload every FX synthdef binary now so the first `with_fx` doesn't
        // pay fetch+/d_recv latency at /s_new time. Fire-and-forget — failures
        // (CDN miss for an individual FX) surface lazily per SP5 when that FX
        // is actually used. Awaiting would gate first audio on ~40 fetches,
        // which we'd rather absorb in the background after bridge init.
        this.bridge!.preloadFxSynthDefs(ALL_FX_NAMES).catch(() => { /* lazy retry */ })
      })
      .catch((err) => {
        console.warn('[SonicPi] SuperSonic init failed, running without audio:', err)
        this.bridge = null
      })

    // Only init tree-sitter in browser environments where WASM is served via HTTP.
    // In Node (tests), tree-sitter must be initialized explicitly with file paths.
    const isBrowser = typeof window !== 'undefined'
    const treeSitterInit = isBrowser
      ? initTreeSitter().catch(() => { /* Non-fatal — regex fallback */ })
      : Promise.resolve()

    await Promise.all([bridgeInit, treeSitterInit])

    // Wire MIDI input events → scheduler cues.
    // Desktop SP format: `/midi:device_name:channel/event_type` (#151).
    // We use `*` as the device name since WebMIDI device names don't match
    // Desktop SP's naming convention. Also fire the short `/midi/event_type`
    // for backward compatibility — both forms resolve via wildcard sync (#150).
    this.midiBridge.onMidiEvent((event) => {
      const sched = this.scheduler
      if (!sched) return
      const ch = event.channel ?? 1
      // Desktop SP format: /midi:*:channel/type
      sched.fireCue(`/midi:*:${ch}/${event.type}`, '__midi__', [event])
      // Short format for backward compatibility
      sched.fireCue(`/midi/${event.type}`, '__midi__', [event])
    })

    this.initialized = true
  }

  /** Whether audio output is available. False when SuperSonic failed to initialize. */
  get hasAudio(): boolean {
    return this.bridge !== null
  }

  /**
   * Evaluate and schedule a Sonic Pi program.
   *
   * Accepts Ruby DSL syntax (auto-transpiled) or raw JS builder code.
   * On the first call, `play()` must be called afterward to start the scheduler.
   * On subsequent calls while playing, loops are hot-swapped in place.
   *
   * Returns `{ error }` on syntax or runtime errors during evaluation.
   * Does NOT throw — check the return value. Runtime errors inside `live_loop`
   * bodies after the scheduler has started are delivered via `setRuntimeErrorHandler`.
   */
  async evaluate(code: string): Promise<{ error?: Error }> {
    if (!this.initialized) {
      return { error: new Error('SonicPiEngine not initialized — call init() first') }
    }

    try {
      // No-op Update short-circuit: if the user clicks Update without
      // changing a single character, hot-swap is pure churn — it would kill
      // every running synth, recreate FX, and restart loop iterations even
      // though the new code is identical to the old. The audible result is
      // a perceived "the music changed" glitch even though nothing should
      // have. Detect the no-op case and return early. Music continues
      // seamlessly. Matches the desktop SP "no-change Run is invisible" feel.
      const isReEvaluate = this.scheduler !== null && this.playing
      if (isReEvaluate && code === this.currentCode) {
        return {}
      }

      this.currentCode = code
      this.currentStratum = detectStratum(code)
      // Reset clamp-warning dedup so re-pressing Run re-surfaces clamp messages
      // (the user may have changed the offending value, and they shouldn't be
      // forever-silenced because we already showed the warning once).
      this.warnDedup.clear()

      // First run or after stop: create fresh scheduler
      if (!isReEvaluate) {
        if (this.scheduler) {
          this.scheduler.dispose()
        }

        const audioCtx = this.bridge?.audioContext
        this.scheduler = new VirtualTimeScheduler({
          getAudioTime: () => audioCtx?.currentTime ?? 0,
          schedAheadTime: this.schedAheadTime,
        })

        this.scheduler.onLoopError((loopName, err) => {
          const msg = `Error in loop '${loopName}': ${err.message}`
          if (this.runtimeErrorHandler) this.runtimeErrorHandler(err)
          if (this.printHandler) this.printHandler(msg)
          else console.error('[SonicPi]', msg)
        })

        this.scheduler.onEvent((event) => {
          if (event.type === 'cue' && this.cueHandler) {
            const name = (event.params as { name: string }).name
            this.cueHandler(name, event.audioTime)
          }
        })

        this.loopBuilders.clear()
        this.loopSeeds.clear()
      }

      // Transpile: Ruby DSL → JS builder chain (TreeSitter only).
      // Compile-once cache (#8): skip transpilation on hot-swap with unchanged code.
      let transpiledCode: string
      const cached = this.transpileCache.get(code)
      if (cached) {
        transpiledCode = cached
      } else {
        const result = autoTranspileDetailed(code)
        if (result.hasError) {
          // Parse errors — don't execute, return error to UI
          const errorMsg = result.errorMessage || 'Unknown syntax error'
          return { error: new SyntaxError(errorMsg) }
        }
        transpiledCode = result.code
        this.transpileCache.set(code, transpiledCode)
      }

      // Reconcile live audio (mic) streams against the new code (#152).
      // On hot-swap, if the old code used `synth :sound_in` but the new one
      // doesn't, the mic would otherwise stay connected and the browser's
      // recording indicator would stay lit across the edit. Check the
      // transpiled source for each sound_in variant; stop any stream whose
      // name no longer appears.
      if (this.bridge) {
        const stillUsed = {
          sound_in: /['"]sound_in['"]/.test(transpiledCode),
          sound_in_stereo: /['"]sound_in_stereo['"]/.test(transpiledCode),
        }
        if (!stillUsed.sound_in) this.bridge.stopLiveAudio('sound_in')
        if (!stillUsed.sound_in_stereo) this.bridge.stopLiveAudio('sound_in_stereo')
      }

      // Top-level DSL state
      let defaultBpm = 60
      let defaultSynth = 'beep'
      const scheduler = this.scheduler!

      const topLevelUseBpm = (bpm: number) => { defaultBpm = bpm }
      const topLevelUseSynth = (name: string) => { defaultSynth = name }
      // Top-level use_arg_bpm_scaling — no-op at top level (inside live_loops, b.use_arg_bpm_scaling handles it)
      const topLevelUseArgBpmScaling = (_enabled: boolean) => { /* no-op */ }
      const topLevelWithArgBpmScaling = (_enabled: boolean, fn: () => void) => { fn() }

      // Collection map for re-evaluate hot-swap path
      const pendingLoops = new Map<string, () => Promise<void>>()
      const pendingDefaults = new Map<string, { bpm: number; synth: string }>()

      // Top-level set_volume! — Desktop SP range is 0-5, maps to mixer pre_amp.
      // currentVolume is captured by closures (set_volume + current_volume_fn +
      // setVolumeShared). Deferred set_volume steps fire setVolumeShared at
      // scheduled time so current_volume reflects the new value (#201).
      let currentVolume = 1
      const set_volume = (vol: number) => {
        currentVolume = Math.max(0, Math.min(5, vol))
        this.bridge?.setMasterVolume(currentVolume / 5) // normalize 0-5 → 0-1
      }
      // Used by AudioInterpreter's setVolume step — same body as set_volume,
      // but exposed as a stable reference so the interpreter can update the
      // shared currentVolume closure variable.
      const setVolumeShared = (vol: number) => set_volume(vol)

      // Top-level current_* introspection functions
      const current_synth_fn = () => defaultSynth
      const current_volume_fn = () => currentVolume

      // Recording (#228) — deferred-step lifecycle. ProgramBuilder pushes
      // recordingStart/Stop/Save/Delete steps; the AudioInterpreter fires
      // this single handler at scheduled virtual time. Engine-side state
      // (this.recorder, this.lastRecording) is the live receiver.
      //
      // Why deferred and not top-level immediate: bare top-level user code
      // gets wrapped into live_loop :__run_once, where __b.sleep advances
      // virtual time. If the recording_* calls were immediate, they'd all
      // fire during the build pass — recording_save would run before any
      // audio plays and lastRecording would be null.
      //
      // Tap point is masterOutputNode, downstream of all SoundLayer param
      // normalization, so the WAV captures exactly what the user hears.
      const warn = (msg: string) => {
        if (this.printHandler) this.printHandler(`[Warning] ${msg}`)
        else console.warn('[SonicPi]', msg)
      }
      const recordingHandler = async (
        kind: 'start' | 'stop' | 'save' | 'delete',
        filename?: string,
      ): Promise<void> => {
        switch (kind) {
          case 'start': {
            if (this.recorder && this.recorder.state === 'recording') {
              warn('recording_start: already recording — call recording_stop first')
              return
            }
            const audioCtx = this.bridge?.audioContext
            const tap = this.bridge?.masterOutputNode
            if (!audioCtx || !tap) {
              warn('recording_start: audio bridge not initialised — recording skipped')
              return
            }
            this.recorder = new Recorder(audioCtx, tap)
            this.recorder.start()
            return
          }
          case 'stop': {
            if (!this.recorder || this.recorder.state !== 'recording') {
              return // silent no-op (matches Desktop SP)
            }
            const r = this.recorder
            this.recorder = null
            // Track the in-flight stop+encode so a subsequent recording_save
            // can await it. Without this, the natural script
            //   recording_start; play …; recording_stop; recording_save "x"
            // would run save before the blob existed and get nothing.
            this.pendingRecordingStop = (async () => {
              try {
                this.lastRecording = await r.stop()
              } catch (err) {
                warn(`recording_stop: ${(err as Error).message}`)
              }
            })()
            await this.pendingRecordingStop
            return
          }
          case 'save': {
            // If a stop is still encoding, wait for it. Belt-and-braces —
            // the recordingStop step already awaits, but a user calling
            // recording_save without an immediately-preceding stop in the
            // same program (e.g. across re-evaluates) still gets correctness.
            if (this.pendingRecordingStop) {
              await this.pendingRecordingStop
            }
            if (!this.lastRecording) {
              warn('recording_save: no completed recording to save (call recording_stop first)')
              return
            }
            Recorder.saveBlobToDownload(this.lastRecording, filename)
            return
          }
          case 'delete':
            this.lastRecording = null
            return
        }
      }

      // Catalog queries
      const synth_names_fn = () => [
        // Bells / oscillators
        'beep','sine','saw','prophet','tb303','supersaw','pluck','pretty_bell','dull_bell','piano',
        'dsaw','dpulse','dtri','square','tri','pulse','subpulse','fm',
        // Mod synths
        'mod_fm','mod_saw','mod_dsaw','mod_sine','mod_beep','mod_tri','mod_pulse',
        // Noise variants
        'noise','pnoise','bnoise','gnoise','cnoise',
        // Chip
        'chipbass','chiplead','chipnoise',
        // Vintage / classic
        'dark_ambience','hollow','growl','zawa','blade','tech_saws','hoover',
        'bass_foundation','bass_highend','organ_tonewheel',
        // Plucked / acoustic family
        'rhodey','rodeo','kalimba','gabberkick',
        // SC808 drum kit
        'sc808_bassdrum','sc808_snare','sc808_clap','sc808_tomlo','sc808_tommid','sc808_tomhi',
        'sc808_congalo','sc808_congamid','sc808_congahi','sc808_rimshot','sc808_claves',
        'sc808_maracas','sc808_cowbell','sc808_closed_hihat','sc808_open_hihat','sc808_cymbal',
        // Note: dark_sea_horn, singer, winwood_lead are in Desktop SP's synthinfo.rb
        //   but their compiled .scsyndef binaries are not published on the SuperSonic CDN
        //   (HTTP 404 at all known versions). Listing them would cause /s_new dispatch
        //   to silently fail per SP5. Track in artifacts/designs/full-parity-gaps.md.
        // Note: sound_in, sound_in_stereo, live_audio require Web Audio mic permission
        //   plumbing which is not yet implemented. Track separately.
      ]
      // Sourced from FxNames.ts — same array used by bridge.preloadFxSynthDefs
      // during engine.init so the introspector and the preloader can't drift.
      const fx_names_fn = () => [...ALL_FX_NAMES]

      // load_sample — no-op (samples auto-load on first use via CDN)
      const load_sample_fn = (_name: string) => { /* auto-loaded on first use */ }

      // sample_info — return duration via bridge
      const sample_info_fn = (name: string) => {
        const dur = this.bridge?.getSampleDuration(name)
        return dur !== undefined ? { duration: dur } : null
      }

      // all_sample_names — from the sample catalog
      const all_sample_names_fn = () => sample_names()

      // Top-level print handler
      const topLevelPuts = (...args: unknown[]) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        if (this.printHandler) this.printHandler(msg)
        else console.log('[SonicPi]', msg)
      }

      // Top-level stop sentinel
      const topLevelStop = () => {
        // At top level, stop just halts evaluation
      }

      // stop_loop :name — stop a named loop from any context
      const stop_loop = (name: string): void => {
        scheduler.stopLoop(name)
      }

      // Scope handle — set when executor is created, used to isolate loop scopes
      let scopeHandle: ScopeHandle | null = null

      const wrappedLiveLoop = (name: string, builderFnOrOpts: ((b: ProgramBuilder) => void) | Record<string, unknown>, maybeFn?: (b: ProgramBuilder) => void) => {
        // Support both: live_loop("name", fn) and live_loop("name", {sync: "x"}, fn)
        let builderFn: (b: ProgramBuilder) => void
        let syncTarget: string | null = null
        if (typeof builderFnOrOpts === 'function') {
          builderFn = builderFnOrOpts
        } else {
          syncTarget = (builderFnOrOpts.sync as string) ?? null
          builderFn = maybeFn!
        }

        // Nested live_loop semantics (issue #198): if this call fires while
        // another live_loop's builderFn is mid-execution (buildNestingDepth > 0),
        // treat it as a SIBLING top-level registration with first-occurrence-wins
        // semantics. Without this guard the inner registration would re-fire on
        // every outer iteration — re-binding the inner's tick state, sync state,
        // and seeded RNG every outer tick, and (worse) leaking a per-loop monitor
        // synth + bus on each rebinding.
        //
        // Re-evaluate (Run on already-playing code) bypasses this branch via
        // `isReEvaluate` below so hot-swap still refreshes inner closures.
        const isNested = this.buildNestingDepth > 0 && !isReEvaluate
        if (isNested) {
          const existing = scheduler.getTask(name)
          if (existing && existing.running) {
            // Already registered on a previous outer iteration — sibling-once.
            // No-op for registration; the inner keeps running its existing closure.
            return
          }
          if (!this.nestedWarned.has(name)) {
            this.nestedWarned.add(name)
            const msg =
              `[Warning] live_loop :${name} is declared inside another live_loop. ` +
              `It will be registered as a sibling top-level loop on FIRST occurrence only. ` +
              `Any guards (if/unless/one_in/...) wrapping it are evaluated at first occurrence; ` +
              `subsequent toggles do not register or unregister it.`
            if (this.printHandler) this.printHandler(msg)
            else console.warn('[SonicPi]', msg)
          }
          // Fall through to register the inner this first time.
        }
        // Per-loop audio isolation: create a monitor synth that reads this
        // loop's private loopBus and fans out to bus 0 (mixer) + trackBus
        // (per-track AnalyserNode for scope visualization). Synths in this
        // loop write to loopBus via task.outBus; the monitor ensures audio
        // still reaches the mixer without bypassing it. See issue #177.
        const loopBus = this.bridge?.createLoopMonitor(name) ?? 0

        // Store builder function for capture path
        this.loopBuilders.set(name, builderFn)
        if (!this.loopSeeds.has(name)) {
          // Seed derived from loop name — each loop gets a unique PRNG sequence
          // (matches desktop Sonic Pi's per-loop deterministic seeding)
          let hash = 0
          for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
          }
          this.loopSeeds.set(name, Math.abs(hash))
        }

        // Create the async function that builds a Program each iteration
        // and runs it via AudioInterpreter
        const asyncFn = async () => {
          // sync: option — wait for the cue ONCE before the first iteration only.
          // Uses engine-level loopSynced set so the flag persists across hot-swaps.
          // Sonic Pi: sync: is passed to in_thread, called ONCE before loop starts.
          // Thread keeps running on Update — define() replaces the fn, send() picks it up.
          if (syncTarget && !this.loopSynced.has(name)) {
            this.loopSynced.add(name)
            await scheduler.waitForSync(syncTarget, name)
          }

          const task = scheduler.getTask(name)
          if (!task) return

          // Persistent top-level FX: create FX nodes on first iteration only.
          // Loops under the same with_fx scope share one FX chain (keyed by scope ID).
          // First loop to iterate creates the nodes; others reuse the same bus.
          const scopeId = this.loopFxScope.get(name)
          if (scopeId && !this.persistentFx.has(scopeId) && this.bridge) {
            const fxChain = this.fxScopeChains.get(scopeId)
            if (fxChain && fxChain.length > 0) {
              const audioTime = task.virtualTime + this.schedAheadTime
              let currentOutBus = task.outBus
              const buses: number[] = []
              const groups: number[] = []

              // Create FX chain: outermost first
              // Signal flow: synth → innermost FX bus → ... → outermost FX → output
              for (const fx of fxChain) {
                const bus = this.bridge.allocateBus()
                const groupId = this.bridge.createFxGroup()
                const fxWarn = this.printHandler
                  ? (m: string) => this.printHandler!(`[Warning] with_fx :${fx.name} — ${m}`)
                  : undefined
                const fxOpts = normalizeFxParams(fx.name, fx.opts, task.bpm, fxWarn)
                await this.bridge.applyFx(fx.name, audioTime, fxOpts, bus, currentOutBus)
                this.bridge.flushMessages()
                buses.push(bus)
                groups.push(groupId)
                currentOutBus = bus
              }

              this.persistentFx.set(scopeId, { buses, groups, outBus: currentOutBus })
            }
          }

          // Apply persistent FX bus — synths write to shared FX input bus
          if (scopeId) {
            const fxState = this.persistentFx.get(scopeId)
            if (fxState) {
              task.outBus = fxState.outBus
            }
          }

          const seed = this.loopSeeds.get(name) ?? 0
          this.loopSeeds.set(name, seed + 1)

          const builder = new ProgramBuilder(seed, this.loopTicks.get(name))
          // Apply the loop's synth default (set by top-level use_synth)
          if (task.currentSynth && task.currentSynth !== 'beep') {
            builder.use_synth(task.currentSynth)
          }
          // Seed introspection state for current_time / current_beat (#226).
          // task.virtualTime is the iteration-start audio time (advances on sleep).
          // loopBeats persists current_beat across iterations like loopTicks does.
          // task.bpm seeds the builder's bpm so current_beat_duration reflects a
          // top-level use_bpm; user's own use_bpm inside the body overrides.
          builder.setIterationContext(
            task.virtualTime,
            this.loopBeats.get(name) ?? 0,
            this.schedAheadTime,
            task.bpm,
          )
          // Enter per-loop scope so variable writes are isolated.
          // Track build-phase nesting depth so any `live_loop` call that
          // fires synchronously inside builderFn is detected as nested
          // (issue #198). The scheduler runs builderFn calls sequentially,
          // so an instance-level counter is safe.
          scopeHandle?.enterScope(name)
          this.buildNestingDepth++
          // SP72: expose this builder to nested wrappedLiveLoop calls that fire
          // synchronously inside builderFn. They need our `_currentBpm` /
          // `currentSynth` (mutated by `b.use_bpm` / `b.use_synth` during this
          // build phase) to inherit the correct values, instead of reading
          // engine-level defaultBpm / defaultSynth (which are mutated only by
          // top-level use_bpm / use_synth and would yield 60 / 'beep' for code
          // wrapped in `in_thread` by capture tools). JS is single-threaded so
          // builderFn never interleaves with another asyncFn — a single field
          // is safe; we still push/restore so nested live_loops nested in
          // ANOTHER live_loop's body still see the correct (innermost) parent.
          const prevBuildBuilder = this.currentBuildBuilder
          this.currentBuildBuilder = builder
          try {
            builderFn(builder)
          } finally {
            this.currentBuildBuilder = prevBuildBuilder
            this.buildNestingDepth--
            scopeHandle?.exitScope()
          }
          // Persist tick state so ring.tick() / tick() advance across iterations
          this.loopTicks.set(name, builder.getTicks())
          // Persist beat counter so current_beat keeps advancing across iterations (#226)
          this.loopBeats.set(name, builder.currentBeatRaw)
          const program = builder.build()

          await runProgram(program, {
            bridge: this.bridge,
            scheduler,
            taskId: name,
            eventStream: this.eventStream,
            schedAheadTime: this.schedAheadTime,
            printHandler: this.printHandler ?? undefined,
            nodeRefMap: this.nodeRefMap,
            reusableFx: this.reusableFx,
            globalStore: this.globalStore,
            oscHandler: this.oscHandler ?? undefined,
            midiBridge: this.midiBridge,
            onVolumeChange: setVolumeShared,
            onRecordingEvent: recordingHandler,
          })

          // Auto-cue the loop name after each iteration.
          // In Sonic Pi, `live_loop :foo` auto-cues `:foo` on each iteration
          // so that `live_loop :bar, sync: :foo` can synchronize to it.
          scheduler.fireCue(name, name)
        }

        // SP72: when this registration fires from inside a parent builderFn
        // (buildNestingDepth > 0), the user's intent is "inherit the in-flight
        // bpm/synth from my parent thread/loop". The parent's `b.use_bpm(N)` /
        // `b.use_synth(:n)` mutated the parent ProgramBuilder's local state but
        // did NOT touch engine-level defaultBpm/defaultSynth (those mutate only
        // from top-level use_bpm/use_synth). Read from the parent builder if
        // we have one, else fall back to engine defaults.
        const parentBuilder = this.currentBuildBuilder
        const inheritedBpm = (this.buildNestingDepth > 0 && parentBuilder)
          ? parentBuilder.currentBpm : defaultBpm
        const inheritedSynth = (this.buildNestingDepth > 0 && parentBuilder)
          ? parentBuilder.currentDefaultSynth : defaultSynth

        if (this.buildNestingDepth > 0 && isReEvaluate) {
          // Nested hot-swap (issue #199): this call is firing from inside an
          // outer live_loop's iteration, AFTER the top-level evaluate()'s
          // pendingLoops reconciliation has already completed. Routing
          // through pendingLoops would be futile — nobody picks up the entry.
          // Hot-swap directly via the scheduler to refresh the inner closure
          // (SV6: preserves virtualTime, bpm, density, random state).
          const existing = scheduler.getTask(name)
          if (existing && existing.running) {
            scheduler.hotSwap(name, asyncFn)
            // Mirror the regular hot-swap path (#262): freeAllNodes ran during
            // the outer's reEvaluate, so the inner's old loopBus is dead. Bind
            // task.outBus to the freshly-allocated bus, and refresh bpm /
            // currentSynth so a top-level use_bpm/use_synth change propagates.
            // SP72: nested hot-swap inherits from parent builder, not defaults.
            existing.bpm = inheritedBpm
            existing.currentSynth = inheritedSynth
            existing.outBus = loopBus
          } else {
            // New inner declared during hot-swap (e.g. user added it on Run).
            scheduler.registerLoop(name, asyncFn, { bpm: inheritedBpm, synth: inheritedSynth })
            const task = scheduler.getTask(name)
            if (task) task.outBus = loopBus
          }
        } else if (isReEvaluate) {
          pendingLoops.set(name, asyncFn)
          pendingDefaults.set(name, { bpm: defaultBpm, synth: defaultSynth })
        } else {
          scheduler.registerLoop(name, asyncFn)
          const task = scheduler.getTask(name)
          if (task) {
            // SP72: nested initial registration inherits parent builder's bpm
            // and synth (set by `b.use_bpm`/`b.use_synth` inside the parent's
            // builderFn body). Top-level registrations (depth=0) use the
            // engine-level defaults — unchanged from prior behavior.
            task.bpm = inheritedBpm
            task.currentSynth = inheritedSynth
            task.outBus = loopBus
          }
        }
      }

      // Top-level with_fx: wraps live_loops inside it with FX context.
      // The callback receives a dummy builder — live_loops define their own.
      // FX is applied by wrapping each live_loop's builder function.
      // Stack of top-level FX — nested with_fx accumulates, innermost is last.
      // When a live_loop is registered, ALL stacked FX wrap its builder.
      const topFxStack: Array<{ name: string; opts: Record<string, number> }> = []
      /** Current FX scope ID — set when entering a with_fx block, used by live_loops inside. */
      let currentFxScopeId: string | null = null
      let fxScopeCounter = 0

      const topLevelWithFx = (
        fxName: string,
        optsOrFn: Record<string, number> | ((b: unknown) => void),
        maybeFn?: (b: unknown) => void
      ) => {
        let opts: Record<string, number>
        let fn: (b: unknown) => void
        if (typeof optsOrFn === 'function') {
          opts = {}
          fn = optsOrFn
        } else {
          opts = optsOrFn
          fn = maybeFn!
        }
        topFxStack.push({ name: fxName, opts })
        // Generate scope ID for the outermost with_fx (nested ones reuse it)
        const isOutermost = currentFxScopeId === null
        if (isOutermost) {
          currentFxScopeId = `__fxscope_${fxScopeCounter++}`
        }
        try {
          fn(null) // execute callback to register live_loops
        } finally {
          topFxStack.pop()
          if (isOutermost) {
            currentFxScopeId = null
          }
        }
      }

      // Patch wrappedLiveLoop to handle top-level FX.
      // Instead of wrapping the builder with b.with_fx() (which creates FX per iteration),
      // capture the FX chain and create persistent FX nodes on first iteration only.
      // Matches desktop Sonic Pi: top-level with_fx creates FX once, GC blocked by subthread.join.
      const originalWrappedLiveLoop = wrappedLiveLoop
      const fxAwareWrappedLiveLoop = (name: string, builderFnOrOpts: ((b: ProgramBuilder) => void) | Record<string, unknown>, maybeFn?: (b: ProgramBuilder) => void) => {
        let builderFn: (b: ProgramBuilder) => void
        let opts: Record<string, unknown> | null = null
        if (typeof builderFnOrOpts === 'function') {
          builderFn = builderFnOrOpts
        } else {
          opts = builderFnOrOpts
          builderFn = maybeFn!
        }
        if (topFxStack.length > 0 && currentFxScopeId) {
          // Generate scope ID from FX stack contents — loops with identical FX chains share one scope.
          // Different inner with_fx (e.g., reverb(0.5) vs reverb(0.8)) get separate scopes,
          // but loops inside the SAME with_fx block share FX nodes.
          const stackFingerprint = topFxStack.map(f =>
            `${f.name}:${JSON.stringify(f.opts)}`
          ).join('|')
          const scopeId = `${currentFxScopeId}:${stackFingerprint}`
          this.loopFxScope.set(name, scopeId)
          if (!this.fxScopeChains.has(scopeId)) {
            this.fxScopeChains.set(scopeId, [...topFxStack])
          }
          // Register with ORIGINAL builder (no FX wrapping)
          if (opts) {
            originalWrappedLiveLoop(name, opts, builderFn)
          } else {
            originalWrappedLiveLoop(name, builderFn)
          }
        } else {
          if (opts) {
            originalWrappedLiveLoop(name, opts, builderFn)
          } else {
            originalWrappedLiveLoop(name, builderFn)
          }
        }
      }

      // Top-level use_random_seed: store for deterministic live_loop seeding,
      // AND reset the topLevelBuilder's RNG so top-level rrand/choose/pick/shuffle
      // are deterministic against the user-supplied seed (#217). Desktop SP
      // convention: re-running the same buffer with the same seed produces
      // the same random sequence.
      let storedRandomSeed: number | null = null
      const topLevelUseRandomSeed = (seed: number) => {
        storedRandomSeed = seed
        topLevelBuilder.use_random_seed(seed)
      }

      // Top-level in_thread: wrap callback in a one-shot live_loop
      const topLevelInThread = (fn: (b: ProgramBuilder) => void) => {
        const name = `__thread_${Date.now()}_${randomSuffix()}`
        fxAwareWrappedLiveLoop(name, (b: ProgramBuilder) => {
          fn(b)
          b.stop()
        })
      }

      // Top-level at: create one-shot loops with time offsets
      const topLevelAt = (
        times: number[],
        values: unknown[] | null,
        fn: (b: ProgramBuilder, ...args: unknown[]) => void
      ) => {
        for (let i = 0; i < times.length; i++) {
          const t = times[i]
          const v = values ? values[i] : undefined
          const name = `__at_${Date.now()}_${i}_${randomSuffix()}`
          fxAwareWrappedLiveLoop(name, (b: ProgramBuilder) => {
            if (t > 0) b.sleep(t)
            if (v !== undefined) {
              fn(b, v)
            } else {
              fn(b)
            }
            b.stop()
          })
        }
      }

      // Top-level density: just call the callback (density only affects b.sleep)
      const topLevelDensity = (_factor: number, fn: (b: unknown) => void) => {
        // Check if fn is the callback (density N do ... end → density(N, (b) => { ... }))
        if (typeof _factor === 'function') {
          ;(_factor as unknown as (b: unknown) => void)(null)
        } else if (typeof fn === 'function') {
          fn(null)
        }
      }

      // ----- Global store (get/set) -----
      // Shared across all loops. Supports both forms used in Sonic Pi:
      //   get(:key)  → function call (transpiles to get("key"))
      //   get[:key]  → bracket access (transpiles to get["key"])
      // The bracket form needs a Proxy — a plain function has no "key" property,
      // so `get["key"]` would return undefined. The Proxy routes property access
      // through the store while leaving `get(...)` calls and standard function
      // internals (name, length, call, apply, Symbol.toPrimitive, ...) alone.
      const set = (key: string | symbol, value: unknown): void => {
        this.globalStore.set(key, value)
      }
      const storeGet = (key: string | symbol): unknown => this.globalStore.get(key) ?? null
      const getFn = (key: string | symbol): unknown => storeGet(key)
      const get = new Proxy(getFn, {
        get(target, property, receiver) {
          // Symbols and real function properties fall through to the target
          // so Reflect / Function internals keep working.
          if (typeof property === 'symbol' || property in target) {
            return Reflect.get(target, property, receiver)
          }
          return storeGet(property)
        },
      })

      // ----- MIDI input readers -----
      const get_cc = (controller: number, channel: number = 1): number =>
        this.midiBridge.getCCValue(controller, channel)
      const get_pitch_bend = (channel: number = 1): number =>
        this.midiBridge.getPitchBend(channel)

      // ----- Sample catalog -----
      const sample_names = (): string[] => getSampleNames()
      const sample_groups = (): string[] => getCategories()
      const sample_loaded = (name: string): boolean => {
        if (!this.bridge) return false
        return this.bridge.isSampleLoaded(name)
      }
      const sample_duration = (name: string): number => {
        if (!this.bridge) return 0
        return this.bridge.getSampleDuration(name) ?? 0
      }

      // ----- MIDI output (opts object carries keyword args from transpiler) -----
      type MidiOpts = { channel?: number; sustain?: number; velocity?: number; vel?: number }
      /** midi shorthand — sends note_on + auto note_off after sustain (default 1 beat).
          The auto note-off goes through midiBridge.scheduleNoteOff so that
          engine.stop() can cancel-and-fire-now to avoid hung notes (#200). */
      const midi = (note: number | string, opts: MidiOpts = {}) => {
        const n = typeof note === 'string' ? noteToMidi(note) : note
        const vel = opts.velocity ?? opts.vel ?? 100
        const sus = opts.sustain ?? 1
        const ch = opts.channel ?? 1
        this.midiBridge.noteOn(n, vel, ch)
        // Tracked timer — engine.stop() cancels-and-fires-now to prevent
        // hung notes on external devices (#200).
        this.midiBridge.scheduleNoteOff(n, ch, sus)
      }
      const midi_note_on = (note: number | string, velocity: number = 100, opts: MidiOpts = {}) => {
        const n = typeof note === 'string' ? noteToMidi(note) : note
        this.midiBridge.noteOn(n, velocity, opts.channel ?? 1)
      }
      const midi_note_off = (note: number | string, opts: MidiOpts = {}) => {
        const n = typeof note === 'string' ? noteToMidi(note) : note
        this.midiBridge.noteOff(n, opts.channel ?? 1)
      }
      const midi_cc = (controller: number, value: number, opts: MidiOpts = {}) =>
        this.midiBridge.cc(controller, value, opts.channel ?? 1)
      const midi_pitch_bend = (val: number, opts: MidiOpts = {}) =>
        this.midiBridge.pitchBend(val, opts.channel ?? 1)
      const midi_channel_pressure = (val: number, opts: MidiOpts = {}) =>
        this.midiBridge.channelPressure(val, opts.channel ?? 1)
      const midi_poly_pressure = (note: number, val: number, opts: MidiOpts = {}) =>
        this.midiBridge.polyPressure(note, val, opts.channel ?? 1)
      const midi_prog_change = (program: number, opts: MidiOpts = {}) =>
        this.midiBridge.programChange(program, opts.channel ?? 1)
      const midi_clock_tick = () => this.midiBridge.clockTick()
      const midi_start = () => this.midiBridge.midiStart()
      const midi_stop = () => this.midiBridge.midiStop()
      const midi_continue = () => this.midiBridge.midiContinue()
      const midi_all_notes_off = (opts: MidiOpts = {}) =>
        this.midiBridge.allNotesOff(opts.channel ?? 1)
      const midi_notes_off = (opts: MidiOpts = {}) =>
        this.midiBridge.allNotesOff(opts.channel ?? 1)
      const midi_devices = () => this.midiBridge.getDevices()
      const get_note_on = (channel: number = 1) => this.midiBridge.getLastNoteOn(channel)
      const get_note_off = (channel: number = 1) => this.midiBridge.getLastNoteOff(channel)

      // Top-level osc_send — fires the host-provided handler (no-op with warning if unset)
      let oscDefaultHost = 'localhost'
      let oscDefaultPort = 4560
      const topLevelOscSend = (host: string, port: number, path: string, ...args: unknown[]) => {
        if (this.oscHandler) {
          this.oscHandler(host, port, path, ...args)
        } else {
          topLevelPuts(`[Warning] osc_send: no handler set — message to ${host}:${port}${path} dropped`)
        }
      }
      /** Set default OSC target host and port for osc() shorthand. */
      const use_osc = (host: string, port: number) => { oscDefaultHost = host; oscDefaultPort = port }
      /** Send OSC message to the default target (set via use_osc). */
      const osc = (path: string, ...args: unknown[]) => topLevelOscSend(oscDefaultHost, oscDefaultPort, path, ...args)

      // Top-level print alias (same as puts)
      const topLevelPrint = topLevelPuts

      // Top-level current_bpm — returns the current default BPM
      const current_bpm = (): number => defaultBpm

      // Pure math helpers (no engine state needed)
      const quantise = (val: number, step: number): number => Math.round(val / step) * step
      const quantize = quantise
      const octs = (n: number, numOctaves: number = 1): number[] =>
        Array.from({ length: numOctaves }, (_, i) => n + i * 12)

      // Top-level ProgramBuilder — provides tick/look/knit/etc. for code outside live_loops.
      // Inside live_loops, the callback parameter `b` shadows this.
      const topLevelBuilder = new ProgramBuilder()

      // Top-level random + iteration helpers. These live on ProgramBuilder for
      // use inside live_loops (`b.rrand(...)`), but some Ruby patterns call
      // them at the top level (e.g. `use_bpm rrand(90, 130)` in
      // choose_generator.rb from in-thread.sonic-pi.net). Bare references in
      // the sandbox proxy fall through to these wrappers.
      const tlRrand = (min: number, max: number) => topLevelBuilder.rrand(min, max)
      const tlRrandI = (min: number, max: number) => topLevelBuilder.rrand_i(min, max)
      // Forward all args via spread so the builder's arity guard fires for
      // 2-arg `rand 50, 80` style misuse — matches Desktop SP. (#229)
      const tlRand = (...args: number[]) => topLevelBuilder.rand(...args)
      const tlRandI = (...args: number[]) => topLevelBuilder.rand_i(...args)
      const tlChoose = <T>(arr: T[]) => topLevelBuilder.choose(arr)
      const tlDice = (n?: number) => topLevelBuilder.dice(n ?? 6)
      const tlOneIn = (n: number) => topLevelBuilder.one_in(n)
      const tlRdist = (max: number, centre?: number) => topLevelBuilder.rdist(max, centre ?? 0)

      // Build DSL parameter names and values for the executor
      // Single source of truth — see src/engine/DslNames.ts. Both this
      // runtime registration AND the contract test at
      // __tests__/DslBuilderContract.test.ts read the same array, so adding
      // a new DSL function in one place is automatically visible to the
      // other (issue #204 — closes the SP37 trap that hid 17 latent gaps).
      // Spread to a mutable array because createIsolatedExecutor's signature
      // takes string[]. The const-assertion stays on DSL_NAMES so the test's
      // type narrowing remains useful.
      const dslNames: string[] = [...DSL_NAMES]
      const dslValues = [
        topLevelBuilder,
        fxAwareWrappedLiveLoop, topLevelWithFx, topLevelUseBpm, topLevelUseSynth, topLevelUseRandomSeed,
        topLevelUseArgBpmScaling, topLevelWithArgBpmScaling,
        topLevelInThread, topLevelAt, topLevelDensity,
        ring, knit, range, line, spread,
        tlRrand, tlRrandI, tlRand, tlRandI, tlChoose, tlDice, tlOneIn, tlRdist,
        chord, scale, chord_invert, note, note_range,
        chord_degree, degree, chord_names, scale_names,
        noteToMidi, midiToFreq, noteToFreq, noteInfo,
        hzToMidi, midiToFreq,
        quantise, quantize, octs,
        current_bpm,
        topLevelPuts, topLevelPrint, topLevelStop, stop_loop,
        // Volume & introspection
        set_volume, current_synth_fn, current_volume_fn,
        // Catalog queries
        synth_names_fn, fx_names_fn, all_sample_names_fn,
        // Sample management
        load_sample_fn, sample_info_fn,
        // Global store
        get, set,
        // Sample catalog
        sample_names, sample_groups, sample_loaded, sample_duration,
        // MIDI input
        get_cc, get_pitch_bend, get_note_on, get_note_off,
        // MIDI output
        midi, midi_note_on, midi_note_off, midi_cc,
        midi_pitch_bend, midi_channel_pressure, midi_poly_pressure,
        midi_prog_change, midi_clock_tick,
        midi_start, midi_stop, midi_continue,
        midi_all_notes_off, midi_notes_off, midi_devices,
        // OSC
        use_osc, osc, topLevelOscSend,
        // Sample BPM
        (name: string) => topLevelBuilder.use_sample_bpm(name),
        // Debug (no-op in browser)
        (_val?: boolean) => { /* no-op — use_debug controls log verbosity in Desktop SP */ },
        // Latency — no-op at top level; inside loops it's handled by ProgramBuilder + AudioInterpreter
        () => { /* use_real_time: no-op at top level — only meaningful inside live_loops (#149) */ },
        // Global tick context (#211 Tier A)
        (name?: string, opts?: { step?: number }) => topLevelBuilder.tick(name ?? '__default', opts),
        (name?: string, offset?: number) => topLevelBuilder.look(name ?? '__default', offset ?? 0),
        (nameOrValue: string | number, value?: number) => topLevelBuilder.tick_set(nameOrValue, value),
        (name?: string) => topLevelBuilder.tick_reset(name ?? '__default'),
        () => topLevelBuilder.tick_reset_all(),
        // Ring helpers (#211 Tier A)
        <T>(arr: T[] | Ring<T>, n: number = 1) => topLevelBuilder.pick(arr, n),
        <T>(arr: T[] | Ring<T>) => topLevelBuilder.shuffle(arr),
        <T>(arr: T[] | Ring<T>, n: number) => topLevelBuilder.stretch(arr, n),
        (...values: number[]) => topLevelBuilder.bools(...values),
        <T>(...values: T[]) => topLevelBuilder.ramp(...values),
        // Pattern helpers (#211 Tier A) — deferred steps via topLevelBuilder
        (notes: (number | string)[], opts?: Record<string, unknown>) => { topLevelBuilder.play_pattern(notes, opts); },
        (notes: number | string | Ring<number> | number[], opts?: Record<string, unknown>) => { topLevelBuilder.play_chord(notes, opts); },
        (notes: (number | string)[], times: number | number[], opts?: Record<string, unknown>) => { topLevelBuilder.play_pattern_timed(notes, times, opts); },
        // Asserts + counter helpers (#211 Tier A) — pure build-time
        assert, assert_equal, assert_similar, assert_not, assert_error,
        inc, dec,
        // define — transpiler emits both the function decl AND a register call
        // (transpileDefine line ~1586). The register persists the fn across
        // re-evals so removing a `define` line from the buffer does not break
        // a still-running live_loop that calls it. (#215)
        (name: string, fn: (...args: unknown[]) => unknown) => {
          if (typeof name === 'string' && typeof fn === 'function') {
            this.definedFns.set(name, fn)
          }
        },
        // ndefine — same call shape as define, but does NOT persist across
        // re-evals (the register call is omitted by the transpiler).
        () => { /* ndefine stub — transpiler handles the real path */ },
        // time_warp — the transpiler turns `time_warp 0.5 do ... end` into
        // `__b.at([0.5], null, ...)`. This runtime stub catches the rare regex
        // fallback path; it forwards to topLevelAt's array-of-times shape. (#211)
        (offset: number, fn: (b: ProgramBuilder) => void) =>
          topLevelAt([offset], null, fn),
        // Tier B — timing introspection (#226). Top-level forms read engine
        // state directly; inside live_loops the transpiler routes through
        // BUILDER_METHODS so __b.current_* gives per-task reads.
        () => 0,                                                    // current_beat: top-level has no beat counter
        () => 60 / defaultBpm,                                       // current_beat_duration
        () => scheduler.audioTime,                                   // current_time: audio-context wall clock at top level
        () => this.schedAheadTime,                                   // current_sched_ahead_time
        // Tier B — PRNG inspection (#227). Top-level mutates topLevelBuilder's
        // RNG; inside live_loops these route to __b.* for per-loop RNG.
        () => topLevelBuilder.current_random_seed(),
        (n?: number) => topLevelBuilder.rand_back(n ?? 1),
        (n?: number) => topLevelBuilder.rand_skip(n ?? 1),
        () => { topLevelBuilder.rand_reset() },
        // Tier B — recording (#228). Forward to topLevelBuilder so the
        // arity guards (rest args + length check) live in one place. The
        // pushed steps fire at scheduled virtual time via recordingHandler
        // wired into the runProgram ctx above. Inside live_loops the
        // transpiler routes through __b directly (BUILDER_METHODS).
        (...args: unknown[]) => { topLevelBuilder.recording_start(...args) },
        (...args: unknown[]) => { topLevelBuilder.recording_stop(...args) },
        (...args: unknown[]) => { topLevelBuilder.recording_save(...args) },
        (...args: unknown[]) => { topLevelBuilder.recording_delete(...args) },
        // Tier B PR #2 — pure ring constructors (#233)
        doubles, halves,
        // Tier B PR #2 — defaults / setting introspection (#233). Forward
        // to topLevelBuilder so the value reflects top-level use_*_defaults
        // calls. Inside live_loops the transpiler routes through __b.
        () => topLevelBuilder.current_synth_defaults(),
        () => topLevelBuilder.current_sample_defaults(),
        () => topLevelBuilder.current_arg_checks(),
        () => topLevelBuilder.current_debug(),
        () => topLevelBuilder.current_timing_guarantees(),
        // Tier B PR #2 — block-form tuplets (#233). Forwards to topLevelBuilder
        // so steps land on the top-level program. Inside live_loops the
        // transpiler emits `__b.tuplets(...)` directly via BUILDER_METHODS.
        (list: unknown, optsOrFn: unknown, maybeFn?: unknown) => {
          topLevelBuilder.tuplets(
            list as readonly unknown[],
            optsOrFn as Parameters<typeof topLevelBuilder.tuplets>[1],
            maybeFn as Parameters<typeof topLevelBuilder.tuplets>[2],
          )
        },
        // Tier B PR #2 — defonce (#212 / #233). Cache lookup; runs body once
        // (or again on `override: true`). The transpiler emits a bare
        // assignment `name = defonce(...)` so the Sandbox proxy captures the
        // cached value into scope-isolated storage. Spread back into
        // persistedFns above so `name` reads still work after the line is
        // removed from the buffer (matches define persistence #215).
        (name: string, opts: { override?: boolean }, fn: (b: ProgramBuilder) => unknown) => {
          if (typeof name !== 'string' || typeof fn !== 'function') return undefined
          if (!opts?.override && this.defonceCache.has(name)) {
            return this.defonceCache.get(name)
          }
          const value = fn(topLevelBuilder)
          this.defonceCache.set(name, value)
          return value
        },
        // Tier B PR #3 — sync_bpm (#236). Inside live_loops the transpiler
        // routes `sync_bpm :name` to `__b.sync_bpm(name)` via BUILDER_METHODS.
        // At top level outside in_thread/live_loop the call has no effect —
        // top-level code runs once linearly and there's no concurrent
        // context to park. Surface that as a printHandler warning so the
        // user gets an actionable signal instead of a silent no-op (#239).
        (name: string) => {
          topLevelBuilder.sync_bpm(name)
          if (this.printHandler) {
            this.printHandler(`[Warning] sync_bpm :${name} at top level has no effect — wrap in in_thread or call from inside a live_loop body.`)
          }
        },
        // Tier B PR #3 — run_code (#236). Host-side dynamic eval. Replaces
        // all running loops with the supplied code, equivalent to pressing
        // Run with a fresh buffer. Returns a Promise that resolves when the
        // new evaluation completes. Refuses calls from inside a live_loop
        // body iteration — re-entering evaluate() from there would dispose
        // the running scheduler mid-iteration. (#240)
        (code: string) => {
          if (typeof code !== 'string') {
            throw new TypeError(`run_code expects a string, got ${typeof code}`)
          }
          if (!this.inTopLevelEval) {
            throw new Error(
              'run_code can only be called at top level — calling it from inside a live_loop body re-enters the engine which is not supported. Use cue/sync to coordinate between loops instead.',
            )
          }
          return this.evaluate(code)
        },
        // Tier B PR #3 — eval_file / run_file (#236). Both stubs throw an
        // informative error redirecting users to the working alternatives.
        // Sonic Pi Web has no filesystem; on desktop these read a .rb file
        // from disk. We surface that limitation explicitly rather than
        // silently no-op'ing, so user-error from copy-pasted desktop code
        // gets a useful message in the editor's runtime-error overlay.
        (_path: string) => {
          throw new Error(
            'browser sandbox: no filesystem access; use run_code(string) or load_example(:name) instead',
          )
        },
        (_path: string) => {
          throw new Error(
            'browser sandbox: no filesystem access; use run_code(string) or load_example(:name) instead',
          )
        },
        // Tier B PR #3 — load_example (#236). Looks up the example by name in
        // the bundled registry; on hit, calls the host's loadExampleHandler so
        // the editor replaces its buffer + re-runs. On miss, throws an
        // informative error listing the available names. If no host handler
        // is registered (engine-only test harness), throws a different error
        // explaining the missing wiring rather than silently no-op'ing.
        (name: string) => {
          if (typeof name !== 'string') {
            throw new TypeError(`load_example expects a name (string or symbol), got ${typeof name}`)
          }
          if (!this.inTopLevelEval) {
            throw new Error(
              'load_example can only be called at top level — calling it from inside a live_loop replaces the running buffer mid-iteration which is not supported.',
            )
          }
          const example = getExample(name)
          if (!example) {
            throw new Error(`load_example: no example named "${name}". See examples panel for the full list.`)
          }
          if (!this.loadExampleHandler) {
            throw new Error('load_example requires a host editor — no loadExampleHandler registered on the engine.')
          }
          this.loadExampleHandler(example)
        },
        // Tier C PR #1 — state wrappers (#251). Imperative forms forward to
        // topLevelBuilder so top-level toggles persist into per-task __b state
        // when live_loops are scheduled. Block forms wrap a build callback the
        // sandbox-emitted IIFE supplies, mirroring with_synth_defaults.
        (enabled: boolean) => { topLevelBuilder.use_arg_checks(enabled) },
        (enabled: boolean) => { topLevelBuilder.use_timing_guarantees(enabled) },
        (opts: Record<string, number>) => { topLevelBuilder.use_merged_synth_defaults(opts) },
        (opts: Record<string, number>) => { topLevelBuilder.use_merged_sample_defaults(opts) },
        (enabled: boolean, fn: (b: ProgramBuilder) => void) => { topLevelBuilder.with_arg_checks(enabled, fn) },
        (enabled: boolean, fn: (b: ProgramBuilder) => void) => { topLevelBuilder.with_debug(enabled, fn) },
        (enabled: boolean, fn: (b: ProgramBuilder) => void) => { topLevelBuilder.with_timing_guarantees(enabled, fn) },
        (opts: Record<string, number>, fn: (b: ProgramBuilder) => void) => { topLevelBuilder.with_merged_synth_defaults(opts, fn) },
        (opts: Record<string, number>, fn: (b: ProgramBuilder) => void) => { topLevelBuilder.with_merged_sample_defaults(opts, fn) },
        // Tier C PR #2 — sample/buffer registry (#253). Top-level host stubs.
        // sample_paths returns the bundled+custom names (browser equivalent of
        // Desktop SP's filesystem paths). Optional `filter` substring match
        // matches the upstream sound.rb behavior loosely. Without `filter`,
        // returns every name we know about.
        (filter?: string) => {
          const all = sample_names()
          const loaded = this.bridge?.getLoadedSampleNames() ?? []
          // Union: bundled catalog + any extras already loaded (e.g. user uploads
          // not in the static catalog). Dedupe via Set, preserve catalog order.
          const merged = [...all]
          for (const name of loaded) if (!merged.includes(name)) merged.push(name)
          if (typeof filter === 'string' && filter.length > 0) {
            return merged.filter(n => n.includes(filter))
          }
          return merged
        },
        // sample_buffer(name) — returns a buffer-info dictionary. Unlike Desktop
        // SP's Buffer object, recording into the buffer is out of scope for
        // this PR; we expose name + duration so user code that asks for
        // sample_buffer(:foo).duration works.
        (name: string) => {
          if (typeof name !== 'string') {
            throw new TypeError(`sample_buffer expects a name (string or symbol), got ${typeof name}`)
          }
          const dur = this.bridge?.getSampleDuration(name)
          return { name, duration: dur ?? 0 }
        },
        // sample_free(name) — drop a single sample from the loaded cache.
        // Returns true if it was loaded, false otherwise. The bufNum slot is
        // not recycled (would require reference counting); the cost is one
        // integer of waste per freed sample.
        (name: string) => {
          if (typeof name !== 'string') return false
          return this.bridge?.freeSample(name) ?? false
        },
        // sample_free_all — drop every sample from the loaded cache. Returns
        // the count freed. Useful before benchmarks or for memory pressure.
        () => {
          return this.bridge?.freeAllSamples() ?? 0
        },
        // load_samples(*names) — preload a list of samples so the first
        // sample :name call is instant (no first-load CDN fetch latency).
        // Accepts varargs so `load_samples :bd_haus, :sn_dub` works; the
        // transpiler unpacks symbols into individual string args.
        (...names: unknown[]) => {
          if (!this.bridge) return
          const flat = names.flat() as unknown[]
          for (const n of flat) {
            if (typeof n === 'string') {
              // Fire and don't await — preload is best-effort. The first
              // actual sample :n call still awaits via the same dedup path.
              void this.bridge.preloadSample(n).catch(() => { /* silent */ })
            }
          }
        },
        // buffer(name, duration?) — browser stub. Desktop SP allocates a
        // recording buffer; we don't have user-buffer recording yet, so the
        // call returns a buffer-info shape that mirrors sample_buffer. This
        // unblocks code that calls .duration on the result without erroring.
        (name: string, duration?: number) => {
          if (typeof name !== 'string') {
            throw new TypeError(`buffer expects a name (string or symbol), got ${typeof name}`)
          }
          // If we already have a sample with this name cached, surface its
          // duration. Otherwise return the requested duration (defaulting
          // to 8 — the desktop default for a fresh recording buffer).
          const known = this.bridge?.getSampleDuration(name)
          return { name, duration: known ?? duration ?? 8 }
        },
        // Tier C PR #3 — set_mixer_control! / reset_mixer! (#255). Deferred
        // ProgramBuilder steps. Top-level forms forward to topLevelBuilder so
        // a bare `set_mixer_control! lpf: 30; sleep 4; reset_mixer!` sequences
        // against playback (mirrors set_volume / recording lifecycle).
        (opts: Record<string, number>) => { topLevelBuilder.set_mixer_control(opts) },
        (...args: unknown[]) => { topLevelBuilder.reset_mixer(...args) },
        // Tier C PR #3 — scsynth_info / status (#255). Pure host-queries from
        // the bridge. Both return a flat info dict; in tests with no bridge
        // they return safe placeholder shapes so user code that reads .field
        // doesn't crash.
        () => this.bridge?.getScsynthInfo() ?? {
          sample_rate: 44100, sample_dur: 1 / 44100,
          radians_per_sample: (2 * Math.PI) / 44100,
          control_rate: 44100 / 64, control_dur: 64 / 44100,
          subsample_offset: 0,
          num_output_busses: 16, num_input_busses: 16,
          num_audio_busses: 1024, num_control_busses: 4096,
          num_buffers: 4096,
        },
        () => this.bridge?.getStatus() ?? {
          ugens: 0, synths: 0, groups: 0, sdefs: 0,
          avg_cpu: 0, peak_cpu: 0,
          nom_samp_rate: 44100, act_samp_rate: 44100,
          audio_busses: 1024, control_busses: 4096,
        },
        // Tier C PR #3 — vt / bt / rt (#255). Pure BPM math + virtual-time
        // alias. At top level use_bpm only updates `defaultBpm` (it does not
        // call topLevelBuilder.use_bpm), and `current_time` reads
        // scheduler.audioTime (line 1051) — so we mirror those sources here.
        // Inside live_loops the transpiler routes through __b via
        // BUILDER_METHODS, where per-task _currentBpm and _audioTime are correct.
        () => scheduler.audioTime,                                   // vt: thread's local virtual run time
        (t: number) => t * 60 / defaultBpm,                          // bt: beats → seconds at current bpm
        (t: number) => t * defaultBpm / 60,                          // rt: seconds → beats (bypasses bpm scaling)
      ]

      const codeWarnings = validateCode(transpiledCode)
      for (const warning of codeWarnings) {
        if (this.printHandler) this.printHandler(`[Warning] ${warning}`)
        else console.warn('[SonicPi]', warning)
      }

      // Seed prior `define`-bound functions and `defonce`-cached values so
      // they remain callable / readable even if the user removes the line
      // from the buffer. defonceCache is spread first so a same-named define
      // wins (defines are functions; conflicts are user error either way).
      // (#215 + #233)
      const persistedFns: Record<string, unknown> = {
        ...Object.fromEntries(this.defonceCache),
        ...Object.fromEntries(this.definedFns),
      }
      const sandbox = createIsolatedExecutor(transpiledCode, dslNames, persistedFns)
      scopeHandle = sandbox.scopeHandle
      // Set the re-entry guard while the synchronous top-level body runs.
      // run_code / load_example check this flag and refuse if false (i.e.
      // called later from inside a live_loop body iteration). Save+restore
      // pattern handles legitimate nested run_code at top level. (#240/#241)
      const prevInTopLevelEval = this.inTopLevelEval
      this.inTopLevelEval = true
      try {
        // On hot-swap, clear FX-scope mappings BEFORE the DSL re-execution
        // repopulates them via wrappedLiveLoop (line ~822-824). Clearing AFTER
        // execute() would wipe the new mappings, leaving every loop wrapped
        // in a top-level `with_fx` block silently un-routed (task.outBus stays
        // default, audio bypasses the FX chain entirely). Symptom: kicks
        // (no FX) play normally, FX-wrapped loops lose all FX-processed
        // mid-content on Update.
        if (isReEvaluate) {
          this.loopFxScope.clear()
          this.fxScopeChains.clear()
        }
        await sandbox.execute(...dslValues)
      } finally {
        this.inTopLevelEval = prevInTopLevelEval
      }

      if (isReEvaluate) {
        const oldLoops = scheduler.getRunningLoopNames()
        const removedLoops = oldLoops.filter(name => !pendingLoops.has(name))
        const hasNewLoops = [...pendingLoops.keys()].some(name => !oldLoops.includes(name))

        // Per-loop state cleanup for removed loops. Without this, if a loop is
        // removed (e.g. user clears the buffer and Updates) and then re-added
        // later, the stale state survives:
        //   - loopSynced.has(name) → true → restored loop SKIPS waiting for
        //     its `sync:` target → starts at registerLoop's getAudioTime()
        //     instead of the next met1 cue → music drifts out of phase.
        //   - loopTicks/loopBeats/loopSeeds → tick state resumes from where
        //     it left off pre-removal → wrong notes from .tick/.shuffle/etc.
        //   - loopBuilders → stale closure could be re-invoked from edge paths.
        for (const name of removedLoops) {
          this.loopBuilders.delete(name)
          this.loopSeeds.delete(name)
          this.loopTicks.delete(name)
          this.loopBeats.delete(name)
          this.loopSynced.delete(name)
        }

        // Pause ticking so no old events fire during transition
        scheduler.pauseTick()

        // SP86 (#296): loop-based reconciliation — preserve in-flight audio
        // whose shape didn't change. The previous nuclear path (freeAllNodes
        // + persistentFx.clear + recreate) killed every synth in mid-envelope
        // and tore down every FX node even when its content-addressed scopeId
        // was identical in the new program. That's the source of the audible
        // "click on Run" and the FX-tail accumulation during rapid hot-swap.
        //
        // Strategy now:
        //   1. Synth group 100: untouched. Notes in mid-envelope finish their
        //      decay naturally (matches Desktop SP behavior).
        //   2. FX group 101: set-difference between persistentFx.keys() (old)
        //      and fxScopeChains.keys() (new). Free only orphaned scopes.
        //      Matching scopes keep their FX node + bus alive — reverb tail
        //      and echo state persist across Run.
        //   3. Monitors group 102: free only monitors for removed loops.
        //      Surviving loops keep their per-track AnalyserNode routing.
        //   4. reusableFx (per-iteration inner with_fx): always orphaned —
        //      those FX are tied to a specific iteration's killTimer
        //      lifecycle. SP82 + SP85 hygiene (cancel timer, free group, free
        //      bus) still applies here.
        if (this.bridge) {
          // (0) Purge future-scheduled bundles from the WASM scheduler queue
          //     WITHOUT touching already-rendering synths. Each iteration
          //     batches /s_news with future timetags spanning the schedAhead
          //     window (SV9). Bundles for the OLD body's NEXT iterations are
          //     in this queue; if we don't cancel them they fire on top of
          //     the new body's audio, audibly stacking samples on rapid
          //     changed-code re-runs (verified via tools/test-rerun-rapid-
          //     changed.ts — pre-purge snare onsets 18→200 across 10 cycles).
          //     Already-rendering synth nodes in group 100 are NOT in this
          //     queue — they live in scsynth's running-node graph and decay
          //     per their envelopes. This separation is the desktop-SP
          //     analog: their Kernel.sleep blocks so no future bundles exist
          //     to begin with; our schedAhead queue needs explicit drain.
          this.bridge.purgePendingBundles()
          // (1) Persistent FX scopes: free only those whose scopeId does NOT
          //     appear in the new program. fxScopeChains was rebuilt during
          //     sandbox.execute above; persistentFx still holds the prior
          //     run's allocations. The intersection is what we preserve.
          const survivingScopes = new Set(this.fxScopeChains.keys())
          for (const [scopeId, state] of this.persistentFx) {
            if (survivingScopes.has(scopeId)) continue  // keep alive
            for (const group of state.groups) this.bridge.freeGroup(group)
            for (const bus of state.buses) this.bridge.freeBus(bus)
            this.persistentFx.delete(scopeId)
          }
          // (2) Per-iteration inner FX: always disposed across hot-swap. The
          //     new code's iterations will allocate their own reusableFx
          //     entries on first execution. Hygiene order matters (SV36 +
          //     SV38): cancel killTimer before freeing, then /n_free the
          //     group (live — /g_freeAll isn't called anymore), then return
          //     the bus index to the pool.
          for (const state of this.reusableFx.values()) {
            if (state.killTimer) clearTimeout(state.killTimer)
            this.bridge.freeGroup(state.groupId)
            this.bridge.freeBus(state.bus)
          }
          this.reusableFx.clear()
          // (3) Loop monitors: free only those whose loop disappeared. Kept
          //     loops re-use their existing monitor (createLoopMonitor is
          //     idempotent by name).
          for (const name of removedLoops) {
            this.bridge.freeLoopMonitor(name)
          }
          // (4) nodeRefMap: drop all entries. NodeRefs are build-time symbols
          //     and the new program built fresh ones; old refs are
          //     unreachable from user code. Surviving persistent-FX scopes
          //     re-register through AudioInterpreter on their first new-code
          //     iteration that re-enters their with_fx Step (existing nodeId
          //     reused via persistentFx.has(scopeId) short-circuit).
          this.nodeRefMap.clear()
        }

        // Pre-create persistent FX synchronously before reEvaluate. See
        // preCreatePersistentFx() for the full rationale (issue #290).
        await this.preCreatePersistentFx(defaultBpm)

        // Commit: hot-swap same-named, stop removed, start new
        scheduler.reEvaluate(pendingLoops, { bpm: defaultBpm, synth: defaultSynth })

        // Apply per-loop defaults (synths write to their loop's private bus
        // so the monitor can fan out to master + per-track analyser)
        for (const [name, defaults] of pendingDefaults) {
          const task = scheduler.getTask(name)
          if (task) {
            task.bpm = defaults.bpm
            task.currentSynth = defaults.synth
            task.outBus = this.bridge?.getLoopBus(name) ?? 0
          }
        }

        // Resume ticking — new loops start clean
        scheduler.resumeTick()
      }

      // First-eval path: hot-swap block above didn't run, so pre-create FX
      // now. Without this, the very first Run hits the same FX-vs-sample
      // sub-frame race that PR #292 fixed for hot-swap (issue #290) — the
      // first 1-2 iterations of FX-wrapped loops can play dry while scsynth
      // is still processing the lazy /s_new for the FX nodes. The helper is
      // idempotent via `persistentFx.has(scopeId)`, so a no-op if the
      // hot-swap branch above already populated it.
      if (!isReEvaluate) {
        await this.preCreatePersistentFx(defaultBpm)
      }

      return {}
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      return { error }
    }
  }

  /**
   * Synchronously pre-create persistent FX nodes for every top-level scope
   * before any loop iteration fires audio through them. Called from BOTH the
   * first-eval path AND the hot-swap path (after freeAllNodes + map clear).
   *
   * Why this exists: the lazy creation at line 612 runs INSIDE the loop's
   * first iteration, AT virtualTime + schedAheadTime. The same iteration
   * then queues sample /s_new with the same timetag. scsynth receives both
   * bundles and processes them in the order they arrive at its scheduler — a
   * sub-frame race. When the race loses, sample /s_new fires onto a bus whose
   * FX node hasn't been created yet → silent / dry clap (user-reported
   * "music plays wrongly" residual on Update; the same race exists on first
   * Run but is masked because the user just clicked Play).
   *
   * Why this fixes it: FX nodes are CREATED HERE with audioTime=0 (immediate).
   * scsynth processes them now, BEFORE any future-timed sample bundle can
   * land. By the time loops start iterating, persistentFx is populated, the
   * lazy-creation block at line 612 is skipped via .has(), and task.outBus
   * is set to the live FX bus before any sample plays.
   *
   * Why only FX (not samples): FX are bus receivers — they must exist before
   * audio flows through them. Samples are continuous per-iteration events
   * scheduled via virtual time; pre-creating them would block real-time
   * scheduling. FX setup is one-time per scope.
   *
   * Idempotent: scopes already in `persistentFx` are skipped.
   */
  private async preCreatePersistentFx(bpm: number): Promise<void> {
    if (!this.bridge) return
    for (const [scopeId, fxChain] of this.fxScopeChains) {
      if (!fxChain || fxChain.length === 0) continue
      if (this.persistentFx.has(scopeId)) continue
      let currentOutBus = 0  // FX-wrapped loops route to master through chain
      const buses: number[] = []
      const groups: number[] = []
      for (const fx of fxChain) {
        const bus = this.bridge.allocateBus()
        const groupId = this.bridge.createFxGroup()
        const fxWarn = this.printHandler
          ? (m: string) => this.printHandler!(`[Warning] with_fx :${fx.name} — ${m}`)
          : undefined
        const fxOpts = normalizeFxParams(fx.name, fx.opts, bpm, fxWarn)
        // audioTime=0 → scsynth processes immediately (before any
        // future-timed sample bundles can race past). Awaiting the
        // promise ensures synthdef load completes before the next FX.
        await this.bridge.applyFx(fx.name, 0, fxOpts, bus, currentOutBus)
        this.bridge.flushMessages(0)
        buses.push(bus)
        groups.push(groupId)
        currentOutBus = bus
      }
      this.persistentFx.set(scopeId, { buses, groups, outBus: currentOutBus })
    }
  }

  /** Start the scheduler. Call after the first `evaluate()`. */
  play(): void {
    if (!this.scheduler) return
    if (this.playing) return

    this.playing = true
    this.scheduler.start()
  }

  /** Stop all loops and free audio resources. The next `evaluate()` starts fresh. */
  stop(): void {
    if (!this.playing) return

    this.playing = false
    this.scheduler?.stop()

    // Cancel pending MIDI auto note-offs and fire them NOW so external
    // devices don't hang. Without this, a `midi 60, sustain: 4` followed by
    // Stop leaves the device sounding the note until the timer eventually
    // fires (#200). After stop, the timer is also gone so a fresh run won't
    // collide with stale note-offs.
    this.midiBridge.cancelPendingNoteOffs()

    // Cancel any in-flight recording so the MediaRecorder releases its
    // capture stream and the browser's recording indicator clears (#228).
    // The user's lastRecording (if any) is preserved — they may still call
    // recording_save in a fresh evaluate().
    if (this.recorder) {
      this.recorder.cancel()
      this.recorder = null
    }

    // Free all scsynth nodes for clean silence
    if (this.bridge) {
      this.bridge.freeAllNodes()
      // Release mic / line-in tracks so the browser's recording indicator
      // clears and nothing keeps feeding scsynth's input channel (#152).
      this.bridge.stopAllLiveAudio()
    }
    this.nodeRefMap.clear()

    // Dispose scheduler so next evaluate() starts fresh
    this.scheduler?.dispose()
    this.scheduler = null
    this.loopBuilders.clear()
    this.loopSeeds.clear()
    this.loopTicks.clear()
    this.loopBeats.clear()
    this.loopSynced.clear()
    this.globalStore.clear()
    this.definedFns.clear()
    this.defonceCache.clear()
    // SP85 (#294): return persistentFx bus indices to the bridge pool BEFORE
    // dropping the map. freeAllNodes() above killed the scsynth-side nodes via
    // /g_freeAll, but the JS bus indices were leaked — nextBusNum then climbed
    // past SuperSonic's numAudioBusChannels=128 default after 5-6 Run/Stop
    // cycles, silencing all FX-routed audio (arp + cymbal tracks dropped to
    // ~13% of baseline, kick + synthbass invariant because they routed through
    // master bus 0). /n_free for groups is redundant — /g_freeAll already
    // killed them — and risks SP82-class double-allocation.
    for (const state of this.persistentFx.values()) {
      for (const bus of state.buses) this.bridge?.freeBus(bus)
    }
    this.persistentFx.clear()
    // Same as hot-swap path: cancel pending FX-kill setTimeouts BEFORE dropping
    // the map. Without this, a Stop followed by a quick re-Run would have stale
    // timers fire ~1s later on freshly-allocated FX (issue #290).
    // SP85 (#294): the timer body would have called freeBus(state.bus); do it
    // synchronously here so the bus index returns to the pool instead of
    // leaking (same root cause as the persistentFx loop above).
    for (const state of this.reusableFx.values()) {
      if (state.killTimer) clearTimeout(state.killTimer)
      this.bridge?.freeBus(state.bus)
    }
    this.reusableFx.clear()
    this.loopFxScope.clear()
    this.fxScopeChains.clear()
    // Nested live_loop bookkeeping (issue #198). Defensive reset of depth
    // counter — should be 0 already, but stop() may be called mid-build
    // on error paths.
    this.buildNestingDepth = 0
    this.nestedWarned.clear()
  }

  dispose(): void {
    if (this.playing) this.stop()
    // Recording cleanup (#232). stop() handled the recorder when playing,
    // but a dispose without a prior play still needs to release the
    // MediaRecorder + capture stream. Also clear lastRecording — unlike
    // stop() which preserves it for save-across-re-evaluate, dispose ends
    // the engine's life so any retained Blob (potentially MB-sized) is
    // pure leak.
    if (this.recorder) {
      this.recorder.cancel()
      this.recorder = null
    }
    this.lastRecording = null
    this.pendingRecordingStop = null
    this.scheduler?.dispose()
    this.scheduler = null
    this.eventStream.dispose()
    this.bridge?.dispose()
    this.bridge = null
    this.initialized = false
    this.currentStratum = Stratum.S3  // Reset to S3 so capture is unavailable
    this.loopBuilders.clear()
    this.loopSeeds.clear()
    this.globalStore.clear()
    this.definedFns.clear()
    this.defonceCache.clear()
  }

  /** Register a handler for runtime errors inside `live_loop` bodies. */
  setRuntimeErrorHandler(handler: (err: Error) => void): void {
    this.runtimeErrorHandler = handler
  }

  /** Register a handler for `puts` / `print` output from user code. */
  setPrintHandler(handler: (msg: string) => void): void {
    // Wrap with clamp-warning dedup (issue #202, G4). SoundLayer's
    // validateAndClamp emits one message per out-of-range param per call,
    // and `play`/`sample`/`with_fx` flow through it on every loop iteration.
    // Without dedup the user gets the same `[Warning] play :gverb — room: 233
    // clamped to 1 (max)` message every beat. Dedup keys on the full message
    // string so distinct clamp triggers (different param, different value,
    // different synth) each surface once.
    const wrapped = (msg: string) => {
      if (CLAMP_WARN_RE.test(msg)) {
        if (this.warnDedup.has(msg)) return
        this.warnDedup.add(msg)
      }
      handler(msg)
    }
    this.printHandler = wrapped
    // Forward to the bridge so SoundLayer clamp warnings for samples surface
    // through the same UI channel as play/FX warnings (SV19 — accept with signal).
    if (this.bridge) this.bridge.warnHandler = wrapped
  }

  /** Register a handler for cue events (for the CueLog panel). */
  setCueHandler(handler: (name: string, time: number) => void): void {
    this.cueHandler = handler
  }

  /**
   * Register a handler for `load_example(:name)` calls in user code (#236).
   * The host (App.ts) wires this to its loadExample(example) method which
   * replaces the editor buffer with the example's Ruby code and runs it.
   * If unset, load_example throws an informative error so the engine works
   * standalone without requiring an editor harness.
   */
  setLoadExampleHandler(handler: (example: Example) => void): void {
    this.loadExampleHandler = handler
  }

  /**
   * Register a handler for `osc_send` calls in user code.
   * The engine fires this handler; the host wires it to actual transport
   * (e.g. WebSocket → UDP bridge). If no handler is set, osc_send logs a warning.
   */
  setOscHandler(handler: (host: string, port: number, path: string, ...args: unknown[]) => void): void {
    this.oscHandler = handler
  }

  /**
   * Set master volume. Range: 0 (silent) to 1 (full).
   * Safe to call before `init()` — applied when the audio bridge is ready.
   */
  setVolume(volume: number): void {
    this.pendingVolume = volume
    this.bridge?.setMasterVolume(volume)
  }

  /** Set mixer amp (0.5–6 typical). Live — propagates to scsynth /n_set
   *  immediately if the bridge is up; otherwise queued for next mixer init. */
  setMixerAmp(amp: number): void {
    this.bridge?.setMixerAmp(amp)
  }

  /** Set mixer pre_amp baseline. Effective wire pre_amp = volume × pre_amp. */
  setMixerPreAmp(preAmp: number): void {
    this.bridge?.setMixerPreAmp(preAmp)
  }

  /** Get a friendly version of the last error (for display in a log pane). */
  static formatError(err: Error): FriendlyError {
    return friendlyError(err)
  }

  /** Format a friendly error as a display string. */
  static formatErrorString(err: Error): string {
    return formatFriendlyError(friendlyError(err))
  }

  /** Get SuperSonic scsynth metrics for diagnostics. */
  getMetrics(): Record<string, unknown> | null {
    return this.bridge?.getMetrics() ?? null
  }

  /**
   * Register a custom user-uploaded sample with the audio engine.
   * The sample becomes playable as `sample :user_<name>` in code.
   * Requires engine to be initialized with audio support.
   */
  async registerCustomSample(name: string, audioData: ArrayBuffer): Promise<void> {
    if (!this.bridge) throw new Error('Audio engine not available — cannot register custom sample')
    await this.bridge.registerCustomSample(name, audioData)
  }

  /**
   * Load all custom samples from IndexedDB into the audio engine.
   * Called automatically during init when audio is available.
   * Safe to call again after uploading new samples.
   */
  async loadCustomSamplesFromDB(): Promise<number> {
    if (!this.bridge) return 0
    try {
      const records = await loadAllCustomSamples()
      for (const record of records) {
        if (!this.bridge.isSampleLoaded(record.name)) {
          await this.bridge.registerCustomSample(record.name, record.audioData)
        }
      }
      return records.length
    } catch {
      // IndexedDB unavailable (e.g. tests, incognito) — non-fatal
      return 0
    }
  }

  get components(): Partial<EngineComponents> {
    const result: Partial<EngineComponents> = {
      streaming: { eventStream: this.eventStream },
    }

    // Audio (from SuperSonic) — master + per-track analysers
    const audioCtx = this.bridge?.audioContext
    const analyser = this.bridge?.analyser
    if (audioCtx && analyser) {
      const trackAnalysers = this.bridge?.getAllTrackAnalysers()
      const analyserL = this.bridge?.analyserLeft ?? undefined
      const analyserR = this.bridge?.analyserRight ?? undefined
      result.audio = { analyser, analyserL, analyserR, audioCtx, trackAnalysers }
    }

    // Capture query (only for deterministic S1/S2 code)
    if (this.currentStratum <= Stratum.S2) {
      const loopBuilders = this.loopBuilders
      const scheduler = this.scheduler

      result.capture = {
        async queryRange(begin: number, end: number): Promise<QueryEvent[]> {
          const events: QueryEvent[] = []
          for (const [name, builderFn] of loopBuilders) {
            const task = scheduler?.getTask(name)
            const bpm = task?.bpm ?? 60
            const factory = (ticks?: Map<string, number>, iteration?: number) => {
              const builder = new ProgramBuilder(iteration ?? 0, ticks)
              // Apply the loop's synth default so QueryInterpreter shows the correct synth
              if (task?.currentSynth && task.currentSynth !== 'beep') {
                builder.use_synth(task.currentSynth)
              }
              builderFn(builder)
              return { program: builder.build(), ticks: builder.getTicks() }
            }
            events.push(...queryLoopProgram(factory, begin, end, bpm))
          }
          return events.sort((a, b) => a.time - b.time)
        },
      }
    }

    return result
  }
}
