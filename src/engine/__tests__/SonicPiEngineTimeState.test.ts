/**
 * Engine-level Time State tests (SV47 / #350 / SP95(d) slice 2).
 *
 * Companion to TimeState.test.ts (pure store) and SyncCue.test.ts (sync/cue
 * scheduler primitives). These tests assert the SAME-VT cross-loop set/get
 * contract at the SonicPiEngine level — exercising the full pipeline
 * (Sandbox → transpile → ProgramBuilder.set/get → eager TimeState write →
 * scheduler causation → microtask-ordered get read) in one shot.
 *
 * The pre-mortem (e) gate (PLAN-350-timestate.md): the cross-loop reader's
 * post-sync get must read the writer's same-vt set FOR BOTH declaration
 * orders — proving correctness rests on causation (cuer applies its set
 * before yielding; syncer's get is a microtask after the yield) + the
 * time-index, NOT on insertionOrder / source order / which asyncFn the
 * scheduler resumes first. The reorder-invariant variant is the HARD gate
 * the v1 plan lacked.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { SoundEvent } from '../SoundEventStream'

type SchedulerLike = { tick: (t: number) => void }

/**
 * Drive the scheduler through `targetVt` seconds of virtual time across
 * several tick passes. `tick(t)` is ABSOLUTE (resolves sleeps with
 * entry.time ≤ t) — using one big target lets a fresh microtask queue between
 * passes so cross-loop microtask races have time to interleave. The interval
 * (`steps`) mirrors the existing #336/SK14 tests.
 */
