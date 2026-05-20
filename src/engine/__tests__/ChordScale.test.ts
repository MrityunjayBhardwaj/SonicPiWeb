import { describe, it, expect } from 'vitest'
import { chord, scale, chord_invert, chord_degree, note, note_range } from '../ChordScale'

describe('chord', () => {
  it('major chord from C4', () => {
    expect(chord('c4', 'major').toArray()).toEqual([60, 64, 67])
  })

  it('minor chord from A3', () => {
    expect(chord('a3', 'minor').toArray()).toEqual([57, 60, 64])
  })

  it('dom7 chord', () => {
    expect(chord('c4', 'dom7').toArray()).toEqual([60, 64, 67, 70])
  })

  it('major7 chord', () => {
    expect(chord('c4', 'major7').toArray()).toEqual([60, 64, 67, 71])
  })

  it('diminished chord', () => {
    expect(chord('c4', 'dim').toArray()).toEqual([60, 63, 66])
  })

  it('augmented chord', () => {
    expect(chord('c4', 'aug').toArray()).toEqual([60, 64, 68])
  })

  it('sus2', () => {
    expect(chord('c4', 'sus2').toArray()).toEqual([60, 62, 67])
  })

  it('sus4', () => {
    expect(chord('c4', 'sus4').toArray()).toEqual([60, 65, 67])
  })

  it('accepts MIDI numbers', () => {
    expect(chord(60, 'major').toArray()).toEqual([60, 64, 67])
  })

  it('multi-octave chord', () => {
    const c = chord('c4', 'major', 2).toArray()
    expect(c).toEqual([60, 64, 67, 72, 76, 79])
  })

  it('returns a Ring', () => {
    const c = chord('c4', 'major')
    expect(c.at(3)).toBe(60) // wraps
  })

  it('falls back to major for unknown type', () => {
    expect(chord('c4', 'nonexistent').toArray()).toEqual([60, 64, 67])
  })
})

describe('scale', () => {
  it('major scale from C4', () => {
    expect(scale('c4', 'major').toArray()).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
  })

  it('minor pentatonic', () => {
    expect(scale('c4', 'minor_pentatonic').toArray()).toEqual([60, 63, 65, 67, 70, 72])
  })

  it('blues scale', () => {
    expect(scale('c4', 'blues').toArray()).toEqual([60, 63, 65, 66, 67, 70, 72])
  })

  it('chromatic scale', () => {
    const s = scale('c4', 'chromatic').toArray()
    expect(s.length).toBe(13) // 12 + octave
    expect(s[0]).toBe(60)
    expect(s[12]).toBe(72)
  })

  it('dorian mode', () => {
    expect(scale('c4', 'dorian').toArray()).toEqual([60, 62, 63, 65, 67, 69, 70, 72])
  })

  it('multi-octave scale', () => {
    const s = scale('c4', 'major', 2).toArray()
    expect(s[0]).toBe(60)
    expect(s[7]).toBe(72) // second octave starts
    expect(s[s.length - 1]).toBe(84) // top note
  })

  it('returns a Ring', () => {
    const s = scale('c4', 'minor_pentatonic')
    expect(s.at(100)).toBeDefined() // wraps
  })

  it('falls back to major for unknown type', () => {
    expect(scale('c4', 'nonexistent').toArray()).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
  })
})

