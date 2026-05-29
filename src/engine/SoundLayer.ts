import { PARAM_RANGES } from './config'

/**
 * SoundLayer — parameter normalization pipeline.
 *
 * Mirrors Sonic Pi's sound.rb (4000+ lines). All parameter transforms
 * consolidated here: symbol resolution, default injection, aliasing,
 * synth-specific munging, BPM time scaling.
 *
 * Pipeline order (matches sound.rb):
 *   1. Strip non-scsynth params (on:)
 *   2. Resolve symbol references (decay_level: :sustain_level)
 *   3. Inject mandatory defaults (env_curve: 2)
 *   4. Alias param names (cutoff → lpf for samples/sc808)
 *   5. Synth-specific munging (tb303 envelope mirroring)
 *   6. BPM time scaling (LAST — after all values are final)
 *
 * SuperSonicBridge is pure OSC transport. This module owns all transforms.
 */

// ---------------------------------------------------------------------------
// Synth name aliases — matches Desktop SP synthinfo.rb class mapping.
// These names don't have their own compiled synthdef; they reuse another.
// ---------------------------------------------------------------------------

const SYNTH_NAME_ALIASES: Record<string, string> = {
  sine: 'beep',       // synthinfo.rb:9614 — :sine => Beep.new
  mod_beep: 'mod_sine', // synthinfo.rb — :mod_beep => ModSine.new
}

/** Resolve synth name aliases. e.g., :sine → :beep (same synthdef). */
export function resolveSynthName(name: string): string {
  return SYNTH_NAME_ALIASES[name] ?? name
}

// ---------------------------------------------------------------------------
// Time params — ALLOWLIST (only these get BPM-scaled)
// ---------------------------------------------------------------------------

/**
 * Named time params — explicit durations that get BPM-scaled.
 * All `*_slide` params are ALSO BPM-scaled (they represent glide time) —
 * handled by suffix match in scaleTimeParamsToBpm, not listed here.
 */
const TIME_PARAMS = new Set([
  // ADSR envelope
  'attack', 'decay', 'sustain', 'release',
  // tb303 filter envelope
  'cutoff_attack', 'cutoff_decay', 'cutoff_sustain', 'cutoff_release',
  // FX time params — tagged :bpm_scale => true in Sonic Pi's synthinfo.rb.
  // echo/delay/ping_pong: phase, max_phase
  // slicer/wobble/tremolo/panslicer/ixi_techno/flanger: phase
  // flanger: delay
  'phase', 'max_phase',
  'pre_delay',
  'delay',
  // Mod synths: modulation rate (mod_saw, mod_tri, mod_pulse, etc.)
  'mod_phase',
])

// ---------------------------------------------------------------------------
// FX time-param defaults — from synthinfo.rb
// ---------------------------------------------------------------------------

/**
 * Desktop Sonic Pi injects synthinfo.rb defaults for FX params before BPM
 * scaling. Without this, scsynth uses compiled defaults (in seconds, not beats).
 *
 * Only BPM-scaled time params need injection — non-time params (room, mix, etc.)
 * use the same value whether interpreted as beats or seconds at 60 BPM.
 *
 * Source: synthinfo.rb FXEcho, FXSlicer, FXWobble, FXPanSlicer, FXIXITechno,
 *         FXFlanger, FXTremolo, FXPingPong, FXChorus classes.
 *
 * Note: FXChorus `phase` is :bpm_scale => false — intentionally excluded.
 */
const FX_TIME_DEFAULTS: Record<string, Record<string, number>> = {
  echo:       { phase: 0.25, decay: 2,       max_phase: 2 },
  delay:      { phase: 0.25, decay: 2,       max_phase: 2 }, // same as echo — synthinfo.rb FXDelay
  slicer:     { phase: 0.25 },
  wobble:     { phase: 0.5 },
  panslicer:  { phase: 0.25 },
  ixi_techno: { phase: 4 },
  flanger:    { phase: 4 },
  tremolo:    { phase: 4 },
  ping_pong:  { phase: 0.25, max_phase: 1 },
  chorus:     { decay: 0.00001, max_phase: 1 },
}

