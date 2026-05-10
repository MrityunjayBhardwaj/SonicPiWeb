/**
 * Wrapper around SuperSonic (scsynth WASM).
 *
 * SuperSonic is loaded via CDN (GPL core), never bundled.
 * This bridge handles init, synth triggering, sample playback,
 * FX, AnalyserNode tap, and cleanup.
 */

import { audioTimeToNTP, encodeSingleBundle as fallbackEncodeSingleBundle, encodeBundle as fallbackEncodeBundle } from './osc'
import { normalizeSampleParams, selectSamplePlayer, translateSampleOpts } from './SoundLayer'
import { buildTrackMonitorSynthDef } from './buildTrackMonitorSynthDef'

// SuperSonic types — declared here since we load it at runtime via CDN
interface SuperSonic {
  init(): Promise<void>
  send(address: string, ...args: (string | number | Uint8Array)[]): void
  sendOSC(data: Uint8Array, options?: Record<string, unknown>): void
  loadSynthDef(name: string): Promise<void>
  loadSynthDefs(names: string[]): Promise<void>
  loadSample(bufNum: number, path: string): Promise<void>
  sync(): Promise<void>
  nextNodeId(): number
  suspend(): void
  resume(): void
  recover(): void
  destroy(): void
  /** Cancel pending JS-side OSC bundles + clear scsynth WASM scheduler queue.
   *  SuperSonic blocks `/clearSched` directly; this is the documented API. */
  purge(): Promise<void>
  node: AudioWorkletNode
  audioContext: AudioContext
}

interface SuperSonicOSC {
  encodeSingleBundle(timetag: number, address: string, args: (string | number)[]): Uint8Array
  encodeBundle(timetag: number, messages: unknown[]): Uint8Array
  encodeMessage(address: string, args: (string | number)[]): Uint8Array
}

interface SuperSonicConstructor {
  new (options: {
    baseURL: string
    coreBaseURL?: string
    synthdefBaseURL: string
    sampleBaseURL?: string
  }): SuperSonic
  osc?: SuperSonicOSC
}

export interface SuperSonicBridgeOptions {
  /** Pass the SuperSonic constructor (from ES module import) */
  SuperSonicClass?: SuperSonicConstructor
  baseURL?: string
  coreBaseURL?: string
  synthdefBaseURL?: string
  sampleBaseURL?: string
}

/**
 * Format an OSC message as a human-readable trace string.
 * Matches desktop Sonic Pi's trace style:
 *   /s_new "sonic-pi-basic_stereo_player" 1003 0 100 {buf: 0, amp: 1.5, lpf: 130}
 */
function formatOscTrace(address: string, args: (string | number)[], audioTime: number): string {
  if (address === '/s_new' && args.length >= 4) {
    const synthName = args[0]
    const nodeId = args[1]
    const addAction = args[2]
    const targetGroup = args[3]
    // Remaining args are key-value pairs
    const params: Record<string, string | number> = {}
    for (let i = 4; i < args.length; i += 2) {
      const key = args[i]
      const val = args[i + 1]
      if (key !== undefined && val !== undefined) {
        params[String(key)] = val
      }
    }
    const paramsStr = Object.entries(params)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(', ')
    return `[t:${audioTime.toFixed(4)}] ${address} "${synthName}" ${nodeId} ${addAction} ${targetGroup} {${paramsStr}}`
  }
  if (address === '/n_set' && args.length >= 1) {
    const nodeId = args[0]
    const params: Record<string, string | number> = {}
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]
      const val = args[i + 1]
      if (key !== undefined && val !== undefined) {
        params[String(key)] = val
      }
    }
    const paramsStr = Object.entries(params)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(', ')
    return `[t:${audioTime.toFixed(4)}] ${address} ${nodeId} {${paramsStr}}`
  }
  return `[t:${audioTime.toFixed(4)}] ${address} ${args.join(' ')}`
}

const COMMON_SYNTHDEFS = [
  'sonic-pi-beep',
  'sonic-pi-saw',
  'sonic-pi-prophet',
  'sonic-pi-tb303',
  'sonic-pi-supersaw',
  'sonic-pi-pluck',
  'sonic-pi-pretty_bell',
  'sonic-pi-piano',
  'sonic-pi-basic_stereo_player',
  // Note: sonic-pi-stereo_player is NOT in the CDN (404). Loaded lazily on demand.
]



/** Max stereo track outputs (beyond master). Channels 0-1 = master, 2-3 = track 0, etc. */
const NUM_OUTPUT_CHANNELS = 2 + AUDIO_IO.MAX_TRACK_OUTPUTS * 2 // 14 channels total

// Gain staging, I/O, and safety parameters are centralized in config.ts.
// See config.ts SECTION 1 (MIXER) for the full A/B calibration history.
import { MIXER, AUDIO_IO } from './config'

