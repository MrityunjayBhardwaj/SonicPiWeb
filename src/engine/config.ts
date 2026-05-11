/**
 * Engine Configuration — All tunable hyperparameters in one place.
 *
 * WHY THIS EXISTS:
 * WASM scsynth (via SuperSonic) produces raw float32 audio that bypasses
 * native audio drivers (CoreAudio/JACK/ALSA). The signal path is:
 *
 *   scsynth C++ output buffer → Float32Array → AudioWorklet .set() → Web Audio → speakers
 *
 * Every step is a direct memory copy with ZERO gain applied (verified:
 * scsynth_audio_worklet.js:1547, SuperSonicBridge.ts:275-302). The result:
 * identical synthdefs + identical params produce ~2.3x louder output in WASM
 * vs native. Desktop SP parameters (calibrated for driver-attenuated output)
 * cause clipping and "speaker bursting" in the browser.
 *
 * These parameters are calibrated for the browser WASM context, using
 * Sonic Tau (app.bundle.js:1774-1794) as the reference — it runs the
 * same SuperSonic WASM in the same browser environment.
 *
 * PARAMETER PROVENANCE:
 *   [TAU]     = Matches Sonic Tau's value (same WASM environment)
 *   [TUNED]   = A/B tested against Desktop SP WAV recordings
 *   [SP]      = Matches Desktop Sonic Pi (same synthdefs, same semantics)
 *   [WASM]    = Workaround for WASM-specific behavior
 *   [BROWSER] = Adapted for browser JS runtime (vs Ruby threads)
 */

// ---------------------------------------------------------------------------
// SECTION 1: MIXER GAIN STAGING
//
// The sonic-pi-mixer synthdef signal chain (inside scsynth):
//   In.ar(out_bus) → pre_amp → HPF → LPF → Limiter.ar(0.99) → LeakDC → amp → clip2(1) → ReplaceOut
//
// Desktop SP (live values verified via /g_queryTree, exp-010):
//   pre_amp=0.32, amp=6 → effective gain 1.92.
//   Native scsynth output is then attenuated by audio drivers before speakers.
//
// WASM scsynth: no driver attenuation. Raw float32 → AudioWorklet → speakers.
//
// Sonic Tau (the reference for browser WASM, app.bundle.js:1786-1787):
//   pre_amp=0.3, amp=0.8 — deliberately soft to keep signal in linear range.
//   This is our chosen baseline — Tau runs the same SuperSonic WASM in the
//   same browser environment, so its gain staging is the closest validated
//   reference for our context.
//
// Trade-off accepted: at these values, web peak/RMS sits ~0.19× desktop SP's
// driver-attenuated output. We optimise for browser-WASM headroom and dynamics
// safety (Tau's stance) over per-beat parity with Desktop SP captures. Parity
// comparators (tools/spectrogram-compare.py, FX inspector) should RMS-normalise
// before comparing — see SV26 / SV29 in the catalogues.
// ---------------------------------------------------------------------------

export const MIXER = {
  /** [TAU] Mixer pre-amplification. Sonic Tau baseline
   *  (app.bundle.js:1786-1787) for browser WASM. */
  PRE_AMP: 0.3,

  /** [TAU] Mixer final amplification. Sonic Tau baseline
   *  (app.bundle.js:1786-1787) for browser WASM — deliberately soft to
   *  keep the signal in the linear range below Limiter.ar(0.99). */
  AMP: 0.8,

  /** [TAU] High-pass filter cutoff (Hz). Removes subsonic rumble that can
   *  damage speakers. Desktop SP uses synthdef default. Sonic Tau sends 21
   *  explicitly (app.bundle.js:1788-1789). */
  HPF: 21,

  /** [TAU] Low-pass filter cutoff (MIDI note). Removes ultrasonic content that
   *  causes aliasing. Desktop SP uses synthdef default. Sonic Tau sends 135.5
   *  explicitly (app.bundle.js:1790-1791). */
  LPF: 135.5,

  /** [TAU] Limiter bypass flag. 0 = limiter active (Limiter.ar threshold=0.99,
   *  lookahead=10ms). Prevents hard clipping. Sonic Tau sends 0 explicitly
   *  (app.bundle.js:1792-1793). */
  LIMITER_BYPASS: 0,
} as const