// ---------------------------------------------------------------------------
// Synth time-param defaults — from synthinfo.rb (force_add behavior)
// ---------------------------------------------------------------------------

/**
 * Desktop Sonic Pi's scale_time_args_to_bpm! uses force_add=true for synths:
 * for EVERY param tagged :bpm_scale => true, if not set by the user, the
 * synthinfo.rb default is injected AND scaled. Without this, scsynth uses
 * compiled defaults (in seconds). At 130 BPM, release:1 (beat) should become
 * 0.46s but scsynth uses 1.0s — notes ring 2.17x too long.
 *
 * Only NON-ZERO defaults need injection (0 × factor = 0, a no-op).
 * Source: synthinfo.rb per-synth class default values. See issue #68.
 */

/** Base defaults — apply to all synths unless overridden below. */
const SYNTH_TIME_DEFAULTS_BASE: Record<string, number> = {
  release: 1,
}

/** Per-synth overrides for non-standard ADSR/time defaults. */
const SYNTH_TIME_DEFAULTS_OVERRIDE: Record<string, Record<string, number>> = {
  dark_sea_horn:    { attack: 1, release: 4 },
  growl:            { attack: 0.1, release: 1 },
  hoover:           { attack: 0.05, release: 1 },
  rhodey:           { attack: 0.001, decay: 1, release: 1 },
  organ_tonewheel:  { attack: 0.01, sustain: 1, release: 0.01 },
  gabberkick:       { attack: 0.001, decay: 0.01, sustain: 0.3, release: 0.02 },
  singer:           { attack: 1, release: 4 },
  kalimba:          { sustain: 4, release: 1 },
  rodeo:            { decay: 1, sustain: 0.8, release: 1 },
  zawa:             { phase: 1, release: 1 },
  synth_violin:     { release: 1 },
  piano:            { release: 1 },
  pluck:            { release: 1 },
  pretty_bell:      { release: 1 },
  winwood_lead:     { release: 1 },
  // Mod synths: mod_phase needs injection at non-60 BPM
  mod_saw:          { release: 1, mod_phase: 0.25 },
  mod_dsaw:         { release: 1, mod_phase: 0.25 },
  mod_sine:         { release: 1, mod_phase: 0.25 },
  mod_beep:         { release: 1, mod_phase: 0.25 },
  mod_tri:          { release: 1, mod_phase: 0.25 },
  mod_pulse:        { release: 1, mod_phase: 0.25 },
  mod_fm:           { release: 1, mod_phase: 0.25 },
  // SC808 drums — each has unique decay default (no release, decay controls length)
  sc808_bassdrum:   { decay: 2 },
  sc808_snare:      { decay: 4.2 },
  sc808_clap:       {},  // no non-zero time defaults
  sc808_open_hihat: { decay: 0.5 },
  sc808_closed_hihat: { decay: 0.42 },
  sc808_cowbell:    { decay: 9.5 },
  sc808_tom_lo:     { decay: 4 },
  sc808_tom_mid:    { decay: 16 },
  sc808_tom_hi:     { decay: 11 },
  sc808_maracas:    { decay: 0.1 },
  sc808_claves:     { decay: 0.1 },
  sc808_rimshot:    { decay: 0.07 },
  sc808_open_cymbal: { decay: 2 },
  sc808_conga_lo:   { decay: 18 },
  sc808_conga_mid:  { decay: 9 },
  sc808_conga_hi:   { decay: 6 },
}

// ---------------------------------------------------------------------------
// Symbol defaults — resolve cross-parameter references
// ---------------------------------------------------------------------------

/**
 * Sonic Pi's synthinfo.rb declares symbolic defaults like:
 *   decay_level: :sustain_level
 * Meaning: if user doesn't set decay_level, use sustain_level's value.
 *
 * This applies to ALL synths with ADSR envelopes (37+).
 * Without resolution, decay_level uses the compiled default (1.0)
 * even when sustain_level is 0.5 — creating a wrong envelope shape.
 */
