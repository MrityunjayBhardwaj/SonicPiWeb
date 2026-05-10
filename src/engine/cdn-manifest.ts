/**
 * CDN Dependency Manifest
 *
 * All external dependencies loaded at runtime from CDN.
 * Versions are pinned for reproducibility and supply-chain safety.
 *
 * IMPORTANT: dynamic import() does not support Subresource Integrity (SRI)
 * attributes. There is no way to pass an `integrity` hash to the browser's
 * module loader for dynamically imported ESM. The fetch-then-blob-URL
 * workaround breaks CORS and CSP in many configurations.
 *
 * For maximum security in production, bundle these dependencies locally
 * instead of loading them from CDN.
 *
 * Package                       Version   CDN       Used in
 * ----------------------------  --------  --------  ---------
 * @codemirror/view              6.36.5    esm.sh    Editor.ts
 * @codemirror/state             6.5.2     esm.sh    Editor.ts
 * @codemirror/commands          6         esm.sh    Editor.ts
 * @codemirror/language          6.10.8    esm.sh    Editor.ts
 * @codemirror/autocomplete      6         esm.sh    Editor.ts
 * @lezer/highlight              1.2.1     esm.sh    Editor.ts
 * codemirror                    6.0.1     esm.sh    Editor.ts
 * supersonic-scsynth            0.57.0    unpkg     SuperSonicBridge.ts, App.ts, Preloader.ts
 * supersonic-scsynth-core       0.57.0    unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-samples    0.57.0    unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-synthdefs  0.57.0    unpkg     SuperSonicBridge.ts
 *
 * SV22 (Sonic Pi Web invariant): the four supersonic-scsynth-* packages
 * MUST be pinned to the same version. The JS module's exported worker /
 * WASM URLs hard-reference the matching core/samples/synthdefs versions;
 * mixing versions produces silent failures (worker fails to load,
 * synthdef binary mismatches, etc.).
 *
 * Bumping the SuperSonic version: change the four `0.57.0` strings
 * everywhere (this file + SuperSonicBridge.ts:131,212,213,219 +
 * App.ts:958 + Preloader.ts:198), run the FX-parity sweep, then update.
 * Do NOT bump SuperSonic in isolation — re-run the full audio comparator
 * because each WASM bump can shift gain staging and FX behaviour.
 */

export const SUPERSONIC_VERSION = '0.57.0' as const

export const CDN_DEPENDENCIES = {
  '@codemirror/view': {
    version: '6.36.5',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/view@6.36.5',
  },
  '@codemirror/state': {
    version: '6.5.2',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/state@6.5.2',
  },
  'codemirror': {
    version: '6.0.1',
    cdn: 'esm.sh',
    url: 'https://esm.sh/codemirror@6.0.1',
  },
  '@codemirror/language': {
    version: '6.10.8',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/language@6.10.8',
  },
  '@lezer/highlight': {
    version: '1.2.1',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@lezer/highlight@1.2.1',
  },
  'supersonic-scsynth': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth@${SUPERSONIC_VERSION}/dist/`,
  },
  'supersonic-scsynth-core': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-core@${SUPERSONIC_VERSION}/`,
  },
  'supersonic-scsynth-samples': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-samples@${SUPERSONIC_VERSION}/samples/`,
  },
  'supersonic-scsynth-synthdefs': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-synthdefs@${SUPERSONIC_VERSION}/synthdefs/`,
  },
} as const