// ---------------------------------------------------------------------------
// SECTION 2: SCHEDULER TIMING
//
// The VirtualTimeScheduler resolves sleep() Promises to advance virtual time.
// It needs to schedule audio events ahead of real time so scsynth has samples
// ready before the audio callback fires.
//
// Desktop SP uses 0.5s lookahead (Ruby threads have more scheduling jitter).
// Browser JS has less contention — 0.3s is sufficient.
//
// The tick interval (heartbeat) controls how often the scheduler checks for
// pending events. 25ms (40Hz) balances CPU usage vs scheduling resolution.
// Lower = more precise but more CPU. Higher = less CPU but more jitter.
// ---------------------------------------------------------------------------

export const SCHEDULER = {
  /** [BROWSER] Lookahead time in seconds. Events are sent to scsynth this far
   *  ahead of when they should sound. Desktop SP uses 0.5s (Ruby thread jitter).
   *  Browser JS needs less: 0.3s provides 260ms buffer at 7 concurrent loops. */
  SCHED_AHEAD_TIME: 0.3,

  /** [BROWSER] Scheduler heartbeat interval in ms. Controls how often pending
   *  events are checked. 25ms = 40Hz. Lower = more precise, more CPU. */
  TICK_INTERVAL_MS: 25,

  /** [SP] Tiebreak weight for deterministic ordering of same-time events.
   *  Must be far below audio precision (≥1ms). Ensures the min-heap resolves
   *  ties in insertion order, not arbitrary heap order. */
  HEAP_TIEBREAK_EPSILON: 1e-12,
} as const

// ---------------------------------------------------------------------------
// SECTION 3: SYNTHESIS DEFAULTS
//
// WASM scsynth uses the same compiled synthdefs as Desktop SP. But one
// parameter causes silence in the WASM build: env_curve.
//
// Desktop SP injects env_curve:2 (exponential envelope) into every synth.
// WASM scsynth silences overlapping nodes when env_curve:2 is present
// (SP22 — verified via differential testing: raw OSC without env_curve
// produces audio, engine path with env_curve produces silence).
//
// The fix: use env_curve:1 (linear). Minor timbre difference from Desktop SP.
// ---------------------------------------------------------------------------

export const SYNTHESIS = {
  /** [WASM] Envelope curve type. Desktop SP uses 2 (exponential).
   *  WASM scsynth silences overlapping synth nodes with env_curve:2 (SP22).
   *  Using 1 (linear) as workaround. Causes minor timbre difference. */
  ENV_CURVE: 1,

  /** [SP] Default release time in beats (applied to all synths before BPM scaling).
   *  Without this, scsynth uses compiled default in seconds — at 130 BPM,
   *  notes ring 2.17x too long (1s instead of 0.46s). */
  DEFAULT_RELEASE_BEATS: 1,
} as const

// ---------------------------------------------------------------------------
// SECTION 4: AUDIO I/O
//
// SuperSonic's AudioWorkletNode outputs N channels. We split them:
//   Channels 0-1 = master stereo bus (routed to speakers)
//   Channels 2-3 = track 0, 4-5 = track 1, etc. (for per-track analysis)
//
// Private scsynth buses (for FX routing) are allocated starting after
// the output channels. Bus 0 = master out, buses 14+ = private FX buses.
//
// The AnalyserNode provides FFT data for visualizations.
// ---------------------------------------------------------------------------

export const AUDIO_IO = {
  /** [SP] Maximum stereo track outputs beyond master. Each track gets a
   *  stereo pair for per-track level metering and visualization. */
  MAX_TRACK_OUTPUTS: 6,

  /** [SP] FFT size for AnalyserNode. Higher = more frequency resolution,
   *  more latency. 2048 is standard for music visualization. */
  ANALYSER_FFT_SIZE: 2048,

  /** [SP] Smoothing constant for AnalyserNode frequency data.
   *  0 = no smoothing (jumpy), 1 = frozen. 0.8 = smooth for UI. */
  ANALYSER_SMOOTHING: 0.8,

  /** [SP] scsynth group ID for synth nodes. Must match Desktop SP's
   *  group hierarchy for correct execution order. */
  GROUP_SYNTHS: 100,

  /** [SP] scsynth group ID for FX nodes. Placed after synths group
   *  so FX processes synth output. */
  GROUP_FX: 101,
} as const

