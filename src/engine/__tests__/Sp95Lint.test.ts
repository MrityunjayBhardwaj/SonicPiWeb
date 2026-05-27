/**
 * Sp95Lint — RETIRED detector, negative-control suite (SP95(d) Slices 1 & 2).
 *
 * All three SP95 patterns the lint used to warn about now produce correct,
 * desktop-matching audio (see Sp95Lint.ts header + SV47 IMPLEMENTED):
 *   • #350 cross-loop set/get   → time-indexed TimeState (Slice 2)
 *   • #351 cue-payload-via-sync → build-time sync await (Slice 1)
 *   • #351 sync-return-indexed  → build-time sync await (Slice 1)
 *
 * `detectSp95Limitations` therefore returns `[]` for every input. These tests
 * are the SV50 negative-control guard: the canonical reproducers — which are
 * Level-3 PITCH-MATCH against desktop — must NEVER re-introduce a warning. A
 * false positive on a working idiom is strictly worse than no lint at all.
 */

import { describe, it, expect } from 'vitest'
import { detectSp95Limitations } from '../Sp95Lint'

describe('Sp95Lint — all SP95 idioms supported, lint retired (NO warnings)', () => {
  it('does NOT warn on the #350 cross-loop director/section pattern (r1, PITCH-MATCH ×3)', () => {
    const src = `
      use_bpm 120
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
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('does NOT warn on the #351 cue-payload-via-sync pattern (r3, PITCH-MATCH)', () => {
    const src = `
      use_bpm 120
      live_loop :sender do
        cue :beat, val: (ring 60, 64, 67, 71).tick
        sleep 1
      end
      live_loop :receiver do
        e = sync :beat
        play e[:val], release: 0.4
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('does NOT warn on the #351 sync-return-indexed conditional pattern (r4, PITCH-MATCH)', () => {
    const src = `
      use_bpm 120
      live_loop :sender do
        cue :beat, n: (ring 55, 67).tick
        sleep 1
      end
      live_loop :receiver do
        e = sync :beat
        if e[:n] > 60
          play 90, release: 0.4
        else
          play 50, release: 0.4
        end
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('does NOT warn on cue(:beat, val: x) function-call form', () => {
    const src = `
      live_loop :s do
        cue(:beat, val: 60)
        sleep 1
      end
      live_loop :r do
        e = sync :beat
        play e[:val]
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('does NOT warn on same-loop set/get (always worked)', () => {
    const src = `
      live_loop :a do
        set :k, 60
        play get(:k)
        sleep 1
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('does NOT warn on payload-less cue + sync', () => {
    const src = `
      live_loop :s do
        cue :beat
        sleep 1
      end
      live_loop :r do
        sync :beat
        play 60
      end
    `
    expect(detectSp95Limitations(src)).toEqual([])
  })

  it('returns [] for arbitrary unrelated code', () => {
    expect(detectSp95Limitations('play 60\nsleep 1\nsample :bd_haus')).toEqual([])
    expect(detectSp95Limitations('')).toEqual([])
  })
})