const SYMBOL_DEFAULTS: Array<[string, string]> = [
  ['decay_level', 'sustain_level'],
]

// ---------------------------------------------------------------------------
// Non-scsynth params to strip
// ---------------------------------------------------------------------------

/** Params that Sonic Pi uses internally but scsynth doesn't recognize. */
const STRIP_PARAMS = new Set([
  'on',           // conditional trigger flag — should_trigger? mutates args_h
  'slide',        // global slide propagation (expanded before stripping)
  'duration',     // converted to sustain by calculateSustain before stripping
  'beat_stretch', // handled by translateSampleOpts before this stage
  'pitch_stretch',
  'rpitch',
  '_argBpmScaling', // use_arg_bpm_scaling flag — consumed by normalize, not sent to scsynth
  'reps',          // with_fx repeat count — consumed by AudioInterpreter
  'kill_delay',    // with_fx kill delay — consumed by AudioInterpreter
])

/** All individual slide params that `slide:` expands to. */
const SLIDE_PARAMS = [
  'amp_slide', 'pan_slide', 'cutoff_slide', 'lpf_slide', 'hpf_slide',
  'res_slide', 'note_slide', 'pitch_slide',
  'attack_slide', 'decay_slide', 'sustain_slide', 'release_slide',
]

// ---------------------------------------------------------------------------
// Synth-specific aliases (munge_opts)
// ---------------------------------------------------------------------------