// ---------------------------------------------------------------------------
// SECTION 5: SAFETY LIMITS
//
// User code runs in a sandboxed with() scope. These limits prevent
// runaway loops and excessive resource consumption.
// ---------------------------------------------------------------------------

export const SAFETY = {
  /** [SP] Maximum elements generated by Ring.range() before warning.
   *  Prevents memory explosion from `range(0, 1_000_000)`. */
  MAX_RANGE_SIZE: 10_000,
} as const

// ---------------------------------------------------------------------------
// SECTION 6: OSC & NTP
//
// SuperSonic receives OSC messages with NTP timestamps for sample-accurate
// scheduling. The NTP epoch offset converts between Unix time and NTP time.
// Buffer sizes are pre-allocated to avoid GC pressure during audio rendering.
// ---------------------------------------------------------------------------

export const OSC = {
  /** [SP] Seconds between NTP epoch (1900-01-01) and Unix epoch (1970-01-01).
   *  Used to convert performance.now() to NTP timetags for OSC bundles. */
  NTP_EPOCH_OFFSET: 2208988800,

  /** [BROWSER] Pre-allocated buffer for single OSC message encoding.
   *  Avoids allocation during audio callback. 4KB handles all message types. */
  SINGLE_BUF_SIZE: 4096,

  /** [BROWSER] Pre-allocated buffer for OSC bundle encoding.
   *  64KB handles bursts of messages in a single sleep window. */
  BUNDLE_BUF_SIZE: 65536,
} as const

// ---------------------------------------------------------------------------
// SECTION 7: RECORDING
//
// Browser-based audio recording via MediaRecorder API captures the
// final mixed output as WAV.
// ---------------------------------------------------------------------------

export const RECORDING = {
  /** [BROWSER] MediaRecorder chunk interval in ms. Controls memory:
   *  shorter = more frequent data events, less buffered in memory. */
  CHUNK_INTERVAL_MS: 100,

  /** [SP] Output WAV bit depth. 16-bit PCM is CD quality and universally
   *  compatible. 32-bit float would preserve full dynamic range but
   *  produces 2x larger files. */
  BITS_PER_SAMPLE: 16,
} as const

// ---------------------------------------------------------------------------
// SECTION 8: MIDI
//
// Standard MIDI protocol constants. These are fixed by the MIDI 1.0 spec
// and should never change.
// ---------------------------------------------------------------------------

export const MIDI = {
  /** [SP] MIDI timing clock pulses per quarter note (MIDI 1.0 standard). */
  CLOCKS_PER_QUARTER_NOTE: 24,

  /** [SP] Default tempo when no Link peers are connected. */
  DEFAULT_TEMPO_BPM: 120,

  /** [SP] Link state poll interval in ms (20Hz update rate). */
  LINK_POLL_INTERVAL_MS: 50,
} as const

// ---------------------------------------------------------------------------
// SECTION 9: TUNING
//
// Standard Western tuning constants. Fixed by convention (A440).
// ---------------------------------------------------------------------------

export const TUNING = {
  /** [SP] Concert pitch of A4 in Hz. International standard since 1955. */
  A4_FREQ_HZ: 440,

  /** [SP] MIDI note number for A4 (tuning reference). */
  A4_MIDI: 69,

  /** [SP] MIDI note number for middle C. Used as fallback for unparseable notes. */
  MIDDLE_C_MIDI: 60,

  /** [SP] Default octave when note name has no octave suffix (e.g., "c" → "c4"). */
  DEFAULT_OCTAVE: 4,
} as const

