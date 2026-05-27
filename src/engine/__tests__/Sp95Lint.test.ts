/**
 * Sp95Lint — pattern detector tests.
 *
 * Three positive patterns, plus the critical negative cases. False positives
 * on these would erode trust in the lint and warn users about idioms that
 * actually work — strictly worse than the silent failure we're replacing.
 */

import { describe, it, expect } from 'vitest'
import { detectSp95Limitations } from '../Sp95Lint'

// The #350 cross-loop set/get detector was retired 2026-05-28 (SV47 / commit
// 73a4475): the time-indexed Time State + eager b.set + post-sync vt bump
// make the idiom read the cuer's same-vt value. The block below flips the
// former positives to NEGATIVE CONTROLS — the pattern must NOT emit a warning
// any more — and keeps the original negative controls in place (SV50
// negative-control discipline: false positives are strictly worse than the
// silent failure they replaced).
describe('Sp95Lint — cross-loop set/get is supported (#350, NOT a warning)', () => {
  it('does NOT warn on the canonical director/section pattern (NOW supported)', () => {
    const src = `
      live_loop :director do
        set :root, (ring 52, 55, 57, 59).tick
        sleep 1
      end
      live_loop :player do
        sync :director
        play get(:root), release: 0.4
        sleep 1
      end
    `
    const w = detectSp95Limitations(src)
    // No SP95 warning at all on this pattern — it now reads {55,59} desktop-match.
    expect(w).toEqual([])
  })

  it('does NOT warn when set + get are in the SAME loop (works on web)', () => {
    const src = `
      live_loop :solo do
        set :note, 60
        play get(:note), release: 0.4
        sleep 1
      end
    `
    const w = detectSp95Limitations(src)
    expect(w).toEqual([])
  })

  it('does NOT warn on get without any matching set (different bug class)', () => {
    const src = `
      live_loop :reader do
        play get(:never_set), release: 0.4
        sleep 1
      end
    `
    const w = detectSp95Limitations(src)
    expect(w).toEqual([])
  })

  it('does NOT warn on set without any matching get', () => {
    const src = `
      live_loop :writer do
        set :unused, 1
        sleep 1
      end
    `
    const w = detectSp95Limitations(src)
    expect(w).toEqual([])
  })

  it('does NOT warn on cross-loop function-call form: get(:k) — NOW supported', () => {
    const src = `
      live_loop :a do; set :x, 1; sleep 1; end
      live_loop :b do; play get(:x); sleep 1; end
    `
    const w = detectSp95Limitations(src)
    expect(w).toEqual([])
  })

  it('does NOT warn on cross-loop bareword form: get :k — NOW supported', () => {
    const src = `
      live_loop :a do; set :x, 1; sleep 1; end
      live_loop :b do; play get :x; sleep 1; end
    `
    const w = detectSp95Limitations(src)
    expect(w).toEqual([])
  })
})

describe('Sp95Lint — cue payload via sync return-value (#351)', () => {
  it('warns on cue :x, kw: val + sync :x', () => {
    const src = `
      live_loop :sender do
        cue :beat, val: (ring 60, 64, 67, 71).tick
        sleep 1
      end
      live_loop :receiver do
        e = sync :beat
        play e[:val], release: 0.4
      end
    `
    const w = detectSp95Limitations(src)
    const hit = w.find(x => x.pattern === 'cue-payload-via-sync-return')
    expect(hit).toBeDefined()
    expect(hit!.title).toMatch(/cue payload via sync/)
    expect(hit!.message).toMatch(/:beat/)
  })

  it('also catches function-call form: cue(:beat, val: x)', () => {
    const src = `
      live_loop :s do; cue(:beat, val: 60); sleep 1; end
      live_loop :r do; sync :beat; end
    `
    const w = detectSp95Limitations(src)
    expect(w.some(x => x.pattern === 'cue-payload-via-sync-return')).toBe(true)
  })

  it('does NOT warn on payload-less cue + sync (works on web)', () => {
    const src = `
      live_loop :s do; cue :beat; sleep 1; end
      live_loop :r do; sync :beat; play 60; end
    `
    const w = detectSp95Limitations(src)
    expect(w.filter(x => x.pattern === 'cue-payload-via-sync-return')).toEqual([])
  })

  it('does NOT warn on cue with payload but no matching sync (no receiver)', () => {
    const src = `
      live_loop :s do; cue :beat, val: 60; sleep 1; end
    `
    const w = detectSp95Limitations(src)
    expect(w.filter(x => x.pattern === 'cue-payload-via-sync-return')).toEqual([])
  })
})

describe('Sp95Lint — sync return-value indexed (#351 — broader)', () => {
  it('warns on e = sync :x; e[:k] (even when cue is missing or in another file)', () => {
    const src = `
      live_loop :r do
        e = sync :beat
        play e[:val]
      end
    `
    const w = detectSp95Limitations(src)
    const hit = w.find(x => x.pattern === 'sync-return-indexed')
    expect(hit).toBeDefined()
    expect(hit!.message).toMatch(/:beat/)
  })

  it('also catches e.field accesses', () => {
    const src = `
      live_loop :r do
        e = sync :beat
        play e.val
      end
    `
    const w = detectSp95Limitations(src)
    expect(w.some(x => x.pattern === 'sync-return-indexed')).toBe(true)
  })

  it('does NOT warn on plain sync without assignment', () => {
    const src = `
      live_loop :r do
        sync :beat
        play 60
      end
    `
    const w = detectSp95Limitations(src)
    expect(w.filter(x => x.pattern === 'sync-return-indexed')).toEqual([])
  })

  it('does NOT warn on sync return assigned but never indexed', () => {
    // Assigning the return for logging is harmless; warn only when the user
    // tries to dig data out of it.
    const src = `
      live_loop :r do
        e = sync :beat
        puts e  # treats it as opaque — fine
      end
    `
    const w = detectSp95Limitations(src)
    expect(w.filter(x => x.pattern === 'sync-return-indexed')).toEqual([])
  })
})

describe('Sp95Lint — empty / unrelated programs', () => {
  it('returns no warnings on a trivial play loop', () => {
    expect(detectSp95Limitations('live_loop :foo do; play 60; sleep 1; end')).toEqual([])
  })

  it('returns no warnings on the empty string', () => {
    expect(detectSp95Limitations('')).toEqual([])
  })

  it('returns no warnings on a piece with set/get/cue/sync but all SP95-safe', () => {
    // Same-loop set/get + bare cue+sync. The director/section anti-pattern's
    // "safe twin": the same primitives, just used inside one loop.
    const src = `
      live_loop :solo do
        cue :tick                       # no payload
        sync :tick                      # plain sync, no return-value use
        set :n, 60
        play get(:n)                    # same-loop set+get is OK
        sleep 1
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })
})

describe('Sp95Lint — #351 patterns still coexist (#350 retired)', () => {
  it('emits BOTH #351 patterns when the program contains both — and the #350 pattern does NOT contribute', () => {
    const src = `
      live_loop :director do
        set :root, 60
        cue :beat, val: 64
      end
      live_loop :player do
        e = sync :beat
        play e[:val]
        play get(:root)
      end
    `
    const patterns = new Set(detectSp95Limitations(src).map(w => w.pattern))
    // #351 detectors are intact:
    expect(patterns).toContain('cue-payload-via-sync-return')
    expect(patterns).toContain('sync-return-indexed')
    // #350 detector is gone:
    expect(patterns.size).toBe(2)
  })
})
