import { noteToMidi } from './NoteToFreq'
import { Ring } from './Ring'

// ---------------------------------------------------------------------------
// Chord definitions — intervals from root in semitones
// ---------------------------------------------------------------------------

const CHORD_TYPES: Record<string, number[]> = {
  major:       [0, 4, 7],
  minor:       [0, 3, 7],
  dim:         [0, 3, 6],
  diminished:  [0, 3, 6],
  aug:         [0, 4, 8],
  augmented:   [0, 4, 8],
  dom7:        [0, 4, 7, 10],
  '7':         [0, 4, 7, 10],
  major7:      [0, 4, 7, 11],
  M7:          [0, 4, 7, 11],
  minor7:      [0, 3, 7, 10],
  m7:          [0, 3, 7, 10],
  dim7:        [0, 3, 6, 9],
  aug7:        [0, 4, 8, 10],
  halfdim:     [0, 3, 6, 10],
  'm7-5':      [0, 3, 6, 10],
  m9:          [0, 3, 7, 10, 14],
  dom9:        [0, 4, 7, 10, 14],
  '9':         [0, 4, 7, 10, 14],
  major9:      [0, 4, 7, 11, 14],
  M9:          [0, 4, 7, 11, 14],
  minor11:     [0, 3, 7, 10, 14, 17],
  dom11:       [0, 4, 7, 10, 14, 17],
  '11':        [0, 4, 7, 10, 14, 17],
  minor13:     [0, 3, 7, 10, 14, 17, 21],
  dom13:       [0, 4, 7, 10, 14, 17, 21],
  '13':        [0, 4, 7, 10, 14, 17, 21],
  sus2:        [0, 2, 7],
  sus4:        [0, 5, 7],
  power:       [0, 7],
  '1':         [0],
  '5':         [0, 7],
  '+5':        [0, 4, 8],
  m_plus_5:    [0, 3, 8],
  sus2sus4:    [0, 2, 5, 7],
  add9:        [0, 4, 7, 14],
  add11:       [0, 4, 7, 17],
  add13:       [0, 4, 7, 21],
  madd9:       [0, 3, 7, 14],
  madd11:      [0, 3, 7, 17],
  madd13:      [0, 3, 7, 21],
  '6':         [0, 4, 7, 9],
  m6:          [0, 3, 7, 9],
  '6_9':       [0, 4, 7, 9, 14],
  m6_9:        [0, 3, 7, 9, 14],
  // Extended chords — from Desktop SP chord.rb
  '7sus2':     [0, 2, 7, 10],
  '7sus4':     [0, 5, 7, 10],
  '7-5':       [0, 4, 6, 10],
  '7+5':       [0, 4, 8, 10],
  'm7+5':      [0, 3, 8, 10],
  'm7+9':      [0, 3, 7, 10, 14],
  '9sus4':     [0, 5, 7, 10, 14],
  '6*9':       [0, 4, 7, 9, 14],
  'm6*9':      [0, 3, 7, 9, 14],
  '7-9':       [0, 4, 7, 10, 13],
  'm7-9':      [0, 3, 7, 10, 13],
  '7-10':      [0, 4, 7, 10, 15],
  '7-11':      [0, 4, 7, 10, 16],
  '7-13':      [0, 4, 7, 10, 20],
  '9+5':       [0, 10, 13],
  'm9+5':      [0, 10, 14],
  '7+5-9':     [0, 4, 8, 10, 13],
  'm7+5-9':    [0, 3, 8, 10, 13],
  '11+':       [0, 4, 7, 10, 14, 18],
  'm11+':      [0, 3, 7, 10, 14, 18],
  add2:        [0, 2, 4, 7],
  add4:        [0, 4, 5, 7],
  madd2:       [0, 2, 3, 7],
  madd4:       [0, 3, 5, 7],
  // Aliases
  M:           [0, 4, 7],
  m:           [0, 3, 7],
  maj:         [0, 4, 7],
  min:         [0, 3, 7],
  a:           [0, 4, 8],
  i:           [0, 3, 6],
  i7:          [0, 3, 6, 9],
  m7b5:        [0, 3, 6, 10],
  maj9:        [0, 4, 7, 11, 14],
  maj11:       [0, 4, 7, 11, 14, 17],
  m11:         [0, 3, 7, 10, 14, 17],
  m13:         [0, 3, 7, 10, 14, 17, 21],
}

