/**
 * Reorder-invariance HARD gate (SV47 / #350 slice 2 task 6).
 *
 * Decision Q2: correctness rests on (i) causation (the cuer applies its eager
 * `set` before it yields; the syncer's post-sync `get` is a microtask after the
 * yield) and (ii) the inclusive "last ≤ t" time-index. It does NOT rest on the
 * scheduler's same-vt wake order — which is insertionOrder-keyed
 * (VirtualTimeScheduler.ts:194-196, the v1 plan's FAIL-1 was the false
 * `(time, taskId)` total-order claim).
 *
 * The reorder-invariance probe: declare the player (reader) BEFORE the director
 * (writer) in source. Insertion order now favors the player; if the fix had
 * leaked a source-order dependence, the player would resume first and read a
 * stale 52. The test demands identical {55, 59} prefixes for BOTH declaration
 * orders — proving the design depends on causation, not on which asyncFn the
 * scheduler resumes first.
 *
 * Companion Level-3 reproducers (Task 7): /tmp/s8/r1_director_section.rb +
 * /tmp/s8/r1_director_section_reversed.rb.
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

describe('Reorder-invariance HARD gate (SV47 / #350)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('director-first and player-first produce the IDENTICAL prefix {55, 59}', async () => {
    const a = await playerPrefix(DIRECTOR_FIRST, 2)
    const b = await playerPrefix(PLAYER_FIRST, 2)
    // Each individually matches desktop's {55, 59} — the value-phase fix.
    expect(a).toEqual([55, 59])
    expect(b).toEqual([55, 59])
    // And they match each other — the reorder-invariance gate. If either side
    // leaks a source-order / insertionOrder dependence, they diverge here.
    expect(b).toEqual(a)
  })
})
