/**
 * Integration test: Run actual Sonic Pi Ruby code through the full engine pipeline
 * (transpile → sandbox → ProgramBuilder → QueryInterpreter) and verify
 * every Wave 1 DSL function works end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { QueryEvent } from '../interpreters/QueryInterpreter'

let engine: SonicPiEngine

beforeEach(async () => {
  engine = new SonicPiEngine()
  await engine.init()
})

afterEach(() => {
  engine.dispose()
})

/** Evaluate Ruby code, return first iteration of query events (0 to loopDuration). */
async function evalAndQuery(ruby: string, loopDuration: number): Promise<{ events: QueryEvent[], error?: Error }> {
  const result = await engine.evaluate(ruby)
  const events = engine.components.capture
    ? await engine.components.capture.queryRange(0, loopDuration)
    : []
  return { events, error: result.error }
}

/** Extract synth notes from first iteration only. */
function synthNotes(events: QueryEvent[]): { note: number; time: number }[] {
  return events
    .filter((e) => e.type === 'synth')
    .map((e) => ({ note: e.params.note as number, time: e.time }))
}

describe('Wave 1 DSL Integration (Ruby → engine)', () => {
  it('wait is alias for sleep — produces correctly timed notes', async () => {
    // Query only first iteration (1 beat = 0.5 + 0.5)
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play 60
        wait 0.5
        play 62
        wait 0.5
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(2)
    expect(notes[0].note).toBe(60)
    expect(notes[1].note).toBe(62)
    expect(notes[1].time).toBeCloseTo(0.5, 1)
  })

  it('print does not crash inside live_loop', async () => {
    const { error } = await evalAndQuery(`
      live_loop :test do
        print "hello world"
        play 60
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
  })

  it('hz_to_midi converts frequency to MIDI note', async () => {
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play hz_to_midi(440)
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(1)
    expect(notes[0].note).toBeCloseTo(69, 0) // A4
  })

  it('quantise rounds to nearest semitone', async () => {
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play quantise(60.7, 1)
        sleep 0.5
        play quantise(60.3, 1)
        sleep 0.5
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(2)
    expect(notes[0].note).toBe(61)
    expect(notes[1].note).toBe(60)
  })

  it('quantize is alias for quantise', async () => {
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play quantize(60.7, 1)
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes[0].note).toBe(61)
  })

  it('degree returns single note at scale degree', async () => {
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play degree(:i, :c4, :major)
        sleep 0.5
        play degree(:iii, :c4, :major)
        sleep 0.5
        play degree(:v, :c4, :major)
        sleep 0.5
      end
    `, 1.49)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(3)
    expect(notes[0].note).toBe(60)  // C4
    expect(notes[1].note).toBe(64)  // E4
    expect(notes[2].note).toBe(67)  // G4
  })

  it('chord_degree returns chord at scale degree (4 simultaneous notes — Cmaj7 by default)', async () => {
    // Default chord size = 4 (diatonic 7th chord) per desktop SP
    // `western_theory.rb:900` `number_of_notes=4`. #355.
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play chord_degree(:i, :c4, :major)
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(4)
    const midiNotes = notes.map((n) => n.note).sort((a, b) => a - b)
    expect(midiNotes).toEqual([60, 64, 67, 71])  // C E G B
  })

  it('octs generates octave-spaced notes', async () => {
    // octs returns a Ring, .choose uses seeded RNG → S2 but still capturable
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        play octs(60, 3).choose
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(1)
    expect([60, 72, 84]).toContain(notes[0].note)
  })

  it('hz_to_midi + quantise combo — snap frequency to semitone', async () => {
    const { events, error } = await evalAndQuery(`
      live_loop :test do
        raw = hz_to_midi(440)
        snapped = quantise(raw, 1)
        play snapped
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    expect(notes.length).toBe(1)
    expect(notes[0].note).toBe(69) // 440 Hz = A4 = MIDI 69
  })

  it('full composition: chord_degree progression + degree bass', async () => {
    // First iteration of each loop: 2 beats each
    const { events, error } = await evalAndQuery(`
      use_bpm 120
      live_loop :chords do
        play chord_degree(:i, :c4, :major)
        wait 1
        play chord_degree(:v, :c4, :major)
        wait 1
      end
      live_loop :bass do
        play degree(:i, :c3, :major), amp: 0.8
        sleep 1
        play degree(:v, :c3, :major), amp: 0.8
        sleep 1
      end
    `, 0.99)
    expect(error).toBeUndefined()
    const notes = synthNotes(events)
    // At BPM 120: 1 beat = 0.5s. Query 0-0.99s = ~2 beats = first iteration.
    // chord_degree default = 4 notes (Cmaj7 / G7 — #355). 2 chords × 4 + 2 bass = 10.
    expect(notes.length).toBe(10)
  })
})