// ---------------------------------------------------------------------------
// Scale definitions — intervals from root in semitones
// ---------------------------------------------------------------------------

const SCALE_TYPES: Record<string, number[]> = {
  major:              [0, 2, 4, 5, 7, 9, 11],
  minor:              [0, 2, 3, 5, 7, 8, 10],
  natural_minor:      [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor:     [0, 2, 3, 5, 7, 8, 11],
  melodic_minor:      [0, 2, 3, 5, 7, 9, 11],
  dorian:             [0, 2, 3, 5, 7, 9, 10],
  phrygian:           [0, 1, 3, 5, 7, 8, 10],
  lydian:             [0, 2, 4, 6, 7, 9, 11],
  mixolydian:         [0, 2, 4, 5, 7, 9, 10],
  aeolian:            [0, 2, 3, 5, 7, 8, 10],
  locrian:            [0, 1, 3, 5, 6, 8, 10],
  minor_pentatonic:   [0, 3, 5, 7, 10],
  major_pentatonic:   [0, 2, 4, 7, 9],
  blues:              [0, 3, 5, 6, 7, 10],
  chromatic:          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  whole_tone:         [0, 2, 4, 6, 8, 10],
  whole:              [0, 2, 4, 6, 8, 10],
  diminished:         [0, 2, 3, 5, 6, 8, 9, 11],
  octatonic:          [0, 2, 3, 5, 6, 8, 9, 11],
  hex_major6:         [0, 2, 4, 5, 7, 9],
  hex_dorian:         [0, 2, 3, 5, 7, 10],
  hex_phrygian:       [0, 1, 3, 5, 8, 10],
  hex_major7:         [0, 2, 4, 7, 9, 11],
  hex_sus:            [0, 2, 5, 7, 9, 10],
  hex_aeolian:        [0, 3, 5, 7, 8, 10],
  hungarian_minor:    [0, 2, 3, 6, 7, 8, 11],
  gypsy:              [0, 2, 3, 6, 7, 8, 11],
  hirajoshi:          [0, 4, 6, 7, 11],
  iwato:              [0, 1, 5, 6, 10],
  kumoi:              [0, 2, 3, 7, 9],
  in_sen:             [0, 1, 5, 7, 10],
  yo:                 [0, 3, 5, 7, 10],
  pelog:              [0, 1, 3, 7, 8],
  chinese:            [0, 4, 6, 7, 11],
  egyptian:           [0, 2, 5, 7, 10],
  prometheus:         [0, 2, 4, 6, 9, 10],
  scriabin:           [0, 1, 4, 7, 9],
  indian:             [0, 4, 5, 7, 8, 11],
  enigmatic:          [0, 1, 4, 6, 8, 10, 11],
  spanish:            [0, 1, 3, 4, 5, 7, 8, 10],
  neapolitan_major:   [0, 1, 3, 5, 7, 9, 11],
  neapolitan_minor:   [0, 1, 3, 5, 7, 8, 11],
  bebop_major:        [0, 2, 4, 5, 7, 8, 9, 11],
  bebop_minor:        [0, 2, 3, 5, 7, 8, 10, 11],
  bebop_dominant:     [0, 2, 4, 5, 7, 9, 10, 11],
  super_locrian:      [0, 1, 3, 4, 6, 8, 10],
  persian:            [0, 1, 4, 5, 6, 8, 11],
  arabic:             [0, 2, 4, 5, 6, 8, 10],
  japanese:           [0, 1, 5, 7, 8],
  lydian_minor:       [0, 2, 4, 6, 7, 8, 10],
  // Aliases
  ionian:             [0, 2, 4, 5, 7, 9, 11],
  diatonic:           [0, 2, 4, 5, 7, 9, 11],
  // Extended scales — from Desktop SP scale.rb
  melodic_minor_asc:  [0, 2, 3, 5, 7, 9, 11],
  melodic_minor_desc: [0, 2, 3, 5, 7, 8, 10],
  bartok:             [0, 2, 4, 6, 7, 9, 10],
  bhairav:            [0, 1, 4, 5, 7, 8, 11],
  locrian_major:      [0, 2, 4, 5, 6, 8, 10],
  ahirbhairav:        [0, 1, 4, 5, 7, 9, 11],
  harmonic_major:     [0, 2, 4, 5, 7, 8, 11],
  romanian_minor:     [0, 2, 3, 6, 7, 9, 11],
  hindu:              [0, 2, 4, 5, 7, 9, 10],
  todi:               [0, 1, 3, 6, 7, 8, 11],
  purvi:              [0, 1, 4, 5, 7, 8, 11],
  marva:              [0, 1, 4, 5, 7, 9, 10],
  melodic_major:      [0, 2, 4, 5, 7, 9, 10],
  leading_whole:      [0, 2, 4, 6, 8, 10, 11],
  augmented:          [0, 3, 4, 7, 8, 11],
  augmented2:         [0, 1, 4, 5, 8, 9],
  blues_major:        [0, 2, 3, 6, 8, 11],
  blues_minor:        [0, 3, 5, 6, 9, 11],
  diminished2:        [0, 2, 3, 5, 6, 8, 9, 11],
  // Messiaen modes of limited transposition
  messiaen1:          [0, 2, 4, 6, 8, 10],
  messiaen2:          [0, 1, 3, 4, 6, 7, 9, 10],
  messiaen3:          [0, 2, 3, 5, 6, 8, 9, 11],
  messiaen4:          [0, 1, 4, 5, 6, 9, 10, 11],
  messiaen5:          [0, 1, 5, 6, 7, 11],
  messiaen6:          [0, 2, 4, 5, 7, 9, 10, 11],
  messiaen7:          [0, 1, 2, 4, 5, 6, 7, 9, 10, 11],
  // Pentatonic aliases
  yu:                 [0, 3, 5, 7, 10],
  gong:               [0, 2, 4, 7, 9],
  shang:              [0, 2, 5, 7, 10],
  jiao:               [0, 3, 5, 7, 10],
  zhi:                [0, 2, 4, 7, 9],
  ritusen:            [0, 2, 4, 7, 9],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a chord from a root note and chord type.
 * Returns a Ring of MIDI note numbers.
 *
 * chord(:c4, :major) → Ring([60, 64, 67])
 */
export function chord(root: string | number, type: string = 'major', numOctavesOrOpts: number | { num_octaves?: number } = 1): Ring<number> {
  const numOctaves = typeof numOctavesOrOpts === 'number' ? numOctavesOrOpts : (numOctavesOrOpts.num_octaves ?? 1)
  const rootMidi = noteToMidi(root)
  const intervals = CHORD_TYPES[type]
  if (!intervals) {
    console.warn(`[SonicPi] Unknown chord type: ${type}, using major`)
    return chord(root, 'major', numOctaves)
  }

  const notes: number[] = []
  for (let oct = 0; oct < numOctaves; oct++) {
    for (const interval of intervals) {
      notes.push(rootMidi + interval + oct * 12)
    }
  }
  return new Ring(notes)
}

/**
 * Build a scale from a root note and scale type.
 * Returns a Ring of MIDI note numbers spanning one octave by default.
 *
 * scale(:c4, :minor_pentatonic) → Ring([60, 63, 65, 67, 70])
 */
export function scale(root: string | number, type: string = 'major', numOctavesOrOpts: number | { num_octaves?: number } = 1): Ring<number> {
  const numOctaves = typeof numOctavesOrOpts === 'number' ? numOctavesOrOpts : (numOctavesOrOpts.num_octaves ?? 1)
  const rootMidi = noteToMidi(root)
  const intervals = SCALE_TYPES[type]
  if (!intervals) {
    console.warn(`[SonicPi] Unknown scale type: ${type}, using major`)
    return scale(root, 'major', numOctaves)
  }

  const notes: number[] = []
  for (let oct = 0; oct < numOctaves; oct++) {
    for (const interval of intervals) {
      notes.push(rootMidi + interval + oct * 12)
    }
  }
  // Sonic Pi includes the octave note at the end
  notes.push(rootMidi + 12 * numOctaves)
  return new Ring(notes)
}

/**
 * Invert a chord by shifting the lowest N notes up an octave.
 *
 * chord_invert(chord(:c4, :major), 1) → [64, 67, 72]
 */
export function chord_invert(notes: Ring<number> | number[], inversion: number): Ring<number> {
  const arr = Array.isArray(notes) ? [...notes] : notes.toArray()

  let inv = ((inversion % arr.length) + arr.length) % arr.length
  for (let i = 0; i < inv; i++) {
    const lowest = arr.shift()!
    arr.push(lowest + 12)
  }

  return new Ring(arr)
}

/**
 * Alias for noteToMidi — matches Sonic Pi's note() function.
 *
 * note(:c4) → 60
 */
export function note(n: string | number): number {
  return noteToMidi(n)
}

/**
 * Generate a range of MIDI notes.
 *
 * note_range(:c3, :c5) → Ring([48, 49, 50, ..., 72])
 */
export function note_range(low: string | number, high: string | number): Ring<number> {
  const lo = noteToMidi(low)
  const hi = noteToMidi(high)
  const notes: number[] = []
  const maxNotes = 10_000
  for (let n = lo; n <= hi && notes.length < maxNotes; n++) {
    notes.push(n)
  }
  if (notes.length >= maxNotes) {
    console.warn('[SonicPi] note_range capped at 10000 notes')
  }
  return new Ring(notes)
}

/**
 * Return the chord built on the Nth degree of a scale.
 *
 * chord_degree(:i, :c4, :major)  → ring(60, 64, 67, 71)   # C maj 7
 * chord_degree(:i, :a3, :major)  → ring(57, 61, 64, 68)   # A maj 7
 *
 * Sonic Pi uses Roman numeral symbols (:i through :vii).
 * We also accept 1-based integer degrees for convenience.
 *
 * Default chord size is **4** (diatonic 7th chord), matching desktop Sonic Pi
 * — see `lib/sonicpi/lang/western_theory.rb:900` `number_of_notes=4` and the
 * desktop docstring line 920: "Taking four notes is the default. This gives
 * us 7th chords - here it plays a C major 7." Pass an explicit `3` to get
 * triads. (#355)
 */
export function chord_degree(
  degreeVal: string | number,
  root: string | number,
  scaleType: string = 'major',
  chordNumNotes: number = 4
): Ring<number> {
  const idx = parseDegree(degreeVal)
  const scaleNotes = scale(root, scaleType)
  const scaleIntervals = SCALE_TYPES[scaleType] ?? SCALE_TYPES['major']
  const len = scaleIntervals.length
  if (idx < 0 || idx >= len) {
    console.warn(`[SonicPi] chord_degree index ${idx} out of range for scale ${scaleType}`)
    return chord(root, 'major')
  }
  // Build chord by stacking scale degrees (thirds by default)
  const rootMidi = noteToMidi(root) + scaleIntervals[idx]
  const notes: number[] = [rootMidi]
  for (let i = 1; i < chordNumNotes; i++) {
    const degIdx = (idx + i * 2) % len
    const octOffset = Math.floor((idx + i * 2) / len) * 12
    notes.push(noteToMidi(root) + scaleIntervals[degIdx] + octOffset)
  }
  return new Ring(notes)
}

/**
 * Return the MIDI note at a given degree of a scale.
 *
 * degree(:ii, :c4, :major) → 62 (D4)
 */
export function degree(
  degreeVal: string | number,
  root: string | number,
  scaleType: string = 'major'
): number {
  const idx = parseDegree(degreeVal)
  const scaleIntervals = SCALE_TYPES[scaleType] ?? SCALE_TYPES['major']
  const len = scaleIntervals.length
  const octOffset = Math.floor(idx / len) * 12
  const degIdx = ((idx % len) + len) % len
  return noteToMidi(root) + scaleIntervals[degIdx] + octOffset
}

/** Parse a Roman numeral or integer degree to a 0-based index. */
function parseDegree(d: string | number): number {
  if (typeof d === 'number') return d - 1
  const roman: Record<string, number> = {
    i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6,
  }
  return roman[d.toLowerCase()] ?? 0
}

/**
 * List available chord type names.
 */
export function chord_names(): string[] {
  return Object.keys(CHORD_TYPES)
}

/**
 * List available scale type names.
 */
export function scale_names(): string[] {
  return Object.keys(SCALE_TYPES)
}