/** Per-synth parameter aliasing — matches Sonic Pi's munge_opts per synthinfo class. */
const SYNTH_ALIASES: Record<string, Array<[string, string]>> = {
  sc808_snare: [['cutoff', 'lpf']],
  sc808_clap: [['cutoff', 'lpf']],
  dpulse: [['dpulse_width', 'pulse_width']],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize synth params for play().
 * Full pipeline: sustain → slide → strip → resolve → inject defaults → alias → munge → BPM scale.
 *
 * Desktop Sonic Pi's scale_time_args_to_bpm! with force_add=true injects
 * synthinfo.rb defaults for ALL bpm_scale params before scaling. Without this,
 * scsynth uses compiled defaults (in seconds). See issue #68.
 */
export function normalizePlayParams(
  synthName: string,
  params: Record<string, number>,
  bpm: number,
  warnFn?: (msg: string) => void,
): Record<string, number> {
  const shouldScaleBpm = !('_argBpmScaling' in params && !params._argBpmScaling)
  let p = { ...params }
  p = calculateSustain(p)
  p = expandSlideParam(p)
  p = stripNonScynthParams(p)
  p = resolveSymbolDefaults(p)
  p = injectMandatoryDefaults(p)
  p = injectSynthTimeDefaults(synthName, p)
  p = aliasSynthParams(synthName, p)
  p = mungeSynthOpts(synthName, p)
  p = validateAndClamp(p, warnFn)
  if (shouldScaleBpm) p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize sample params.
 * Sample-specific transforms (beat_stretch, cutoff→lpf) + BPM scaling.
 * Called by SuperSonicBridge.playSample after translateSampleOpts.
 */
export function normalizeSampleParams(
  params: Record<string, number>,
  bpm: number,
  warnFn?: (msg: string) => void,
): Record<string, number> {
  const shouldScaleBpm = !('_argBpmScaling' in params && !params._argBpmScaling)
  let p = { ...params }
  p = calculateSustain(p)
  p = expandSlideParam(p)
  p = stripNonScynthParams(p)
  p = injectSampleDefaults(p)
  p = validateAndClamp(p, warnFn)
  if (shouldScaleBpm) p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize control message params.
 * Only strip + BPM scale. No symbol resolution (synth already running),
 * no defaults (already set at creation), no aliasing (already applied).
 */
export function normalizeControlParams(
  params: Record<string, number>,
  bpm: number,
  warnFn?: (msg: string) => void,
): Record<string, number> {
  const shouldScaleBpm = !('_argBpmScaling' in params && !params._argBpmScaling)
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = validateAndClamp(p, warnFn)
  if (shouldScaleBpm) p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize FX params.
 * Strip + inject time defaults + resolve symbols + BPM scale.
 *
 * Desktop Sonic Pi's trigger_fx merges synthinfo.rb defaults, then calls
 * normalise_and_resolve_synth_args which BPM-scales params tagged
 * :bpm_scale => true. Without default injection, scsynth uses compiled
 * defaults (in seconds) for missing params — these won't be BPM-scaled.
 *
 * Example: `with_fx :echo, mix: 0.2` at 130 BPM.
 *   Desktop: injects phase=0.25 (beats) → scales to 0.115s → sends explicitly
 *   Without injection: scsynth uses compiled phase=0.25 (seconds) → 2.17x too slow
 *
 * See issues #66, #67.
 */
export function normalizeFxParams(
  fxName: string,
  params: Record<string, number>,
  bpm: number,
  warnFn?: (msg: string) => void,
): Record<string, number> {
  const shouldScaleBpm = !('_argBpmScaling' in params && !params._argBpmScaling)
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = resolveSymbolDefaults(p)
  p = injectFxTimeDefaults(fxName, p)
  p = validateAndClamp(p, warnFn)
  if (shouldScaleBpm) p = scaleTimeParamsToBpm(p, bpm)
  return p
}

// ---------------------------------------------------------------------------
// Internal pipeline steps
// ---------------------------------------------------------------------------

/**
 * Step 0: Calculate sustain from duration: param.
 * Sonic Pi: `play 60, duration: 2` → sustain = duration - attack - decay - release.
 * Only applies if sustain is not explicitly set.
 */
function calculateSustain(params: Record<string, number>): Record<string, number> {
  if (!('duration' in params)) return params
  if ('sustain' in params) return params // explicit sustain wins

  const duration = params.duration
  const attack = params.attack ?? 0
  const decay = params.decay ?? 0
  const release = params.release ?? 1 // Sonic Pi default release is 1
  const sustain = Math.max(0, duration - attack - decay - release)

  const p = { ...params }
  p.sustain = sustain
  return p
}

/**
 * Step 0.5: Expand `slide:` to individual `*_slide` params.
 * Sonic Pi: `play 60, slide: 0.5` sets all *_slide params to 0.5
 * unless explicitly overridden. Then `slide:` itself is stripped.
 */
function expandSlideParam(params: Record<string, number>): Record<string, number> {
  if (!('slide' in params)) return params
  const slideValue = params.slide
  const p = { ...params }
  for (const key of SLIDE_PARAMS) {
    if (!(key in p)) p[key] = slideValue
  }
  return p
}

/** Step 1: Remove params that scsynth doesn't recognize. */
function stripNonScynthParams(params: Record<string, number>): Record<string, number> {
  for (const key of STRIP_PARAMS) {
    if (key in params) {
      const p = { ...params }
      for (const k of STRIP_PARAMS) delete p[k]
      return p
    }
  }
  return params
}

/**
 * Step 2: Resolve symbolic defaults.
 * decay_level: :sustain_level → if sustain_level is set and decay_level isn't,
 * copy sustain_level's value to decay_level.
 */
function resolveSymbolDefaults(params: Record<string, number>): Record<string, number> {
  let p = params
  for (const [param, targetParam] of SYMBOL_DEFAULTS) {
    if (!(param in p) && targetParam in p) {
      if (p === params) p = { ...params }
      p[param] = p[targetParam]
    }
  }
  return p
}

/**
 * Step 3: Inject mandatory defaults that differ from compiled synthdef defaults.
 * env_curve: compiled default is 1 (linear), Sonic Pi sends 2 (exponential).
 */
function injectMandatoryDefaults(params: Record<string, number>): Record<string, number> {
  // SP22 fix: Do NOT inject env_curve: 2 (exponential envelope).
  // SuperSonic's WASM scsynth produces zero audio when env_curve: 2 is sent with
  // overlapping synth nodes. The compiled default (env_curve: 1, linear) works.
  // This is a minor timbre difference from Desktop Sonic Pi (which uses exponential).
  // Filed upstream — remove this workaround when SuperSonic fixes env_curve: 2.
  return params
}

/**
 * Step 3 (synths): Inject synthinfo.rb default values for BPM-scaled time params.
 * Mirrors desktop's scale_time_args_to_bpm! with force_add=true.
 * Only non-zero defaults need injection (0 × factor = 0).
 * See issue #68.
 */
function injectSynthTimeDefaults(
  synthName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = synthName.replace(/^sonic-pi-/, '')
  // Per-synth override replaces base entirely (e.g., gabberkick release=0.02, not 1).
  // If no override exists, use base defaults (release:1 for most synths).
  const defaults = SYNTH_TIME_DEFAULTS_OVERRIDE[name] ?? SYNTH_TIME_DEFAULTS_BASE

  let p = params
  for (const [key, val] of Object.entries(defaults)) {
    if (!(key in p)) {
      if (p === params) p = { ...params }
      p[key] = val
    }
  }
  return p
}

/**
 * Step 3 (FX): Inject synthinfo.rb default values for BPM-scaled time params.
 * Only injects if the user didn't set the param explicitly.
 * Without this, scsynth uses compiled defaults (in seconds, not beats) and
 * the BPM scaling step never sees the param. See issue #67.
 */
function injectFxTimeDefaults(
  fxName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = fxName.replace(/^(sonic-pi-)?fx_/, '')
  const defaults = FX_TIME_DEFAULTS[name]
  if (!defaults) return params

  let p = params
  for (const [key, val] of Object.entries(defaults)) {
    if (!(key in p)) {
      if (p === params) p = { ...params }
      p[key] = val
    }
  }
  return p
}

/** Step 3 (samples): Inject env_curve for stereo_player (envelope player). */
function injectSampleDefaults(params: Record<string, number>): Record<string, number> {
  // basic_stereo_player has no envelope — env_curve not applicable.
  // stereo_player has an envelope — inject env_curve: 2 if not set.
  // We can't know the player here (selected later by bridge), so we inject
  // only if ADSR params are present (indicating stereo_player will be used).
  const hasEnvelope = 'attack' in params || 'decay' in params ||
    'sustain' in params || 'release' in params
  if (hasEnvelope) {
    const p = { ...params }
    // SP22: env_curve: 2 injection disabled — causes silence in WASM scsynth
    if (!('pre_amp' in p)) p.pre_amp = 1
    return p
  }
  return params
}

/** Step 4: Per-synth parameter aliasing (cutoff → lpf, etc.). */
function aliasSynthParams(
  synthName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = synthName.replace(/^sonic-pi-/, '')
  const aliases = SYNTH_ALIASES[name]
  if (!aliases) return params

  let p = params
  for (const [from, to] of aliases) {
    if (from in p && !(to in p)) {
      if (p === params) p = { ...params }
      p[to] = p[from]
      delete p[from]
    }
  }
  return p
}

/**
 * Step 5: Synth-specific munging.
 * tb303: mirror amplitude envelope → filter envelope.
 */
function mungeSynthOpts(
  synthName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = synthName.replace(/^sonic-pi-/, '')

  if (name === 'tb303') {
    const p = { ...params }
    // Mirror amplitude envelope → filter envelope (only if not explicitly set)
    if (p.attack != null && p.cutoff_attack == null) p.cutoff_attack = p.attack
    if (p.decay != null && p.cutoff_decay == null) p.cutoff_decay = p.decay
    if (p.sustain != null && p.cutoff_sustain == null) p.cutoff_sustain = p.sustain
    if (p.release != null && p.cutoff_release == null) p.cutoff_release = p.release
    // tb303 Sonic Pi default: cutoff_min 30
    if (p.cutoff_min == null) p.cutoff_min = 30
    return p
  }

  return params
}

/**
 * Step 5.5: Validate and clamp params to valid ranges.
 * Mirrors Desktop SP's validate_if_slider! — clamps out-of-range values
 * and emits warnings via the optional warnFn callback.
 * REF: synthinfo.rb:289-327 validation helpers
 */
function validateAndClamp(
  params: Record<string, number>,
  warnFn?: (msg: string) => void,
): Record<string, number> {
  let p = params
  for (const key of Object.keys(params)) {
    const range = PARAM_RANGES[key as keyof typeof PARAM_RANGES]
    if (!range) continue
    const [min, max] = range
    const val = p[key]
    // Negative time param values are sentinels (e.g., sustain: -1 = "play full duration").
    // Don't clamp sentinels — scsynth interprets them specially.
    // Only TIME_PARAMS use negative sentinels; other params (amp, pan, etc.) should clamp.
    if (val < 0 && TIME_PARAMS.has(key)) continue
    if (min !== null && val < min) {
      if (p === params) p = { ...params }
      p[key] = min
      warnFn?.(`${key}: ${val} clamped to ${min} (min)`)
    } else if (max !== null && val > max) {
      if (p === params) p = { ...params }
      p[key] = max
      warnFn?.(`${key}: ${val} clamped to ${max} (max)`)
    }
  }
  return p
}

/**
 * Step 6: Scale time-based params by 60/BPM.
 * At BPM 130, release:1 (1 beat) becomes 0.4615 seconds.
 *
 * Two matching rules (mirrors desktop Sonic Pi's synthinfo.rb :bpm_scale tags):
 *   1. Named params in TIME_PARAMS (attack, decay, phase, max_phase, delay, etc.)
 *   2. ANY param ending in `_slide` — all slide params represent glide TIME.
 *      Desktop Sonic Pi tags every *_slide param with :bpm_scale => true.
 *
 * Applies to synths, samples, control messages, AND FX.
 */
function scaleTimeParamsToBpm(
  params: Record<string, number>,
  bpm: number,
): Record<string, number> {
  if (bpm === 60) return params // identity — no scaling needed

  const factor = 60 / bpm
  let p = params
  for (const key of Object.keys(params)) {
    if (TIME_PARAMS.has(key) || key.endsWith('_slide')) {
      // Guard: negative values are sentinels (e.g., sustain: -1 = "play full duration").
      // Don't scale sentinels — synthdef interprets them specially.
      if (p[key] < 0) continue
      if (p === params) p = { ...params }
      p[key] = p[key] * factor
    }
  }
  return p
}

// ---------------------------------------------------------------------------
// Sample opt translation — moved from SuperSonicBridge
// ---------------------------------------------------------------------------

/**
 * Translate Sonic Pi sample opts to scsynth params.
 *
 * Sonic Pi → scsynth mappings:
 * - beat_stretch: N → rate = (1/N) * existing_rate * (bpm / (60 / duration))
 * - pitch_stretch: N → same rate as beat_stretch + pitch compensation
 * - rpitch: N → pitch shift in semitones (rate = 2^(N/12))
 * - cutoff → lpf (sample players use lpf, not cutoff)
 * - cutoff_slide → lpf_slide
 * - Everything else passes through.
 */
export function translateSampleOpts(
  opts: Record<string, number> | undefined,
  bpm: number,
  sampleDuration: number | null
): Record<string, number> {
  if (!opts) return {}

  const result: Record<string, number> = {}

  for (const [key, value] of Object.entries(opts)) {
    switch (key) {
      case 'beat_stretch': {
        const existingRate = result['rate'] ?? 1
        if (sampleDuration !== null) {
          result['rate'] = (1.0 / value) * existingRate * (bpm / (60.0 / sampleDuration))
        } else {
          result['rate'] = existingRate / value
        }
        break
      }

      case 'pitch_stretch': {
        const existingRate = result['rate'] ?? 1
        const existingPitch = result['pitch'] ?? 0
        if (sampleDuration !== null) {
          const newRate = (1.0 / value) * (bpm / (60.0 / sampleDuration))
          const pitchShift = 12 * Math.log2(newRate)
          result['rate'] = newRate * existingRate
          result['pitch'] = existingPitch - pitchShift
        } else {
          result['rate'] = existingRate / value
        }
        break
      }

      case 'rpitch':
        result['rate'] = (result['rate'] ?? 1) * Math.pow(2, value / 12)
        break

      // Sonic Pi aliases: sample players use 'lpf'/'hpf', not 'cutoff'
      case 'cutoff':
        result['lpf'] = value
        break
      case 'cutoff_slide':
        result['lpf_slide'] = value
        break

      default:
        result[key] = value
        break
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Sample player selection
// ---------------------------------------------------------------------------

/**
 * Simple sampler args — from Desktop SP sound.rb:75 @simple_sampler_args.
 * If ALL user opts are in this set → basic_stereo_player.
 * If ANY opt is NOT in this set → stereo_player (supports pitch, start/finish, compress, etc.)
 *
 * This matches Desktop SP's logic: default to basic, upgrade to complex only when needed.
 * REF: sound.rb:75 @simple_sampler_args, sound.rb:3462 complex_sampler_args?
 */
const SIMPLE_SAMPLER_ARGS = new Set([
  'amp', 'amp_slide', 'amp_slide_shape', 'amp_slide_curve',
  'pan', 'pan_slide', 'pan_slide_shape', 'pan_slide_curve',
  'cutoff', 'cutoff_slide', 'cutoff_slide_shape', 'cutoff_slide_curve',
  'lpf', 'lpf_slide', 'lpf_slide_shape', 'lpf_slide_curve',
  'hpf', 'hpf_slide', 'hpf_slide_shape', 'hpf_slide_curve',
  'rate', 'slide', 'beat_stretch', 'rpitch',
  'attack', 'decay', 'sustain', 'release',
  'attack_level', 'decay_level', 'sustain_level', 'env_curve',
  // Internal params (stripped before sending to scsynth)
  'on', 'duration', 'pitch_stretch',
  // Our internal params
  '_srcLine', 'out_bus', '_argBpmScaling',
])

/**
 * Select the appropriate sample player synthdef.
 *
 * Mirrors Desktop SP's `resolve_specific_sampler(num_chans, args_h)`
 * (sound.rb:3470-3478) — TWO independent axes:
 *   - opt complexity (complex_sampler_args?, sound.rb:3462): basic vs envelope player
 *   - sample channel count: mono (1-ch) vs stereo (2-ch) player
 *
 *       num_chans == 1                 num_chans == 2 (default)
 *   ┌─────────────────────────────┬──────────────────────────────┐
 *   simple │ basic_mono_player     │ basic_stereo_player          │
 *   complex│ mono_player           │ stereo_player                │
 *   └─────────────────────────────┴──────────────────────────────┘
 *
 * A mono sample MUST use a mono player: the mono players Pan2-center the
 * 1-channel buffer to both output channels, whereas basic_stereo_player
 * reads a 2-channel buffer and leaves the right channel silent for a mono
 * buffer (SP107 / #414 — mono samples played left-channel-only on web).
 *
 * numChans defaults to 2 (stereo) so a caller that doesn't yet know the
 * channel count falls back to today's behavior (no regression).
 * REF: sound.rb:3470-3478 resolve_specific_sampler, :3462 complex_sampler_args?,
 * :3498 buf_info.num_chans. synthinfo.rb:5013/5031 — mono/stereo players share
 * identical arg signatures (inheritance), so this is a pure synthdef-name swap.
 */
export function selectSamplePlayer(
  opts?: Record<string, number>,
  numChans: number = 2,
): string {
  const complex = opts !== undefined &&
    Object.keys(opts).some((key) => !SIMPLE_SAMPLER_ARGS.has(key))
  if (complex) {
    return numChans === 1 ? 'sonic-pi-mono_player' : 'sonic-pi-stereo_player'
  }
  return numChans === 1 ? 'sonic-pi-basic_mono_player' : 'sonic-pi-basic_stereo_player'
}
