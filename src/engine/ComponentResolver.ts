/**
 * Component resolver — drives the loaders for a ComponentManifest and
 * partitions the failures. Child #318.2 / #322 of the pre-Run preflight
 * EPIC (#318).
 *
 * This is the inverse of `SuperSonicBridge.preloadFxSynthDefs`'s empty
 * `.catch(() => {})` (SP84): failures are *collected*, not swallowed, so
 * #318.3 (#323) can block Run and surface them.
 *
 * Decoupled from the bridge by design: it takes injected loaders, so it
 * is pure-testable without a DOM / audio context / real scsynth. #323
 * wires the actual `ensureSampleLoaded` / `ensureSynthDefLoaded` calls.
 *
 * HARD CONSTRAINT (EPIC #318): a `user_`-prefixed sample is a custom
 * sample (the `CustomSampleStore` convention) — the host may
 * `registerCustomSample` around or after Run ("late registration"). A
 * failed custom-sample load is therefore a non-blocking *warning*, never
 * a hard miss. This is the false-block guard that makes the block-Run
 * decision viable; it is not optional. The exemption is scoped to
 * samples only — there is no custom-FX / custom-synth registration path.
 */

import type { ComponentManifest } from './ComponentManifest'

export interface ResolveResult {
  /** Names that must block Run (#318.3 surfaces these). */
  hardMisses: string[]
  /** Non-blocking — custom samples that may still arrive via registerCustomSample. */
  warnings: string[]
}

/** Resolves if the component is available, rejects otherwise. */
export type ComponentLoader = (name: string) => Promise<unknown>

export interface ComponentLoaders {
  sample: ComponentLoader
  fx: ComponentLoader
  synth: ComponentLoader
}

/**
 * `user_`-prefixed = custom sample (`CustomSampleStore` convention, see
 * CustomSampleStore.ts). A failed load is exempt from hard-blocking
 * because the host may register it late.
 */
export function isCustomSampleName(name: string): boolean {
  return name.startsWith('user_')
}

/**
 * Drive every loader for the manifest, collecting failures. A failed
 * custom sample (`user_*`) → `warnings`; every other failure →
 * `hardMisses`. Successes produce nothing. Output is sorted for stable
 * messages and deterministic tests.
 */
export async function resolveComponentManifest(
  manifest: ComponentManifest,
  loaders: ComponentLoaders,
): Promise<ResolveResult> {
  const hardMisses: string[] = []
  const warnings: string[] = []

  const settle = async (
    name: string,
    loader: ComponentLoader,
    kind: 'sample' | 'fx' | 'synth',
  ): Promise<void> => {
    try {
      await loader(name)
    } catch {
      if (kind === 'sample' && isCustomSampleName(name)) {
        warnings.push(name)
      } else {
        hardMisses.push(name)
      }
    }
  }

  await Promise.all([
    ...[...manifest.samples].map((n) => settle(n, loaders.sample, 'sample')),
    ...[...manifest.fx].map((n) => settle(n, loaders.fx, 'fx')),
    ...[...manifest.synths].map((n) => settle(n, loaders.synth, 'synth')),
  ])

  hardMisses.sort()
  warnings.sort()
  return { hardMisses, warnings }
}
