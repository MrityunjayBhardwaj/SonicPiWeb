/**
 * Canonical list of FX synthdef names available in Sonic Pi Web.
 *
 * Sourced from synthinfo.rb FX classes (desktop Sonic Pi). Each entry maps to
 * a `sonic-pi-fx_<name>.scsyndef` binary on the SuperSonic CDN. Loaded on demand
 * via `SuperSonicBridge.ensureSynthDefLoaded`, or in bulk via
 * `SuperSonicBridge.preloadFxSynthDefs` (called from engine.init for warm start).
 *
 * Single source of truth — consumed by the DSL `fx_names` introspector
 * (`SonicPiEngine.ts:fx_names_fn`) AND the bridge preloader. Adding an FX here
 * makes it both queryable AND eagerly loaded on engine init.
 */
export const ALL_FX_NAMES: readonly string[] = [
  'reverb','echo','delay','distortion','slicer','wobble','ixi_techno',
  'compressor','rlpf','rhpf','hpf','lpf','normaliser','pan','band_eq',
  'flanger','krush','bitcrusher','ring_mod','chorus','octaver','vowel',
  'tanh','gverb','pitch_shift','whammy','tremolo','level','mono',
  'ping_pong','panslicer',
  // Filter variants — from synthinfo.rb FX classes
  'bpf','rbpf','nbpf','nrbpf','nlpf','nrlpf','nhpf','nrhpf','eq',
] as const
