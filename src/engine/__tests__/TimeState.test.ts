import { describe, it, expect } from 'vitest'
import { TimeState } from '../TimeState'

describe('TimeState — virtual-time-indexed store (SV47 / #350)', () => {
  it('(i) get returns the last entry ≤ t, not a later one', () => {
    const ts = new TimeState()
    ts.set('k', 'a', 0)
    ts.set('k', 'b', 2)
    // Reader at vt 1 sees the vt-0 value, NOT the future vt-2 value.
    expect(ts.get('k', 1)).toBe('a')
    // Reader at vt 2 sees the vt-2 value.
    expect(ts.get('k', 2)).toBe('b')
    // Reader at vt 5 still sees the latest ≤ 5.
    expect(ts.get('k', 5)).toBe('b')
  })

  it('(ii) inclusive same-vt visibility: set(k,v,T) then get(k,T) === v', () => {
    const ts = new TimeState()
    ts.set('root', 55, 0.5)
    // A set recorded at vt 0.5 IS visible to a get at exactly vt 0.5.
    expect(ts.get('root', 0.5)).toBe(55)
  })

  it('(iii) negative control: get(k, T-ε) reads the pre-T value', () => {
    const ts = new TimeState()
    ts.set('root', 52, 0)
    ts.set('root', 55, 0.5)
    // Just before the vt-0.5 write, the reader sees the vt-0 value.
    expect(ts.get('root', 0.5 - 1e-9)).toBe(52)
    // No entry at or before a vt earlier than the first write → null.
    expect(ts.get('root', -1)).toBeNull()
  })

  it('(iv) facade: get(key) latest value, size, clear', () => {
    const ts = new TimeState()
    expect(ts.get('note')).toBeUndefined()
    expect(ts.size).toBe(0)
    ts.set('note', 60, 0)
    ts.set('note', 64, 1)
    // No-vt facade returns the latest value (Map-compatible).
    expect(ts.get('note')).toBe(64)
    expect(ts.size).toBe(1)
    ts.set('other', 1, 0)
    expect(ts.size).toBe(2)
    ts.clear()
    expect(ts.size).toBe(0)
    expect(ts.get('note')).toBeUndefined()
  })

  it('(v) set-after-sleep timeline: per-set timestamps keep intra-loop order (SV20)', () => {
    const ts = new TimeState()
    // Models `set :x,1; sleep 2; set :x,2` — recorded at T and T+2.
    ts.set('x', 1, 0)
    ts.set('x', 2, 2)
    expect(ts.get('x', 1)).toBe(1) // before the second set
    expect(ts.get('x', 3)).toBe(2) // after the second set
  })

  it('(vi) idempotent re-apply: same (key,value,t) does not create a shadow entry', () => {
    const ts = new TimeState()
    ts.set('x', 7, 0.5)
    ts.set('x', 7, 0.5) // deferred interpreter re-apply at the same build vt
    // Only one effective entry: a later reader still sees 7, and an earlier
    // write at the same key remains visible at its own vt (no phantom shadow).
    expect(ts.get('x', 0.5)).toBe(7)
    // A subsequent distinct write must still register normally.
    ts.set('x', 9, 1)
    expect(ts.get('x', 0.5)).toBe(7)
    expect(ts.get('x', 1)).toBe(9)
  })

  it('symbol keys are supported (set/get use string|symbol keys)', () => {
    const ts = new TimeState()
    const sym = Symbol('root')
    ts.set(sym, 42, 0)
    expect(ts.get(sym, 0)).toBe(42)
    expect(ts.get(sym)).toBe(42)
  })

  it('out-of-order write is inserted in ascending-t order', () => {
    const ts = new TimeState()
    ts.set('k', 'late', 2)
    ts.set('k', 'early', 1) // arrives after but is timestamped earlier
    expect(ts.get('k', 1)).toBe('early')
    expect(ts.get('k', 2)).toBe('late')
    expect(ts.get('k', 0.5)).toBeNull()
  })
})