describe('chord_invert', () => {
  // All assertions match desktop SP `lib/sonicpi/lang/western_theory.rb:1053-1064`.

  it('first inversion of C major', () => {
    const c = chord('c4', 'major')
    expect(chord_invert(c, 1).toArray()).toEqual([64, 67, 72])
  })

  it('second inversion of C major', () => {
    const c = chord('c4', 'major')
    expect(chord_invert(c, 2).toArray()).toEqual([67, 72, 76])
  })

  it('root position (inversion 0)', () => {
    const c = chord('c4', 'major')
    expect(chord_invert(c, 0).toArray()).toEqual([60, 64, 67])
  })

  it('works with plain arrays', () => {
    expect(chord_invert([60, 64, 67], 1).toArray()).toEqual([64, 67, 72])
  })

  // #372: negative-shift cases. Desktop: `(notes[0..-2] + [notes[-1]-12]).sort`.
  // Pre-fix our impl coerced negatives to positive remainders and produced
  // the wrong notes (e.g. chord_invert([60,64,67], -1) returned [67,72,76]).
  it('negative inversion (-1) of C major', () => {
    // Desktop: pop 67, push 67-12=55, sort → [55, 60, 64]
    expect(chord_invert([60, 64, 67], -1).toArray()).toEqual([55, 60, 64])
  })

  it('negative inversion (-2) of C major', () => {
    // Desktop chained: shift=-2 → [55,60,64], shift=-1 → [52,55,60]
    expect(chord_invert([60, 64, 67], -2).toArray()).toEqual([52, 55, 60])
  })

  it('negative inversion (-3) of C major', () => {
    // Three iterations of pop-last/−12/sort
    expect(chord_invert([60, 64, 67], -3).toArray()).toEqual([48, 52, 55])
  })

  // Ground-truth regression test from desktop's own docstring example —
  // `western_theory.rb:1078`: "play (chord_invert (chord :A3, "M"), 0)
  //   #No inversion - (ring 57, 61, 64)".
  it('matches desktop docstring: chord_invert(chord(:a3, "M"), 0) → [57,61,64]', () => {
    expect(chord_invert(chord('a3', 'major'), 0).toArray()).toEqual([57, 61, 64])
  })

  it('rounds non-integer shift (matches desktop shift.round)', () => {
    expect(chord_invert([60, 64, 67], 0.6).toArray()).toEqual([64, 67, 72]) // 0.6 → 1
    expect(chord_invert([60, 64, 67], -0.6).toArray()).toEqual([55, 60, 64]) // -0.6 → -1
  })
})

describe('chord_degree with invert: opt (#372)', () => {
  // Desktop `western_theory.rb:904`:
  //   chord_invert(Chord.resolve_degree(degree, tonic, scale, number_of_notes), opts[:invert]).ring
  it('invert: 0 returns the un-inverted chord (sorted)', () => {
    expect(chord_degree('i', 'c4', 'major', 3, { invert: 0 }).toArray()).toEqual([60, 64, 67])
  })

  it('matches desktop docstring example: chord_degree(:i, :C, :major, 3, invert: 1) → [64, 67, 72]', () => {
    // Desktop docstring at `western_theory.rb:922`:
    //   "play (chord_degree :i, :C4, :major, 3, invert: 1) # Play the first
    //   inversion of chord i in C major - (ring 64, 67, 72)"
    expect(chord_degree('i', 'c4', 'major', 3, { invert: 1 }).toArray()).toEqual([64, 67, 72])
  })

  it('invert: -1 on triad threads negative shift through chord_invert', () => {
    expect(chord_degree('i', 'c4', 'major', 3, { invert: -1 }).toArray()).toEqual([55, 60, 64])
  })

  it('without invert: opt, default still gives 4-note Cmaj7 (#355 Part A)', () => {
    expect(chord_degree('i', 'c4', 'major').toArray()).toEqual([60, 64, 67, 71])
  })
})

describe('note', () => {
  it('converts note name to MIDI', () => {
    expect(note('c4')).toBe(60)
    expect(note('a4')).toBe(69)
  })

  it('passes through MIDI numbers', () => {
    expect(note(60)).toBe(60)
  })
})

describe('note_range', () => {
  it('generates range of MIDI notes', () => {
    const r = note_range('c4', 'e4').toArray()
    expect(r).toEqual([60, 61, 62, 63, 64])
  })

  it('returns a Ring', () => {
    const r = note_range('c4', 'c5')
    expect(r.at(13)).toBe(60) // wraps
  })
})
