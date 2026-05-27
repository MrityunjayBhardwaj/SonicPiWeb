/**
 * Web self-consistency under loop-declaration reorder (SV47 / #350 slice 2).
 *
 * WHAT THIS PROVES: our engine reads the SAME cross-loop set/get value
 * regardless of the source order in which the two live_loops are declared —
 * {55, 59} for both director-first and player-first. The #350 value-phase fix
 * (eager `b.set` at build + inclusive "last ≤ reader-vt" time-index) does NOT
 * leak a source-order / insertionOrder dependence (our scheduler ties same-vt
 * wakes on insertionOrder, VirtualTimeScheduler.ts:194-196 — NOT a desktop-style
 * total order; the `(time, taskId)` docstring at :152 is aspirational).
 *
 * WHAT THIS DOES *NOT* CLAIM: desktop parity on the reversed order. Grounded +
 * reproduced ×3 (2026-05-28), DESKTOP IS declaration-order-DEPENDENT here:
 * director-first → {55,59}, player-first → {52,57}. Root: desktop `sync` =
 * get_next "next cue strictly AFTER my time t" (event_history.rb:215,542) over
 * the full CueEvent total order (t, p, i, d…); at equal vt the (p=priority,
 * i=thread_id, d=thread_delta) thread-identity fields (core.rb:114-119, assigned
 * at thread spawn = declaration order) break the tie, so player-first catches the
 * t=0 cue (index 0 = 52). We do NOT implement that (t,p,i,d) total order — our
 * strict-vt-after wake-phase (Slice 1) collapses the equal-vt case, making web
 * self-consistent instead. Matching desktop's order-dependence is a separate
 * wake-phase/event-ordering parity feature (Slice 3, deferred — see GitHub issue
 * + memory sp95_350_reversed_order_total_order_gap). r1 NORMAL order is the #350
 * gate and is a stable Tier-1 PITCH-MATCH ×3.
 *
 * Companion Level-3 reproducers: /tmp/s8/r1_director_section.rb (normal — desktop
 * PITCH-MATCH) + /tmp/s8/r1_director_section_reversed.rb (reversed — desktop
 * diverges to {52,57} BY DESIGN, web stays {55,59}).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { SoundEvent } from '../SoundEventStream'

type SchedulerLike = { tick: (t: number) => void }

async function drive(engine: SonicPiEngine, targetVt = 6, steps = 6) {
  const scheduler = (engine as unknown as { scheduler: SchedulerLike | null }).scheduler
  if (!scheduler) return
  for (let i = 1; i <= steps; i++) {
    scheduler.tick((targetVt * i) / steps)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const DIRECTOR_FIRST = `
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

const PLAYER_FIRST = `
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
`

async function playerPrefix(src: string, n = 2): Promise<number[]> {
  delete (globalThis as Record<string, unknown>).SuperSonic
  const engine = new SonicPiEngine()
  await engine.init()
  const events: SoundEvent[] = []
  engine.components.streaming!.eventStream.on((e) => events.push(e))
  await engine.evaluate(src)
  engine.play()
  await drive(engine, 6, 6)
  const notes = events
    .filter((e) => typeof e.midiNote === 'number' && e.trackId === 'player')
    .map((e) => e.midiNote as number)
  engine.dispose()
  return notes.slice(0, n)
}

describe('Web self-consistency under loop reorder (SV47 / #350)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('director-first and player-first produce the IDENTICAL web prefix {55, 59}', async () => {
    const a = await playerPrefix(DIRECTOR_FIRST, 2)
    const b = await playerPrefix(PLAYER_FIRST, 2)
    // director-first matches desktop's {55, 59} — the #350 value-phase fix
    // (Level-3 PITCH-MATCH ×3). player-first is web's self-consistent result;
    // desktop diverges to {52,57} here BY DESIGN (the (t,p,i,d) total-order gap,
    // Slice 3) — NOT asserted against desktop. See file header.
    expect(a).toEqual([55, 59])
    expect(b).toEqual([55, 59])
    // The two web prefixes match each other — web does NOT leak a source-order /
    // insertionOrder dependence. If it did, they would diverge here.
    expect(b).toEqual(a)
  })
})