// ---------------------------------------------------------------------------
// SECTION 10: PARAMETER VALIDATION RANGES
//
// Desktop SP's synthinfo.rb declares validation rules per param:
//   v_positive(:amp)                 → min 0
//   v_between_inclusive(:pan, -1, 1) → min -1, max 1
//   v_positive(:cutoff), v_less_than(:cutoff, 131) → min 0, max 130
//   v_between_exclusive(:res, 0, 1) → min 0, max 1 (exclusive)
//
// These are used by SoundLayer.validateAndClamp() to clamp out-of-range
// values and emit warnings. Prevents silent weirdness from scsynth.
//
// REF: synthinfo.rb:289-327 validation helpers,
//      synthinfo.rb:363 amp, :379 pan, :455 cutoff, :523 res
// ---------------------------------------------------------------------------

/** Param range: [min, max]. null = unbounded in that direction. */
export type ParamRange = [number | null, number | null]

/**
 * Universal param validation ranges — from synthinfo.rb.
 * Applied to synths, samples, and FX params before sending to scsynth.
 * Only the most common params are listed; unlisted params pass through unclamped.
 */
export const PARAM_RANGES: Record<string, ParamRange> = {
  // Amplitude & panning
  amp:              [0, null],     // v_positive(:amp) — no upper clamp (compression handles it)
  pan:              [-1, 1],       // v_between_inclusive(:pan, -1, 1)
  pre_amp:          [0, null],     // v_positive(:pre_amp)

  // ADSR envelope
  attack:           [0, null],     // v_positive(:attack)
  decay:            [0, null],     // v_positive(:decay)
  sustain:          [0, null],     // v_positive(:sustain)
  release:          [0, null],     // v_positive(:release)
  attack_level:     [0, null],     // v_positive(:attack_level)
  decay_level:      [0, null],     // v_positive(:decay_level)
  sustain_level:    [0, null],     // v_positive(:sustain_level)

  // Filters
  cutoff:           [0, 130],      // v_positive(:cutoff), v_less_than(:cutoff, 131)
  lpf:              [0, 130],      // same as cutoff (alias)
  hpf:              [0, 130],      // same range
  res:              [0, 1],        // v_positive(:res), v_less_than(:res, 1)

  // FX
  mix:              [0, 1],        // v_between_inclusive(:mix, 0, 1)
  pre_mix:          [0, 1],        // v_between_inclusive(:pre_mix, 0, 1)
  room:             [0, 1],        // v_between_inclusive(:room, 0, 1)
  damp:             [0, 1],        // v_between_inclusive(:damp, 0, 1)

  // Modulation
  mod_phase_offset: [0, 1],        // v_between_inclusive(:mod_phase_offset, 0, 1)
  pulse_width:      [0, 1],        // v_between_exclusive(:pulse_width, 0, 1)
  dpulse_width:     [0, 1],        // v_between_exclusive(:dpulse_width, 0, 1)
  mod_pulse_width:  [0, 1],        // v_between_exclusive(:mod_pulse_width, 0, 1)

  // Timing (pre-BPM-scaling, so in beats)
  phase:            [0, null],     // v_positive(:phase)
  mod_phase:        [0, null],     // v_positive(:mod_phase)

  // Sample playback
  rate:             [null, null],  // no range (negative = reverse)
  start:            [0, 1],        // v_between_inclusive(:start, 0, 1)
  finish:           [0, 1],        // v_between_inclusive(:finish, 0, 1)

  // Slide times
  amp_slide:        [0, null],     // v_positive(:amp_slide)
  pan_slide:        [0, null],     // v_positive(:pan_slide)
  cutoff_slide:     [0, null],     // v_positive(:cutoff_slide)

  // Piano/pluck specific
  vel:              [0, 1],        // v_between_inclusive(:vel, 0, 1)
  hard:             [0, 1],        // v_between_inclusive(:hard, 0, 1)
  stereo_width:     [0, 1],        // v_between_inclusive(:stereo_width, 0, 1)
  coef:             [-1, 1],       // v_between_inclusive(:coef, -1, 1)
} as const

// ---------------------------------------------------------------------------
// SECTION 11: VISUAL / UI
//
// Constants for the sound event stream visualization (not audio behavior).
// ---------------------------------------------------------------------------

export const VISUAL = {
  /** [SP] Visual duration for synth note events in the event stream (seconds). */
  NOTE_EVENT_DURATION: 0.25,

  /** [SP] Visual duration for sample events in the event stream (seconds). */
  SAMPLE_EVENT_DURATION: 0.5,
} as const
