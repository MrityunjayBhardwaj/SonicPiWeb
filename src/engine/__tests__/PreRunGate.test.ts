import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

/**
 * #318.3 / #323 — pre-Run component preflight gate (integration:
 * engine + real SuperSonicBridge + mock scsynth). Verifies a
 * genuinely-missing statically-named component refuses Run with a
 * clear message, custom (user_) samples are exempt, and the no-op
 * cases don't regress.
 */

function mockSuperSonic(failSynthDefs: Set<string>, failSamples: Set<string>) {
  const mockSonic = {
    init: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    sendOSC: vi.fn(),
    loadSynthDef: vi.fn((full: string) =>
      failSynthDefs.has(full) ? Promise.reject(new Error('CORS/404')) : Promise.resolve(undefined),
    ),
    loadSynthDefs: vi.fn().mockResolvedValue(undefined),
    loadSample: vi.fn((_b: number, path: string) =>
      failSamples.has(path) ? Promise.reject(new Error('CORS/404')) : Promise.resolve(undefined),
    ),
    sync: vi.fn().mockResolvedValue(undefined),
    nextNodeId: (() => { let i = 1000; return vi.fn(() => i++) })(),
    destroy: vi.fn(),
    node: { connect: vi.fn() },
    audioContext: {
      currentTime: 0,
      sampleRate: 44100,
      destination: { connect: vi.fn() },
      createAnalyser: vi.fn(() => ({ fftSize: 2048, smoothingTimeConstant: 0.8, connect: vi.fn(), disconnect: vi.fn() })),
      createChannelSplitter: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      createChannelMerger: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      createGain: vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() })),
    },
  }
  ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
  return mockSonic
}

describe('pre-Run component gate (#318.3 / #323)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('refuses Run with a clear message when a statically-named synth cannot load', async () => {
    // `hollow` is not in COMMON_SYNTHDEFS → slow path → loadSynthDef called.
    mockSuperSonic(new Set(['sonic-pi-hollow']), new Set())
    const engine = new SonicPiEngine()
    await engine.init()

    const r = await engine.evaluate('use_synth :hollow\nplay 60')
    expect(r.error).toBeDefined()
    expect(r.error!.message).toBe('Couldn\'t load: :hollow')
    engine.dispose()
  })

  it('refuses Run when a built-in sample 404s, listing it', async () => {
    mockSuperSonic(new Set(), new Set(['bd_typo.flac']))
    const engine = new SonicPiEngine()
    await engine.init()

    const r = await engine.evaluate('sample :bd_typo')
    expect(r.error?.message).toBe('Couldn\'t load: :bd_typo')
    engine.dispose()
  })

  it('does NOT block on a failed user_ custom sample (exempt — may register late)', async () => {
    mockSuperSonic(new Set(), new Set(['user_kick.flac']))
    const engine = new SonicPiEngine()
    await engine.init()

    const r = await engine.evaluate('sample :user_kick')
    expect(r.error).toBeUndefined() // warning, not a hard miss
    engine.dispose()
  })

  it('proceeds normally when every statically-named component resolves', async () => {
    mockSuperSonic(new Set(), new Set())
    const engine = new SonicPiEngine()
    await engine.init()

    const r = await engine.evaluate('use_synth :saw\nsample :bd_haus\nplay 60')
    expect(r.error).toBeUndefined()
    engine.dispose()
  })

  it('a commented-out missing name does not block (scanner strips comments)', async () => {
    mockSuperSonic(new Set(['sonic-pi-hollow']), new Set())
    const engine = new SonicPiEngine()
    await engine.init()

    const r = await engine.evaluate('# use_synth :hollow\nplay 60')
    expect(r.error).toBeUndefined()
    engine.dispose()
  })
})