async function drive(engine: SonicPiEngine, targetVt = 5, steps = 5) {
  const scheduler = (engine as unknown as { scheduler: SchedulerLike | null }).scheduler
  if (!scheduler) return
  for (let i = 1; i <= steps; i++) {
    scheduler.tick((targetVt * i) / steps)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function midiNotes(events: SoundEvent[], trackId?: string): number[] {
  return events
    .filter((e) => typeof e.midiNote === 'number' && (trackId === undefined || e.trackId === trackId))
    .map((e) => e.midiNote as number)
}

describe('Time State — engine-level cross-loop set/get (SV47 / #350)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  // -------------------------------------------------------------------------
  // The pre-mortem (e) catch — write-not-yet-applied at read time. The two
  // tests below are the SAME musical program with the two live_loops in
  // OPPOSITE source order. Reorder-invariance is asserted by both reading the
  // same {55,59} prefix from the cuer's eager set at vt 0.5.
  // -------------------------------------------------------------------------

  it('(e) director-first: player\'s post-sync get reads the director\'s same-vt set ({55,59})', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
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
    `)
    engine.play()
    // Drive enough virtual time for two cuer cycles (director iter 1 cues at
    // vt 0, iter 2 at vt 1, etc.) plus the player's sync/play.
    await drive(engine, 6, 6)

    const played = midiNotes(events, 'player')
    // The cuer's iteration N writes (ring 52,55,57,59).tick[N-1] then sleeps;
    // the player wakes on the cuer's auto-cue at the cuer's iteration boundary
    // and reads the value the cuer JUST set at that vt. Desktop-matching
    // prefix is {55, 59, 55, 59, ...} (the cuer's tick-1, tick-3, ... values,
    // because the player wakes from sync AFTER the cuer's first sleep).
    expect(played.length).toBeGreaterThanOrEqual(2)
    expect(played[0]).toBe(55)
    expect(played[1]).toBe(59)

    engine.dispose()
  })

  it('(e) reversed: player declared BEFORE director — STILL reads {55,59} (reorder-invariant)', async () => {
    // The HARD gate. If this reads {52,57} or anything else, the design has
    // leaked a source-order dependence — eager-apply by causation is broken.
    const engine = new SonicPiEngine()
    await engine.init()

    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
      use_bpm 120
      live_loop :player do
        sync :director
        play get(:root), release: 0.4
        sleep 1
      end
      live_loop :director do
        set :root, (ring 52, 55, 57, 59).tick
        sleep 1
      end
    `)
    engine.play()
    await drive(engine, 6, 6)

    const played = midiNotes(events, 'player')
    expect(played.length).toBeGreaterThanOrEqual(2)
    expect(played[0]).toBe(55)
    expect(played[1]).toBe(59)

    engine.dispose()
  })

  // -------------------------------------------------------------------------
  // SV20: per-set timestamp keeps the intra-loop timeline correct. A
  // set-after-sleep records at the post-sleep vt; a get at an earlier vt
  // must still read the pre-set value. Asserted at the engine level (the
  // store-level guard lives in TimeState.test.ts).
  // -------------------------------------------------------------------------

  it('SV20: set-after-sleep records at the post-sleep vt (not iteration start)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    // A writer loop that does `set :y, 1; sleep 2; set :y, 2; sleep 999`.
    // At bpm=60, `sleep 2` advances current_time() by 2s — so the two sets
    // land at distinct vt values (iteration-start vt and iteration-start vt +
    // 2). The sleep 999 parks the loop so iteration 2 never starts within the
    // test window, leaving exactly two timestamped entries for :y.
    await engine.evaluate(`
      use_bpm 60
      live_loop :writer do
        set :y, 1
        sleep 2
        set :y, 2
        sleep 999
      end
    `)
    engine.play()
    await drive(engine, 5, 5)

    const store = (engine as unknown as {
      globalStore: { get: (k: string, t?: number) => unknown }
    }).globalStore

    // Iteration 1 starts at vt=0 (initial sleep(0) wake), so the per-set
    // timestamps are 0 (set :y, 1) and 2 (set :y, 2 — after sleep 2).
    expect(store.get('y', -0.5)).toBeNull() // before any write
    expect(store.get('y', 0)).toBe(1) // at the first set's vt
    expect(store.get('y', 1)).toBe(1) // between the two sets
    expect(store.get('y', 1.99)).toBe(1) // just before the second set
    expect(store.get('y', 2)).toBe(2) // at the second set's vt (inclusive)
    expect(store.get('y', 10)).toBe(2) // long after — latest stays visible

    engine.dispose()
  })

  // -------------------------------------------------------------------------
  // Same-loop set+get (the canonical no-warn case, never broken). Confirms
  // the eager write + builder-routed get path doesn't regress the basic idiom.
  // -------------------------------------------------------------------------

  it('same-loop set/get: play get(:n) reads the current iteration\'s set', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
      use_bpm 120
      live_loop :solo do
        set :n, (ring 60, 64, 67).tick
        play get(:n), release: 0.4
        sleep 1
      end
    `)
    engine.play()
    // At bpm=120 each iteration is 0.5s; 4s of vt → ~8 iterations.
    await drive(engine, 4, 4)

    const played = midiNotes(events, 'solo')
    // The first three iterations write 60, 64, 67 and immediately read them.
    expect(played.length).toBeGreaterThanOrEqual(3)
    expect(played[0]).toBe(60)
    expect(played[1]).toBe(64)
    expect(played[2]).toBe(67)

    engine.dispose()
  })

  // -------------------------------------------------------------------------
  // SK14: store survives Stop, cleared on dispose. Mirrors the existing #336
  // test but uses the time-indexed contract directly to guard against a
  // regression where dispose-only clear is moved back to stop().
  // -------------------------------------------------------------------------

  it('SK14: Time State persists across Stop, cleared only on dispose', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate('set :section, 41')
    engine.stop()

    const store = (engine as unknown as {
      globalStore: { get: (k: string) => unknown; size: number }
    }).globalStore
    // Survives Stop (no clear).
    expect(store.get('section')).toBe(41)
    expect(store.size).toBeGreaterThan(0)

    engine.dispose()
    // Cleared on dispose.
    expect(store.size).toBe(0)
  })
})
