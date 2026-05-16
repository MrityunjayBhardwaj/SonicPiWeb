import { describe, it, expect, vi } from 'vitest'
import {
  resolveComponentManifest,
  isCustomSampleName,
  type ComponentLoaders,
} from '../ComponentResolver'
import type { ComponentManifest } from '../ComponentManifest'

const manifest = (
  m: Partial<Record<keyof ComponentManifest, string[]>>,
): ComponentManifest => ({
  samples: new Set(m.samples ?? []),
  fx: new Set(m.fx ?? []),
  synths: new Set(m.synths ?? []),
})

/** Loaders that resolve unless the name is in `fail`. */
const loaders = (fail: Set<string>): ComponentLoaders => {
  const mk = () =>
    vi.fn((n: string) =>
      fail.has(n) ? Promise.reject(new Error('CORS/404')) : Promise.resolve(undefined),
    )
  return { sample: mk(), fx: mk(), synth: mk() }
}

describe('isCustomSampleName', () => {
  it('treats user_-prefixed names as custom (CustomSampleStore convention)', () => {
    expect(isCustomSampleName('user_kick')).toBe(true)
    expect(isCustomSampleName('bd_haus')).toBe(false)
  })
})

describe('resolveComponentManifest (#318.2 / #322)', () => {
  it('all components resolve → no misses, no warnings', async () => {
    const r = await resolveComponentManifest(
      manifest({ samples: ['bd_haus'], fx: ['reverb'], synths: ['beep'] }),
      loaders(new Set()),
    )
    expect(r).toEqual({ hardMisses: [], warnings: [] })
  })

  it('a failed built-in sample is a hard miss', async () => {
    const r = await resolveComponentManifest(
      manifest({ samples: ['bd_typo'] }),
      loaders(new Set(['bd_typo'])),
    )
    expect(r.hardMisses).toEqual(['bd_typo'])
    expect(r.warnings).toEqual([])
  })

  it('HARD CONSTRAINT: a failed user_ sample is a WARNING, never a hard miss', async () => {
    const r = await resolveComponentManifest(
      manifest({ samples: ['user_kick'] }),
      loaders(new Set(['user_kick'])),
    )
    expect(r.hardMisses).toEqual([])
    expect(r.warnings).toEqual(['user_kick'])
  })

  it('failed FX and synth are hard misses', async () => {
    const r = await resolveComponentManifest(
      manifest({ fx: ['nofx'], synths: ['nosynth'] }),
      loaders(new Set(['nofx', 'nosynth'])),
    )
    expect(r.hardMisses).toEqual(['nofx', 'nosynth'])
  })

  it('the user_ exemption is sample-only — a user_-named synth still hard-misses', async () => {
    const r = await resolveComponentManifest(
      manifest({ synths: ['user_synth'] }),
      loaders(new Set(['user_synth'])),
    )
    expect(r.hardMisses).toEqual(['user_synth'])
    expect(r.warnings).toEqual([])
  })

  it('partitions a mixed program correctly and sorts output deterministically', async () => {
    const r = await resolveComponentManifest(
      manifest({
        samples: ['bd_haus', 'zz_typo', 'user_late'],
        fx: ['reverb', 'aa_badfx'],
        synths: ['beep'],
      }),
      loaders(new Set(['zz_typo', 'user_late', 'aa_badfx'])),
    )
    expect(r.hardMisses).toEqual(['aa_badfx', 'zz_typo']) // sorted
    expect(r.warnings).toEqual(['user_late'])
  })

  it('an empty manifest resolves to an empty result', async () => {
    expect(await resolveComponentManifest(manifest({}), loaders(new Set()))).toEqual({
      hardMisses: [],
      warnings: [],
    })
  })

  it('drives every loader exactly once per referenced name', async () => {
    const l = loaders(new Set())
    await resolveComponentManifest(
      manifest({ samples: ['a'], fx: ['b'], synths: ['c'] }),
      l,
    )
    expect(l.sample).toHaveBeenCalledTimes(1)
    expect(l.fx).toHaveBeenCalledTimes(1)
    expect(l.synth).toHaveBeenCalledTimes(1)
  })
})