export class SuperSonicBridge {
  private sonic: SuperSonic | null = null
  private loadedSynthDefs = new Set<string>()
  private pendingSynthDefLoads = new Map<string, Promise<void>>()
  private loadedSamples = new Map<string, number>()
  private pendingSampleLoads = new Map<string, Promise<number>>()
  /** Sample duration cache — populated asynchronously on first load via Web Audio decode. */
  private sampleDurations = new Map<string, number>()
  // Pinned to @0.57.0 to match the runtime SuperSonic version (SV22:
  // CDN packages must pin together). The init() override at line 213
  // sets this from options or to the same pinned URL — this default
  // only matters before init() runs.
  private resolvedSampleBaseURL = 'https://unpkg.com/supersonic-scsynth-samples@0.57.0/samples/'
  private nextBufNum = 0
  private analyserNode: AnalyserNode | null = null
  private analyserL: AnalyserNode | null = null
  private analyserR: AnalyserNode | null = null
  private options: SuperSonicBridgeOptions
  /** Optional warning sink — set by SonicPiEngine so SoundLayer clamp
   *  messages for samples reach the UI log (SV19 — accept with signal). */
  warnHandler: ((msg: string) => void) | null = null
  /** rand_buf — buffer of random values for slicer/wobble/panslicer FX.
   *  Desktop SP loads rand-stream.wav (studio.rb:87). We generate in-memory. */
  private randBufId: number = -1
  /** Audio bus allocator — buses 0-15 are hardware, 16+ are private */
  private nextBusNum = NUM_OUTPUT_CHANNELS
  private freeBuses: number[] = []
  /** Live audio (mic/line-in) streams keyed by name */
  private liveAudioStreams = new Map<string, { stream: MediaStream, source: MediaStreamAudioSourceNode }>()
  /** Names whose startLiveAudio getUserMedia is currently in-flight — race lock (#152) */
  private pendingLiveAudio = new Set<string>()
  /** Per-track AnalyserNodes keyed by track name */
  private trackAnalysers = new Map<string, AnalyserNode>()
  /** Track name → scsynth bus pair (stereo, starting at bus 2) */
  private trackBuses = new Map<string, number>()
  /** Next available track bus pair */
  private nextTrackBus = 2
  private splitter: ChannelSplitterNode | null = null
  private masterMerger: ChannelMergerNode | null = null
  private masterGainNode: GainNode | null = null
  /** Per-loop monitor state: loopBus (internal routing) + monitorNodeId (scsynth node) */
  private loopMonitors = new Map<string, { loopBus: number; monitorNodeId: number }>()
  /** Whether the track-monitor SynthDef has been loaded via /d_recv */
  private monitorSynthDefLoaded = false
  /** scsynth mixer node ID — for controlling master volume via /n_set */
  private mixerNodeId = 0
  /** Runtime mixer params — initialised from MIXER (config.ts) and mutable
   *  via setMixerAmp / setMixerPreAmp so the Prefs panel can drive them
   *  live without an engine restart. setMasterVolume reads currentMixerPreAmp
   *  as the per-volume baseline (so volume × pre_amp keeps composing). */
  private currentMixerAmp: number = MIXER.AMP
  private currentMixerPreAmp: number = MIXER.PRE_AMP
  /** Last clamped 0..1 volume so pre_amp recomputes correctly when the user
   *  drags pre_amp without touching volume. */
  private currentMasterVolume = 1.0
  /** Optional callback for OSC trace logging — receives formatted trace strings like desktop Sonic Pi. */
  private oscTraceHandler: ((msg: string) => void) | null = null
  /** SuperSonic.osc encoder (preferred) or fallback */
  private oscEncoder: {
    encodeSingleBundle(timetag: number, address: string, args: (string | number)[]): Uint8Array
  } | null = null
  /** SuperSonic constructor ref — needed for static osc access */
  private SuperSonicClass: SuperSonicConstructor | null = null
  /**
   * Delayed message queue — matches Sonic Pi's __delayed_messages.
   * Messages are queued during computation and flushed as a single
   * OSC bundle on sleep, so all events between sleeps share one NTP timetag.
   */
  private messageQueue: Array<{ address: string; args: (string | number)[] }> = []
  private messageQueueAudioTime: number = 0

  constructor(options: SuperSonicBridgeOptions = {}) {
    this.options = options
  }

