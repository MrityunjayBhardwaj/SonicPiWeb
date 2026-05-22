const SEMITONES_PER_OCTAVE = 12
/** MIDI number of A4 — the tuning reference. */
const A4_MIDI = 69
/** Concert pitch of A4 in Hz. */
const A4_FREQ_HZ = 440
/** MIDI number of middle C (C4) — used as fallback when a note name can't be parsed. */
const MIDDLE_C_MIDI = 60
/** Default octave when none is specified in a note name (e.g. "c" → "c4"). */
const DEFAULT_OCTAVE = 4

const NOTE_NAMES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
}

/**
 * Strict note resolution: returns NaN for an unparseable note name instead of
 * falling back to middle C. Callers that must distinguish "the user typed
 * garbage" from "the user typed middle C" (e.g. play's dispatch guard, B4 #388)
 * use this; everything else uses `noteToMidi`, which keeps the lenient fallback.
 */
export function noteToMidiStrict(note: string | number): number {
  if (typeof note === 'number') return note

  const str = note.toLowerCase().trim()

  // Try parsing as plain number (e.g. "60", and "" → 0, matching prior behavior).
  const num = Number(str)
  if (!isNaN(num)) return num

  const match = str.match(/^([a-g])(s|b|#)?(\d+)?$/)
  if (!match) return NaN

  const [, letter, accidental, octaveStr] = match
  const base = NOTE_NAMES[letter]
  const octave = octaveStr !== undefined ? parseInt(octaveStr) : DEFAULT_OCTAVE
  // MIDI octave numbering: C4 = 60, so offset = (octave + 1) * 12
  let midi = (octave + 1) * SEMITONES_PER_OCTAVE + base

  if (accidental === 's' || accidental === '#') midi += 1
  if (accidental === 'b') midi -= 1

  return midi
}

/**
 * Convert a note name like "c4", "fs3", "eb5" to a MIDI number.
 * Also accepts bare MIDI numbers as strings or numbers.
 * Falls back to middle C (60) when a note name can't be parsed — preserves the
 * lenient behavior relied on by chord/scale/control helpers. Use
 * `noteToMidiStrict` where an unparseable name must be detectable.
 */
export function noteToMidi(note: string | number): number {
  const midi = noteToMidiStrict(note)
  return Number.isNaN(midi) ? MIDDLE_C_MIDI : midi
}

/**
 * Convert MIDI number to frequency in Hz.
 * A4 (MIDI 69) = 440 Hz.
 */
export function midiToFreq(midi: number): number {
  return A4_FREQ_HZ * Math.pow(2, (midi - A4_MIDI) / SEMITONES_PER_OCTAVE)
}

/**
 * Convert frequency in Hz to MIDI note number.
 * 440 Hz → 69 (A4).
 */
export function hzToMidi(freq: number): number {
  return SEMITONES_PER_OCTAVE * Math.log2(freq / A4_FREQ_HZ) + A4_MIDI
}

/**
 * Convert note name or number directly to frequency.
 */
export function noteToFreq(note: string | number): number {
  return midiToFreq(noteToMidi(note))
}

const PITCH_CLASS_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']

/**
 * SonicPi::Note-like object returned by `note_info`. Mirrors Ruby's
 * method-call semantics — Sonic Pi user code writes `.midi_note` (a method
 * call without parens), and our TreeSitter transpiler emits `.midi_note()`.
 */
export class NoteInfo {
  private _midi: number
  constructor(midi: number) {
    this._midi = midi
  }
  midi_note(): number {
    return this._midi
  }
  octave(): number {
    return Math.floor(Math.round(this._midi) / 12) - 1
  }
  pitch_class(): string {
    return PITCH_CLASS_NAMES[((Math.round(this._midi) % 12) + 12) % 12]
  }
  to_s(): string {
    return `${this.pitch_class()}${this.octave()}`
  }
}

/**
 * Sonic Pi's `note_info(name_or_midi)` — returns a NoteInfo with method
 * accessors `.midi_note()`, `.octave()`, `.pitch_class()`, `.to_s()`.
 */
export function noteInfo(n: string | number): NoteInfo {
  return new NoteInfo(noteToMidi(n))
}