  async init(): Promise<void> {
    // Try constructor passed via options, then global scope
    const SuperSonicClass = this.options.SuperSonicClass
      ?? (globalThis as Record<string, unknown>).SuperSonic as SuperSonicConstructor | undefined
    if (!SuperSonicClass) {
      throw new Error(
        'SuperSonic not found. Pass it via options.SuperSonicClass or load via CDN.'
      )
    }
    this.SuperSonicClass = SuperSonicClass
    // Prefer SuperSonic's built-in OSC encoder; fall back to our minimal implementation
    this.oscEncoder = SuperSonicClass.osc ?? { encodeSingleBundle: fallbackEncodeSingleBundle }

    // SuperSonic constructor options — URLs for workers, WASM, synthdefs, samples.
    // Workers and JS live in the main package; WASM in the core package.
    // EXP-006: pinned to v0.57.0 to test if pre-faff87a (2026-03-03) MdaPiano build restores :piano
    const pkgBase = 'https://unpkg.com/supersonic-scsynth@0.57.0/dist/'
    const coreBase = 'https://unpkg.com/supersonic-scsynth-core@0.57.0/'
    this.resolvedSampleBaseURL = this.options.sampleBaseURL ?? 'https://unpkg.com/supersonic-scsynth-samples@0.57.0/samples/'
    this.sonic = new SuperSonicClass({
      baseURL: this.options.baseURL ?? pkgBase,
      workerBaseURL: this.options.baseURL ?? `${pkgBase}workers/`,
      wasmBaseURL: this.options.coreBaseURL ?? `${coreBase}wasm/`,
      coreBaseURL: this.options.coreBaseURL ?? coreBase,
      synthdefBaseURL: this.options.synthdefBaseURL ?? 'https://unpkg.com/supersonic-scsynth-synthdefs@0.57.0/synthdefs/',
      sampleBaseURL: this.resolvedSampleBaseURL,
      autoConnect: false,
      scsynthOptions: { numOutputBusChannels: NUM_OUTPUT_CHANNELS },
    } as never)

    await this.sonic.init()

    // Pre-load common SynthDefs
    await this.sonic.loadSynthDefs(COMMON_SYNTHDEFS)
    for (const name of COMMON_SYNTHDEFS) {
      this.loadedSynthDefs.add(name)
    }

    // Create scsynth group structure matching Sonic Pi's studio.rb:
    //   STUDIO-MIXER (head of root) → MONITORS → STUDIO-FX → STUDIO-SYNTHS
    // Execution order: synths (100) → FX (101) → monitors (102) → mixer
    //
    // Group 102 (monitors) sits BETWEEN FX and mixer so monitors read
    // loopBus AFTER FX has written to it. This gives post-FX per-loop
    // audio taps — the scope shows what the user actually hears.
    const mixerGroupId = this.sonic.nextNodeId()
    this.sonic.send('/g_new', mixerGroupId, 0, 0)  // mixer group at head of root
    this.sonic.send('/g_new', 102, 2, mixerGroupId) // monitors group before mixer
    this.sonic.send('/g_new', 101, 2, 102)          // FX group before monitors
    this.sonic.send('/g_new', 100, 2, 101)          // synths group before FX

    // Load the track-monitor SynthDef via /d_recv — hand-compiled binary,
    // no CDN dependency. Must load BEFORE any /s_new for it (SP5 trap).
    this.sonic.send('/d_recv', buildTrackMonitorSynthDef())
    this.monitorSynthDefLoaded = true

    // Load and create the master mixer synth — same synthdef as desktop Sonic Pi.
    // Signal chain: in_bus+out_bus → pre_amp → HPF → LPF → Limiter.ar(0.99) → LeakDC → amp → ReplaceOut
    // IMPORTANT: in_bus must be a SEPARATE private bus, not bus 0.
    // The synthdef sums in(out_bus) + in(in_bus). If both are 0, signal is doubled.
    // Sonic Pi allocates @mixer_bus = new_bus(:audio) for in_bus.
    await this.sonic.loadSynthDef('sonic-pi-mixer')
    const mixerBus = this.allocateBus() // private bus — nothing writes to it, reads as silence
    this.mixerNodeId = this.sonic.nextNodeId()
    this.sonic.send('/s_new', 'sonic-pi-mixer', this.mixerNodeId, 0, mixerGroupId,
      'out_bus', 0,
      'in_bus', mixerBus,
      'amp', this.currentMixerAmp,
      'pre_amp', this.currentMasterVolume * this.currentMixerPreAmp,
      'hpf', MIXER.HPF,
      'lpf', MIXER.LPF,
      'limiter_bypass', MIXER.LIMITER_BYPASS,
    )
    await this.sonic.sync()

    // Multi-channel audio routing:
    // Worklet outputs NUM_OUTPUT_CHANNELS channels (autoConnect=false, we route manually).
    // Channels 0-1 = master bus, 2-3 = track 0, 4-5 = track 1, etc.
    // All channels mix to stereo for speakers; each pair also gets its own AnalyserNode.
    const audioCtx = this.sonic.audioContext
    const workletNode = (this.sonic.node as unknown as Record<string, AudioNode>).input ?? this.sonic.node

    // Split worklet output into individual channels
    this.splitter = audioCtx.createChannelSplitter(NUM_OUTPUT_CHANNELS)
    workletNode.connect(this.splitter)

    // Mix channel pair 0-1 (mixer output) to stereo for speakers.
    // All synths write to bus 0, mixer processes bus 0, outputs to bus 0.
    // Only bus 0 channels carry audio — other channels are for per-track AnalyserNode taps.
    this.masterMerger = audioCtx.createChannelMerger(2)
    this.splitter.connect(this.masterMerger, 0, 0)     // bus 0 left
    this.splitter.connect(this.masterMerger, 1, 1)     // bus 0 right

    // Master gain control — volume is handled by the scsynth mixer synthdef
    // (pre_amp=0.3 × amp=0.8 = 0.24 effective gain, matching Sonic Tau).
    // Web Audio gain is just for the UI volume slider (default 1.0, no additional scaling).
    this.masterGainNode = audioCtx.createGain()
    this.masterGainNode.gain.value = 1.0

    // Master analyser taps the mixed stereo → gain → speakers
    // No DynamicsCompressor needed — Limiter.ar inside scsynth handles clipping prevention.
    this.analyserNode = audioCtx.createAnalyser()
    this.analyserNode.fftSize = AUDIO_IO.ANALYSER_FFT_SIZE
    this.analyserNode.smoothingTimeConstant = AUDIO_IO.ANALYSER_SMOOTHING
    this.masterMerger.connect(this.analyserNode)
    this.analyserNode.connect(this.masterGainNode)
    this.masterGainNode.connect(audioCtx.destination)

    // Per-channel analysers for stereo scope + true lissajous (L=X, R=Y)
    this.analyserL = audioCtx.createAnalyser()
    this.analyserL.fftSize = AUDIO_IO.ANALYSER_FFT_SIZE
    this.analyserL.smoothingTimeConstant = AUDIO_IO.ANALYSER_SMOOTHING
    this.analyserR = audioCtx.createAnalyser()
    this.analyserR.fftSize = AUDIO_IO.ANALYSER_FFT_SIZE
    this.analyserR.smoothingTimeConstant = AUDIO_IO.ANALYSER_SMOOTHING
    this.splitter.connect(this.analyserL, 0) // left channel
    this.splitter.connect(this.analyserR, 1) // right channel
  }

  get audioContext(): AudioContext | null {
    return this.sonic?.audioContext ?? null
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  /**
   * Master output node — sits between scsynth's mixer output and
   * `audioContext.destination`. Tap point for the DSL `recording_*`
   * functions (#228). Downstream of all SoundLayer param normalization,
   * so recording captures exactly what the user hears.
   */
  get masterOutputNode(): AudioNode | null {
    return this.masterGainNode
  }

  get analyserLeft(): AnalyserNode | null {
    return this.analyserL
  }

  get analyserRight(): AnalyserNode | null {
    return this.analyserR
  }

  /** Expose SuperSonic metrics for diagnostics. Returns null if not available. */
  getMetrics(): Record<string, unknown> | null {
    if (!this.sonic) return null
    const s = this.sonic as unknown as Record<string, unknown>
    if (typeof s.getMetrics === 'function') {
      return s.getMetrics() as Record<string, unknown>
    }
    return null
  }

  /** Set master volume (0-1). Controls both scsynth mixer pre_amp and Web Audio gain. */
  setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume))
    this.currentMasterVolume = clamped
    // pre_amp on the wire = master volume × user-pref pre_amp baseline.
    // The pref baseline lets users dial in headroom independent of volume.
    const scaledPreAmp = clamped * this.currentMixerPreAmp
    this.sonic?.send('/n_set', this.mixerNodeId, 'pre_amp', scaledPreAmp)
    // Web Audio gain for UI slider feedback (not the primary volume control)
    if (this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(clamped, this.masterGainNode.context.currentTime, 0.02)
    }
  }

  /** Set mixer amp (final gain stage). Live — sends /n_set immediately if
   *  the mixer node is alive. New value also persists for any future
   *  resetMixer / re-init. Range typically 0.5–6 (3 lands at WASM parity
   *  with desktop's pre-driver-attenuation peak; 6 clips Limiter.ar). */
  setMixerAmp(amp: number): void {
    this.currentMixerAmp = amp
    if (this.sonic && this.mixerNodeId) {
      this.sonic.send('/n_set', this.mixerNodeId, 'amp', amp)
    }
  }

  /** Set mixer pre_amp baseline. Effective wire value = masterVolume × preAmp,
   *  so dragging this slider with volume<1 still attenuates proportionally. */
  setMixerPreAmp(preAmp: number): void {
    this.currentMixerPreAmp = preAmp
    if (this.sonic && this.mixerNodeId) {
      const scaledPreAmp = this.currentMasterVolume * preAmp
      this.sonic.send('/n_set', this.mixerNodeId, 'pre_amp', scaledPreAmp)
    }
  }

  /**
   * Set arbitrary mixer params (Tier C PR #3 #255 — set_mixer_control! DSL).
   * The allowlist matches the sonic-pi-mixer synthdef's parameter vocabulary
   * (pre_amp/amp/hpf/lpf and four bypass flags). Param names not in this
   * set are silently dropped by scsynth, so we filter + surface a console
   * warning instead — making the parameter-name boundary loud rather than
   * quiet. Returns the names actually applied for telemetry / test assertion.
   */
  setMixerControl(opts: Record<string, number>): string[] {
    if (!this.sonic) return []
    const ALLOWED = new Set([
      'pre_amp', 'amp', 'hpf', 'lpf',
      'hpf_bypass', 'lpf_bypass', 'limiter_bypass', 'leak_dc_bypass',
    ])
    const applied: string[] = []
    for (const [key, value] of Object.entries(opts)) {
      if (!ALLOWED.has(key)) {
        console.warn(`[SonicPi] set_mixer_control! ignoring unknown param "${key}". Known: ${[...ALLOWED].join(', ')}`)
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      this.sonic.send('/n_set', this.mixerNodeId, key, value)
      applied.push(key)
    }
    return applied
  }

  /**
   * Reset mixer to MIXER config defaults (Tier C PR #3 #255 — reset_mixer! DSL).
   * Mirrors the initialization sequence in connect() so a sweep can be
   * undone in one call.
   */
  resetMixer(): void {
    if (!this.sonic) return
    this.sonic.send('/n_set', this.mixerNodeId,
      'amp', MIXER.AMP,
      'pre_amp', MIXER.PRE_AMP,
      'hpf', MIXER.HPF,
      'lpf', MIXER.LPF,
      'limiter_bypass', MIXER.LIMITER_BYPASS,
      'hpf_bypass', 0,
      'lpf_bypass', 0,
      'leak_dc_bypass', 0,
    )
  }

  /**
   * Snapshot scsynth-side info for the `scsynth_info` DSL fn (#255).
   * SuperSonic doesn't expose all of scsynth's runtime constants; we surface
   * what we know (sample_rate, num_buffers from MIXER/AUDIO_BUFFERS config)
   * and fill the rest with the values from a default scsynth instance so
   * user code that does `scsynth_info.sample_rate` gets a real number.
   */
  getScsynthInfo(): Record<string, number> {
    const sampleRate = this.sonic?.audioContext.sampleRate ?? 44100
    return {
      sample_rate: sampleRate,
      sample_dur: 1 / sampleRate,
      radians_per_sample: (2 * Math.PI) / sampleRate,
      control_rate: sampleRate / 64,
      control_dur: 64 / sampleRate,
      subsample_offset: 0,
      num_output_busses: 16,
      num_input_busses: 16,
      num_audio_busses: 1024,
      num_control_busses: 4096,
      num_buffers: 4096,
    }
  }

  /** Snapshot for the `status` DSL fn (#255). Counts loaded synthdefs. */
  getStatus(): Record<string, number> {
    const sampleRate = this.sonic?.audioContext.sampleRate ?? 44100
    return {
      ugens: 0,                                 // not tracked in WASM scsynth
      synths: 0,                                // not tracked
      groups: 2,                                // synthGroup + fxGroup + mixerGroup vary; report 2 as floor
      sdefs: this.loadedSynthDefs.size,
      avg_cpu: 0,                               // not exposed by SuperSonic
      peak_cpu: 0,
      nom_samp_rate: sampleRate,
      act_samp_rate: sampleRate,
      audio_busses: 1024,
      control_busses: 4096,
    }
  }

  /**
   * Enable OSC trace logging — callback receives formatted trace strings
   * matching desktop Sonic Pi's output style.
   *
   * Example output:
   *   /s_new "sonic-pi-basic_stereo_player" 1003 0 100 {buf: 0, amp: 1.5, lpf: 130, out_bus: 0}
   */
  setOscTraceHandler(handler: ((msg: string) => void) | null): void {
    this.oscTraceHandler = handler
  }

  /**
   * Queue an OSC message for batched dispatch.
   * Sonic Pi's model: all play/sample calls between sleeps are collected,
   * then dispatched as ONE OSC bundle on sleep — sharing a single NTP timetag.
   */
  private queueMessage(
    audioTime: number,
    address: string,
    args: (string | number)[],
  ): void {
    this.messageQueueAudioTime = audioTime
    this.messageQueue.push({ address, args })

    // Trace logging — formatted like desktop Sonic Pi's trace output
    if (this.oscTraceHandler) {
      this.oscTraceHandler(formatOscTrace(address, args, audioTime))
    }
  }

  /**
   * Flush all queued messages as a single OSC bundle.
   * Called by the interpreter on sleep/sync/end-of-iteration.
   * Matches Sonic Pi's __schedule_delayed_blocks_and_messages!
   */
  flushMessages(audioTime?: number): void {
    if (!this.sonic || this.messageQueue.length === 0) return
    const t = audioTime ?? this.messageQueueAudioTime
    const ntpTime = audioTimeToNTP(t, this.sonic.audioContext.currentTime)

    if (this.messageQueue.length === 1) {
      // Single message — use the lighter encodeSingleBundle
      const msg = this.messageQueue[0]
      const bundle = this.oscEncoder!.encodeSingleBundle(ntpTime, msg.address, msg.args)
      this.sonic.sendOSC(bundle)
    } else {
      // Multiple messages — try batching, fall back to individual sends
      // if the combined bundle exceeds SuperSonic's 1024-byte limit.
      try {
        const bundle = fallbackEncodeBundle(ntpTime, this.messageQueue)
        this.sonic.sendOSC(bundle)
      } catch {
        // Bundle too large — send each message as its own bundle
        for (const msg of this.messageQueue) {
          const single = this.oscEncoder!.encodeSingleBundle(ntpTime, msg.address, msg.args)
          this.sonic.sendOSC(single)
        }
      }
    }
    this.messageQueue.length = 0
  }

  private ensureSynthDefLoaded(name: string): Promise<void> {
    const fullName = name.startsWith('sonic-pi-') ? name : `sonic-pi-${name}`
    if (this.loadedSynthDefs.has(fullName)) return Promise.resolve()
    // Return existing in-flight promise to avoid duplicate loads
    const pending = this.pendingSynthDefLoads.get(fullName)
    if (pending) return pending
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    const p = this.sonic.loadSynthDef(fullName).then(() => {
      this.loadedSynthDefs.add(fullName)
      this.pendingSynthDefLoads.delete(fullName)
    })
    this.pendingSynthDefLoads.set(fullName, p)
    return p
  }

  private ensureSampleLoaded(name: string): Promise<number> {
    const existing = this.loadedSamples.get(name)
    if (existing !== undefined) return Promise.resolve(existing)
    // Return existing in-flight promise to avoid duplicate loads + buffer leak
    const pending = this.pendingSampleLoads.get(name)
    if (pending) return pending
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    const bufNum = this.nextBufNum++
    const p = this.sonic.loadSample(bufNum, `${name}.flac`).then(() => {
      this.loadedSamples.set(name, bufNum)
      this.pendingSampleLoads.delete(name)
      this.fetchSampleDuration(name).catch(err =>
        console.warn(`[SonicPi] Could not determine duration for ${name}: ${err.message}`))
      return bufNum
    })
    this.pendingSampleLoads.set(name, p)
    return p
  }

  /**
   * Decode the sample via Web Audio to get its exact duration in seconds.
   * Fires once per sample name and caches the result.
   * Used by beat_stretch / pitch_stretch to apply Sonic Pi's exact formula.
   */
  private async fetchSampleDuration(name: string): Promise<void> {
    if (this.sampleDurations.has(name)) return
    if (!this.sonic) return
    const url = `${this.resolvedSampleBaseURL}${name}.flac`
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await this.sonic.audioContext.decodeAudioData(arrayBuffer)
    this.sampleDurations.set(name, audioBuffer.duration)
  }

  /**
   * Trigger a synth. Fast path: if synthdef already loaded, no async/await overhead.
   * The await in ensureSynthDefLoaded creates a microtask yield even on cache hit,
   * which at 43 events/sec causes significant event loop contention. See #71.
   */
  triggerSynth(
    synthName: string,
    audioTime: number,
    params: Record<string, number>
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const fullName = synthName.startsWith('sonic-pi-') ? synthName : `sonic-pi-${synthName}`

    // Fast path: synthdef already loaded — skip async entirely
    if (this.loadedSynthDefs.has(fullName)) {
      return Promise.resolve(this.triggerSynthImmediate(fullName, audioTime, params))
    }

    // Slow path: load synthdef first (only happens once per synth name)
    return this.ensureSynthDefLoaded(fullName).then(() =>
      this.triggerSynthImmediate(fullName, audioTime, params)
    )
  }

  private triggerSynthImmediate(
    fullName: string,
    audioTime: number,
    params: Record<string, number>,
  ): number {
    const nodeId = this.sonic!.nextNodeId()
    const paramList: (string | number)[] = []
    for (const key in params) {
      paramList.push(key, params[key])
    }
    this.queueMessage(audioTime, '/s_new', [fullName, nodeId, 0, 100, ...paramList])

    // Schedule node free after expected duration (#73).
    // Params are already BPM-scaled (in seconds) at this point.
    // Only during real playback (audioTime > 0) — not during tests.
    // Only during real playback — audioContext.currentTime is 0 in mocks/tests
    if ((this.sonic?.audioContext?.currentTime ?? 0) > 0) {
      this.scheduleNodeFree(nodeId, audioTime, params)
    }

    return nodeId
  }

  /**
   * Schedule /n_free for a synth node after its expected lifetime.
   * Uses setTimeout + sonic.send() — the immediate send path is reliable
   * for /n_free (scsynth may not process /n_free inside timetaged bundles).
   * The setTimeout fires on the main thread, but each call is <1ms.
   * See #73, #75.
   */
  private scheduleNodeFree(
    nodeId: number,
    audioTime: number,
    params: Record<string, number>,
  ): void {
    const attack = params.attack ?? 0
    const decay = params.decay ?? 0
    const sustain = params.sustain ?? 0
    const release = params.release ?? 1
    const duration = attack + decay + sustain + release

    const freeTime = audioTime + duration + 0.1
    const audioCtx = this.sonic?.audioContext
    if (!audioCtx) return
    const delayMs = (freeTime - audioCtx.currentTime) * 1000
    if (delayMs <= 0) return

    setTimeout(() => {
      this.sonic?.send('/n_free', nodeId)
    }, delayMs)
  }

  /**
   * Play a sample. Fast path: if sample + synthdef already loaded, no async overhead.
   * See triggerSynth comment re: microtask yield cost at high event density (#71).
   */
  playSample(
    sampleName: string,
    audioTime: number,
    opts?: Record<string, number>,
    bpm?: number
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const playerName = selectSamplePlayer(opts)
    const bufNum = this.loadedSamples.get(sampleName)

    // Fast path: sample loaded + synthdef loaded — skip async entirely
    if (bufNum !== undefined && this.loadedSynthDefs.has(playerName)) {
      return Promise.resolve(this.playSampleImmediate(sampleName, bufNum, playerName, audioTime, opts, bpm))
    }

    // Slow path: load sample/synthdef first (only happens once per sample name)
    return this.playSampleSlow(sampleName, playerName, audioTime, opts, bpm)
  }

  private playSampleImmediate(
    sampleName: string,
    bufNum: number,
    playerName: string,
    audioTime: number,
    opts?: Record<string, number>,
    bpm?: number,
  ): number {
    const nodeId = this.sonic!.nextNodeId()
    const duration = this.sampleDurations.get(sampleName) ?? null
    const translated = translateSampleOpts(opts, bpm ?? 60, duration)
    const sampleWarn = this.warnHandler
      ? (m: string) => this.warnHandler!(`[Warning] sample :${sampleName} — ${m}`)
      : undefined
    const params = normalizeSampleParams(translated, bpm ?? 60, sampleWarn)

    const paramList: (string | number)[] = ['buf', bufNum]
    for (const key in params) {
      paramList.push(key, params[key])
    }

    this.queueMessage(audioTime, '/s_new', [playerName, nodeId, 0, 100, ...paramList])

    // Schedule node free after expected sample duration (#73)
    // Only during real playback — audioContext.currentTime is 0 in mocks/tests
    if ((this.sonic?.audioContext?.currentTime ?? 0) > 0) {
      this.scheduleSampleNodeFree(nodeId, sampleName, audioTime, params)
    }

    return nodeId
  }

  /**
   * Schedule /n_free for a sample node after its expected playback duration.
   * Uses setTimeout + sonic.send() (same as scheduleNodeFree).
   */
  private scheduleSampleNodeFree(
    nodeId: number,
    sampleName: string,
    audioTime: number,
    params: Record<string, number>,
  ): void {
    const sampleDur = this.sampleDurations.get(sampleName) ?? null
    const rate = Math.abs(params.rate ?? 1)
    const finish = params.finish ?? 1
    const start = params.start ?? 0
    const release = params.release ?? 0
    const attack = params.attack ?? 0
    const sustain = params.sustain ?? 0

    let playDuration: number
    if (sustain > 0 && sustain < 100) {
      playDuration = attack + sustain + release
    } else if (sampleDur !== null && rate > 0) {
      playDuration = (sampleDur * (finish - start)) / rate + release
    } else {
      playDuration = 2.0
    }

    const freeTime = audioTime + playDuration + 0.1
    const audioCtx = this.sonic?.audioContext
    if (!audioCtx) return
    const delayMs = (freeTime - audioCtx.currentTime) * 1000
    if (delayMs <= 0) return

    setTimeout(() => {
      this.sonic?.send('/n_free', nodeId)
    }, delayMs)
  }

  private async playSampleSlow(
    sampleName: string,
    playerName: string,
    audioTime: number,
    opts?: Record<string, number>,
    bpm?: number,
  ): Promise<number> {
    const bufNum = await this.ensureSampleLoaded(sampleName)
    if (playerName !== 'sonic-pi-basic_stereo_player') {
      await this.ensureSynthDefLoaded(playerName)
    }
    return this.playSampleImmediate(sampleName, bufNum, playerName, audioTime, opts, bpm)
  }

  /** Apply an FX. Fast path when synthdef already loaded. */
  applyFx(
    fxName: string,
    audioTime: number,
    params: Record<string, number>,
    inBus: number,
    outBus: number = 0
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const fullName = fxName.startsWith('sonic-pi-') ? fxName : `sonic-pi-fx_${fxName}`

    if (this.loadedSynthDefs.has(fullName)) {
      return Promise.resolve(this.applyFxImmediate(fullName, audioTime, params, inBus, outBus))
    }

    return this.ensureSynthDefLoaded(fullName).then(() =>
      this.applyFxImmediate(fullName, audioTime, params, inBus, outBus)
    )
  }

  /** FX that require rand_buf injection — matches Desktop SP's on_start hooks.
   *  REF: synthinfo.rb:6960 FXSlicer, :7225 FXWobble, :7470 FXPanSlicer */
  private static readonly RAND_BUF_FX = new Set([
    'sonic-pi-fx_slicer', 'sonic-pi-fx_wobble', 'sonic-pi-fx_panslicer',
  ])

  private applyFxImmediate(
    fullName: string,
    audioTime: number,
    params: Record<string, number>,
    inBus: number,
    outBus: number,
  ): number {
    const nodeId = this.sonic!.nextNodeId()
    const paramList: (string | number)[] = ['in_bus', inBus, 'out_bus', outBus]
    // Inject rand_buf for slicer/wobble/panslicer — mirrors on_start hook in synthinfo.rb.
    // Lazy allocation: first use creates the buffer. Avoids init() timeout issues.
    if (SuperSonicBridge.RAND_BUF_FX.has(fullName)) {
      if (this.randBufId < 0) {
        const bufNum = this.nextBufNum++
        this.sonic!.send('/b_alloc', bufNum, 16, 1)
        this.sonic!.send('/b_setn', bufNum, 0, 16,
          0.23, -0.71, 0.52, -0.33, 0.89, -0.14, 0.67, -0.82,
          0.41, -0.58, 0.76, -0.27, 0.93, -0.45, 0.18, -0.63)
        this.randBufId = bufNum
      }
      paramList.push('rand_buf', this.randBufId)
    }
    for (const key in params) {
      paramList.push(key, params[key])
    }
    this.queueMessage(audioTime, '/s_new', [fullName, nodeId, 0, 101, ...paramList])
    return nodeId
  }

  /**
   * Returns true if a live audio stream under this name is currently active
   * OR mid-acquisition. Used by AudioInterpreter to avoid re-starting the
   * mic on every `synth :sound_in` dispatch inside a live_loop (#152).
   */
  isLiveAudioStreaming(name: string): boolean {
    return this.liveAudioStreams.has(name) || this.pendingLiveAudio.has(name)
  }

  /**
   * Start capturing live audio from the system input (microphone/line-in).
   * The stream is connected to the scsynth AudioWorkletNode so SoundIn.ar
   * inside the `sonic-pi-sound_in` synthdef can read the mic signal.
   *
   * **Idempotent and race-safe** (#152): if a stream already exists under
   * this name, or a `getUserMedia` call is in-flight for it, returns
   * immediately. Without this the AudioInterpreter's per-dispatch auto-start
   * would tear down and re-acquire the mic ~10×/sec inside a live_loop,
   * making the browser indicator flicker and the audio drop out.
   */
  async startLiveAudio(name: string, opts?: { stereo?: boolean }): Promise<void> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    // Already running or mid-acquisition — skip. Callers that genuinely want
    // to reconfigure (mono ↔ stereo) must stopLiveAudio(name) first.
    if (this.liveAudioStreams.has(name) || this.pendingLiveAudio.has(name)) return

    this.pendingLiveAudio.add(name)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: opts?.stereo ? 2 : 1,
        } as MediaTrackConstraints,
      })

      // Another caller may have stopped/disposed during the await — bail out
      // if we're no longer supposed to be acquiring.
      if (!this.pendingLiveAudio.has(name)) {
        stream.getTracks().forEach(t => t.stop())
        return
      }

      const audioCtx = this.sonic.audioContext
      const source = audioCtx.createMediaStreamSource(stream)
      // Connect mic INTO the scsynth AudioWorkletNode so SoundIn.ar(bus) can
      // read it. The synthdef `sonic-pi-sound_in` reads from bus 0 (hardware
      // input), which maps to the WorkletNode's first input channel (#152).
      //
      // SuperSonic's `.node` is a wrapper object (see its docs/GUIDE.md:80 —
      // `micSource.connect(supersonic.node.input)`). The real AudioNode lives
      // at `.input`; using `.node` directly throws "Overload resolution failed".
      // Mirror the pattern already used in init() at line 242.
      const nodeWrapper = this.sonic.node as unknown as Record<string, AudioNode>
      const workletNode = nodeWrapper.input ?? (this.sonic.node as unknown as AudioNode)
      source.connect(workletNode)

      this.liveAudioStreams.set(name, { stream, source })
    } finally {
      this.pendingLiveAudio.delete(name)
    }
  }

  /** Stop a named live audio stream and release its resources. */
  stopLiveAudio(name: string): void {
    const entry = this.liveAudioStreams.get(name)
    if (entry) {
      entry.source.disconnect()
      entry.stream.getTracks().forEach(t => t.stop())
      this.liveAudioStreams.delete(name)
    }
  }

  /**
   * Stop every active live audio stream and release mic tracks (#152).
   * Called on engine stop so the browser's mic indicator clears and the
   * mic stops feeding scsynth's input channel between runs.
   *
   * Also clears pendingLiveAudio so any in-flight getUserMedia call
   * detects the cancellation after its await and tears down the stream
   * it just acquired instead of racing past the stop.
   */
  stopAllLiveAudio(): void {
    this.pendingLiveAudio.clear()
    for (const name of Array.from(this.liveAudioStreams.keys())) {
      this.stopLiveAudio(name)
    }
  }

  /**
   * Allocate a stereo output bus for a track with its own AnalyserNode.
   * Returns the bus number to use as out_bus in synth params.
   * The bus audio is automatically routed to speakers via the worklet's
   * multi-channel output + Web Audio ChannelSplitter.
   */
  allocateTrackBus(trackId: string): number {
    const existing = this.trackBuses.get(trackId)
    if (existing !== undefined) return existing

    if (this.nextTrackBus >= NUM_OUTPUT_CHANNELS) {
      // Out of track buses — fall back to master bus 0
      return 0
    }

    const busNum = this.nextTrackBus
    this.nextTrackBus += 2 // stereo pair

    this.trackBuses.set(trackId, busNum)

    // Create per-track AnalyserNode using the shared splitter
    if (this.sonic && this.splitter) {
      const audioCtx = this.sonic.audioContext
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = AUDIO_IO.ANALYSER_FFT_SIZE
      analyser.smoothingTimeConstant = AUDIO_IO.ANALYSER_SMOOTHING

      const merger = audioCtx.createChannelMerger(2)
      this.splitter.connect(merger, busNum, 0)
      this.splitter.connect(merger, busNum + 1, 1)
      merger.connect(analyser)

      this.trackAnalysers.set(trackId, analyser)
    }

    return busNum
  }

  /** Get the per-track AnalyserNode for a specific track. */
  getTrackAnalyser(trackId: string): AnalyserNode | null {
    return this.trackAnalysers.get(trackId) ?? null
  }

  /** Get all per-track AnalyserNodes. */
  getAllTrackAnalysers(): Map<string, AnalyserNode> {
    return this.trackAnalysers
  }

  // ── Per-loop audio isolation (monitor synths) ────────────────
  //
  // Each live_loop gets:
  //   1. A loopBus (internal scsynth bus, from the 128-bus pool)
  //   2. A monitor synth in group 102 (reads loopBus, writes to
  //      bus 0 for the mixer AND to a trackBus output channel
  //      for the per-track AnalyserNode)
  //
  // task.outBus is set to loopBus so all synths + FX in that loop
  // write there. The monitor fans out post-FX.
  //
  // Bare code (no live_loop) keeps outBus = 0, no monitor.

  /**
   * Create a per-loop monitor synth. Returns the loopBus number that
   * the loop's synths should write to (via task.outBus).
   *
   * If a monitor already exists for this name (hot-swap), reuses it.
   * The monitor persists across loop iterations (SP11 pattern — same
   * lifecycle as persistentFx).
   */
  createLoopMonitor(name: string): number {
    const existing = this.loopMonitors.get(name)
    if (existing) return existing.loopBus

    if (!this.sonic || !this.monitorSynthDefLoaded) return 0 // fallback

    // Allocate internal bus for this loop's audio
    const loopBus = this.allocateBus()

    // Allocate output channel for the per-track AnalyserNode tap.
    // allocateTrackBus also creates the WebAudio AnalyserNode.
    // Falls back to 0 (master) if out of output channels.
    const trackBus = this.allocateTrackBus(name)

    // Create monitor synth in group 102 (after FX, before mixer).
    // addAction 1 = addToTail so it executes after any existing monitors.
    // Param names must match the SynthDef exactly (SP9 trap).
    const monitorNodeId = this.sonic.nextNodeId()
    this.sonic.send('/s_new', 'sonic_pi_track_monitor', monitorNodeId, 1, 102,
      'in_bus', loopBus,
      'out_bus_master', 0,
      'out_bus_track', trackBus,
      'amp', 1,
    )

    this.loopMonitors.set(name, { loopBus, monitorNodeId })
    return loopBus
  }

  /**
   * Get the loopBus for a named loop (0 if no monitor exists).
   * The engine uses this to set task.outBus.
   */
  getLoopBus(name: string): number {
    return this.loopMonitors.get(name)?.loopBus ?? 0
  }

  /**
   * Free a specific loop's monitor synth and return its bus to the pool.
   * Called when a loop is removed during hot-swap.
   */
  freeLoopMonitor(name: string): void {
    const monitor = this.loopMonitors.get(name)
    if (!monitor) return
    this.sonic?.send('/n_free', monitor.monitorNodeId)
    this.freeBus(monitor.loopBus)
    this.loopMonitors.delete(name)
  }

  /**
   * Free all monitor synths (called on stop / re-evaluate).
   * The loopBus numbers are returned to the pool so they can be
   * reused on the next run. Monitor synths are also freed via
   * /g_freeAll 102 in freeAllNodes(), but we clean the map here
   * so createLoopMonitor() knows to recreate them.
   */
  private clearLoopMonitors(): void {
    for (const [, { loopBus }] of this.loopMonitors) {
      this.freeBus(loopBus)
    }
    this.loopMonitors.clear()
  }

  /** Allocate a private audio bus for FX routing. Reserves a stereo pair
   *  (bus N and N+1) — every relevant synthdef in our chain
   *  (basic_stereo_player, fx_*) reads or writes 2 channels. Adjacent
   *  mono allocations would collide on the inner channel, summing the
   *  upstream stereo write into a downstream stereo write at the same
   *  address (exp-008). NUM_OUTPUT_CHANNELS is even by construction. */
  allocateBus(): number {
    if (this.freeBuses.length > 0) return this.freeBuses.pop()!
    const bus = this.nextBusNum
    this.nextBusNum += 2
    return bus
  }

  /** Release a private audio bus back to the pool. Guards against duplicate frees. */
  freeBus(busNum: number): void {
    if (!this.freeBuses.includes(busNum)) this.freeBuses.push(busNum)
  }

  /**
   * Register a custom (user-uploaded) sample from raw audio file bytes.
   * The ArrayBuffer is passed to SuperSonic's loadSample() which decodes
   * it via Web Audio and copies the PCM data to the WASM shared buffer.
   * After registration, `sample :user_mykick` works like any built-in sample.
   */
  async registerCustomSample(name: string, audioData: ArrayBuffer): Promise<void> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    const bufNum = this.nextBufNum++
    // SuperSonic.loadSample accepts ArrayBuffer directly (lib_buffer_manager.js:prepareFromBlob)
    await this.sonic.loadSample(bufNum, audioData as unknown as string)
    this.loadedSamples.set(name, bufNum)
    // Decode via Web Audio for duration cache
    try {
      const audioBuffer = await this.sonic.audioContext.decodeAudioData(audioData.slice(0))
      this.sampleDurations.set(name, audioBuffer.duration)
    } catch {
      // Duration unknown — beat_stretch won't work, but playback still will
    }
  }

  /** Check if a sample has been loaded (duration cached). */
  isSampleLoaded(name: string): boolean {
    return this.loadedSamples.has(name)
  }

  /** Get cached sample duration in seconds, or undefined if not yet loaded. */
  getSampleDuration(name: string): number | undefined {
    return this.sampleDurations.get(name)
  }

  /** Return loaded sample names (Tier C PR #2 #253 — for sample_paths host stub). */
  getLoadedSampleNames(): string[] {
    return Array.from(this.loadedSamples.keys())
  }

  /**
   * Preload a sample into the cache (Tier C PR #2 #253 — for load_samples DSL).
   * Returns the buffer number once loaded. Same lazy-load path used by sample
   * playback — re-loads are deduped via pendingSampleLoads.
   */
  preloadSample(name: string): Promise<number> {
    return this.ensureSampleLoaded(name)
  }

  /**
   * Free a single sample from the loaded cache (Tier C PR #2 #253).
   * The next `sample :name` re-loads it from CDN. We don't free the scsynth
   * buffer slot — bufNum recycling would require tracking which synths still
   * reference it, and the cost of holding an unused buffer is one int. Drops
   * the duration cache entry too so beat_stretch falls back to default.
   */
  freeSample(name: string): boolean {
    const had = this.loadedSamples.delete(name)
    this.sampleDurations.delete(name)
    return had
  }

  /** Free every loaded sample (Tier C PR #2 #253). Returns the count freed. */
  freeAllSamples(): number {
    const count = this.loadedSamples.size
    this.loadedSamples.clear()
    this.sampleDurations.clear()
    return count
  }

  /** Free all synth, FX, and monitor nodes (clean slate for re-evaluate). */
  freeAllNodes(): void {
    if (!this.sonic) return
    // Drain pending JS-side bundles AND clear scsynth's WASM scheduler queue
    // before freeing nodes. Without purge(), `/s_new` bundles already shipped
    // with future timetags (the ~0.5–1s lookahead) keep spawning new synths
    // AFTER /g_freeAll runs, producing an audible tail on Stop.
    // Fire-and-forget: the clearSched postMessage and JS-side cancel are
    // synchronous side effects inside purge(); we only skip awaiting the ack.
    this.sonic.purge().catch(() => {})
    this.sonic.send('/g_freeAll', 100)  // synths group
    this.sonic.send('/g_freeAll', 101)  // FX group
    this.sonic.send('/g_freeAll', 102)  // monitors group
    this.clearLoopMonitors()            // return loopBuses to pool + clear map
  }

  /** Create a new group inside the FX group (101). Returns group ID. */
  createFxGroup(): number {
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    const groupId = this.sonic.nextNodeId()
    // Add to tail of FX group 101
    this.sonic.send('/g_new', groupId, 1, 101)
    return groupId
  }

  /** Kill an entire group and all its contents. */
  freeGroup(groupId: number): void {
    this.sonic?.send('/n_free', groupId)
  }

  /** Queue a timestamped /n_set control message for batched dispatch. */
  sendTimedControl(audioTime: number, nodeId: number, params: (string | number)[]): void {
    this.queueMessage(audioTime, '/n_set', [nodeId, ...params])
  }

  /** Send raw OSC message to SuperSonic (immediate, no timestamp). */
  send(address: string, ...args: (string | number | Uint8Array)[]): void {
    this.sonic?.send(address, ...args)
  }

  freeNode(nodeId: number): void {
    this.sonic?.send('/n_free', nodeId)
  }

  dispose(): void {
    // Stop all live audio streams
    this.stopAllLiveAudio()
    if (this.masterGainNode) {
      this.masterGainNode.disconnect()
      this.masterGainNode = null
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect()
      this.analyserNode = null
    }
    if (this.sonic) {
      this.sonic.destroy()
      this.sonic = null
    }
    this.loadedSynthDefs.clear()
    this.loadedSamples.clear()
  }
}
