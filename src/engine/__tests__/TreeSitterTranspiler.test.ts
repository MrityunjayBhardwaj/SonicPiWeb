/**
 * TreeSitterTranspiler tests — validates the catamorphism over the Ruby grammar.
 *
 * Uses WASM files from node_modules (not public/) for test-time loading.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initTreeSitter, treeSitterTranspile, isTreeSitterReady, autoTranspile } from '../TreeSitterTranspiler'
import { ProgramBuilder } from '../ProgramBuilder'
import { ring } from '../Ring'
import { spread } from '../EuclideanRhythm'
import { chord, scale, chord_invert, note, note_range } from '../ChordScale'
import { noteToMidi, midiToFreq, noteToFreq } from '../NoteToFreq'
import { Ring } from '../Ring'

// Runtime operator helpers — same logic as Sandbox polyfills but as importable functions.
const __spNoteRe = /^[a-g][sb#]?\d*$/
function __spIsNote(v: unknown): v is string { return typeof v === 'string' && __spNoteRe.test(v) }
function __spToNum(v: unknown): unknown { return __spIsNote(v) ? note(v) : v }
function __spIsRing(v: unknown): boolean { return v != null && typeof v === 'object' && typeof (v as any).toArray === 'function' && typeof (v as any).tick === 'function' }
function __spAdd(a: unknown, b: unknown): unknown {
  if (a == null || b == null) return null
  a = __spToNum(a); b = __spToNum(b)
  if (__spIsRing(a) && __spIsRing(b)) return (a as Ring<any>).concat(b as Ring<any>)
  if (__spIsRing(a) && Array.isArray(b)) return (a as Ring<any>).concat(b)
  if (typeof a === 'number' && Array.isArray(b)) return b.map(x => (a as number) + x)
  if (Array.isArray(a) && typeof b === 'number') return a.map(x => x + (b as number))
  if (typeof a === 'number' && __spIsRing(b)) return ring(...(b as Ring<number>).toArray().map(x => (a as number) + x))
  if (__spIsRing(a) && typeof b === 'number') return ring(...(a as Ring<number>).toArray().map(x => x + (b as number)))
  return (a as number) + (b as number)
}
function __spSub(a: unknown, b: unknown): unknown {
  if (a == null || b == null) return null
  a = __spToNum(a); b = __spToNum(b)
  if (typeof a === 'number' && Array.isArray(b)) return b.map(x => (a as number) - x)
  if (Array.isArray(a) && typeof b === 'number') return a.map(x => x - (b as number))
  if (typeof a === 'number' && __spIsRing(b)) return ring(...(b as Ring<number>).toArray().map(x => (a as number) - x))
  if (__spIsRing(a) && typeof b === 'number') return ring(...(a as Ring<number>).toArray().map(x => x - (b as number)))
  return (a as number) - (b as number)
}
function __spMul(a: unknown, b: unknown): unknown {
  if (__spIsRing(a) && typeof b === 'number') return (a as Ring<any>).repeat(b)
  if (typeof a === 'number' && __spIsRing(b)) return (b as Ring<any>).repeat(a)
  return (a as number) * (b as number)
}
// Resolve WASM paths for Node.js test environment
const base = new URL('../../..', import.meta.url).pathname
const tsWasm = base + 'node_modules/web-tree-sitter/tree-sitter.wasm'
const rubyWasm = base + 'node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm'

/** Strip whitespace variations for test comparison. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('TreeSitterTranspiler', () => {
  beforeAll(async () => {
    const ok = await initTreeSitter({
      treeSitterWasmUrl: tsWasm,
      rubyWasmUrl: rubyWasm,
    })
    expect(ok).toBe(true)
    expect(isTreeSitterReady()).toBe(true)
  })

  describe('Task 1: Setup & Prototype', () => {
    it('parses and transpiles a basic live_loop', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const result = treeSitterTranspile(ruby)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('live_loop("drums"')
      expect(result.code).toContain('b.sample("bd_haus"')
      expect(result.code).toContain('b.sleep(0.5)')
    })

    it('output is valid JS (can be parsed by new Function)', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`
      const result = treeSitterTranspile(ruby)
      expect(result.ok).toBe(true)
      expect(() => new Function(result.code)).not.toThrow()
    })
  })

  describe('Literals', () => {
    it('transpiles symbols to strings', () => {
      const result = treeSitterTranspile(`live_loop :test do
  sample :bd_haus
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('"bd_haus"')
    })

    it('transpiles nil to null', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = nil
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('null')
    })
  })

  describe('DSL functions', () => {
    it('play with note and opts', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play 60, release: 0.3, amp: 0.8
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.play(60')
      expect(result.code).toContain('release: 0.3')
      expect(result.code).toContain('amp: 0.8')
    })

    it('use_synth outside loop has no b. prefix', () => {
      const result = treeSitterTranspile(`use_synth :prophet
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_synth("prophet")')
      // Inside the loop, play gets b. prefix
      expect(result.code).toContain('b.play(60')
    })

    // #419 / SV55 — a top-level `use_synth :X` placed BEFORE a `live_loop`
    // must make that loop register with synth :X, even when bare top-level
    // code FOLLOWS the loop (which triggers the __run_once split and defers
    // use_synth into the wrapper, leaving the loop to register with :beep).
    // Desktop parity: in_thread/live_loop snapshots `current_synth` at its
    // source position in sequential order (runtime.rb:1067). The transpiler
    // restores this by emitting an EAGER top-level use_synth("X") (routes to
    // topLevelUseSynth → defaultSynth) immediately before the loop registers.
    describe('#419 / SV55: top-level use_synth honored by live_loop with trailing bare code', () => {
      // Helper: index of an eager (no `__b.`/`b.` prefix) top-level call.
      const eagerIdx = (code: string, call: string) => {
        const re = new RegExp(`(^|[^.\\w])${call.replace(/[()]/g, '\\$&')}`, 'm')
        const m = re.exec(code)
        return m ? m.index : -1
      }

      it('T-A: emits eager use_synth("saw") before live_loop("s") (the bug)', () => {
        const result = treeSitterTranspile(`use_synth :saw
live_loop :s do
  play :E3
  sleep 1
end
sleep 5`)
        expect(result.ok).toBe(true)
        const loopIdx = result.code.indexOf('live_loop("s"')
        const sawIdx = eagerIdx(result.code, 'use_synth("saw")')
        expect(sawIdx).toBeGreaterThanOrEqual(0)
        expect(loopIdx).toBeGreaterThanOrEqual(0)
        // Eager (top-level) use_synth must precede the loop registration.
        expect(sawIdx).toBeLessThan(loopIdx)
      })

      it('T-B: multi-loop — each loop prefixed with its source-order synth', () => {
        const result = treeSitterTranspile(`use_synth :saw
live_loop :a do
  play 60
  sleep 1
end
use_synth :tb303
live_loop :b do
  play 64
  sleep 1
end
sleep 5`)
        expect(result.ok).toBe(true)
        const aIdx = result.code.indexOf('live_loop("a"')
        const bIdx = result.code.indexOf('live_loop("b"')
        const sawIdx = result.code.indexOf('use_synth("saw")\nlive_loop("a"')
        const tbIdx = result.code.indexOf('use_synth("tb303")\nlive_loop("b"')
        // saw prefixes loop a, tb303 prefixes loop b (in source order).
        expect(sawIdx).toBeGreaterThanOrEqual(0)
        expect(tbIdx).toBeGreaterThanOrEqual(0)
        expect(sawIdx).toBeLessThan(aIdx)
        expect(tbIdx).toBeLessThan(bIdx)
        expect(aIdx).toBeLessThan(tbIdx)
      })

      it('T-C: loop BEFORE use_synth is NOT prefixed (snapshot is forward-only)', () => {
        const result = treeSitterTranspile(`live_loop :a do
  play 60
  sleep 1
end
use_synth :saw
sleep 5`)
        expect(result.ok).toBe(true)
        // No eager use_synth("saw") should precede live_loop("a").
        expect(result.code).not.toContain('use_synth("saw")\nlive_loop("a"')
        const loopIdx = result.code.indexOf('live_loop("a"')
        const sawEager = eagerIdx(result.code, 'use_synth("saw")')
        // Either no eager use_synth at all, or it comes AFTER the loop.
        expect(sawEager === -1 || sawEager > loopIdx).toBe(true)
      })

      it('T-D: non-literal use_synth arg → no eager prefix, no crash', () => {
        const result = treeSitterTranspile(`use_synth foo
live_loop :a do
  play 60
  sleep 1
end
sleep 5`)
        expect(result.ok).toBe(true)
        // foo is not a literal symbol/string — cannot resolve at build time.
        expect(result.code).not.toContain('use_synth("foo")')
        expect(result.code).not.toContain('use_synth(foo)\nlive_loop("a"')
        // Output must still be valid JS.
        expect(() => new Function(result.code)).not.toThrow()
      })

      it('T-E (engine): live_loop registers with currentSynth = source-order synth', () => {
        const code = autoTranspile(`use_synth :saw
live_loop :s do
  play :E3
  sleep 1
end
sleep 5`)
        // Minimal harness mirroring SonicPiEngine: live_loop reads the synth
        // in effect (defaultSynth) at registration time (SonicPiEngine.ts:879).
        const registrations: Record<string, string> = {}
        let defaultSynth = 'beep'
        const use_synth = (name: string) => { defaultSynth = name }
        const use_bpm = (_n: number) => {}
        const live_loop = (name: string, _fn: unknown) => {
          // Capture synth at registration — do NOT invoke the body (the real
          // builderFn runs per-iteration, not at registration).
          registrations[name] = defaultSynth
        }
        const fn = new Function('use_synth', 'use_bpm', 'live_loop',
          `return (async () => {\n${code}\n})();`)
        return fn(use_synth, use_bpm, live_loop).then(() => {
          expect(registrations['s']).toBe('saw')
        })
      })

      it('T-F (regression SP36/#164): bare-play interleave preserved inside __run_once', () => {
        const result = treeSitterTranspile(`use_synth :saw
play 60
use_synth :beep
play 64
sleep 1`)
        expect(result.ok).toBe(true)
        // No live_loop blocks here → no eager hoist; both use_synth stay
        // inline (as __b.use_synth) in source order inside __run_once.
        const code = result.code
        const s1 = code.indexOf('__b.use_synth("saw")')
        const p1 = code.indexOf('__b.play(60')
        const s2 = code.indexOf('__b.use_synth("beep")')
        const p2 = code.indexOf('__b.play(64')
        expect(s1).toBeGreaterThanOrEqual(0)
        expect(s1).toBeLessThan(p1)
        expect(p1).toBeLessThan(s2)
        expect(s2).toBeLessThan(p2)
        // And no eager top-level use_synth hoisted above the wrapper.
        const wrapperStart = code.indexOf('live_loop("__run_once"')
        expect(eagerIdx(code.slice(0, wrapperStart), 'use_synth(')).toBe(-1)
      })

      it('T-G (regression SP72): use_synth inside in_thread does NOT leak to eager top-level', () => {
        const result = treeSitterTranspile(`in_thread do
  use_synth :tb303
  live_loop :inner do
    play 60
    sleep 1
  end
end
sleep 5`)
        expect(result.ok).toBe(true)
        // use_synth is inside the in_thread body (emitted as __b.use_synth),
        // not top-level → no EAGER top-level use_synth("tb303") emitted (the
        // SP72 parentBuilder path owns this inheritance, not the eager prefix).
        const eagerTb = eagerIdx(result.code, 'use_synth("tb303")')
        expect(eagerTb).toBe(-1)
      })
    })

    // Regression for #163 — `synth :NAME, note: 60` used to transpile to
    // `__b.play({ synth: "NAME", note: 60 })`, which ProgramBuilder.play
    // treated as (noteVal=object, opts=undefined). Result: the options
    // hash coerced to "[object Object]" as the note, and the synth fell
    // through to currentSynth ("beep"). Every `synth :NAME` call silently
    // dispatched as beep.
    it('synth :NAME, note: N promotes note to first positional arg', () => {
      const result = treeSitterTranspile(`synth :saw, note: 60, amp: 0.5`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__b.play(60, { synth: "saw", amp: 0.5 })')
      // Must NOT emit the bug form where the options object is the first arg.
      expect(result.code).not.toMatch(/__b\.play\(\{/)
    })

    it('synth :NAME with no note defaults to MIDI 52', () => {
      const result = treeSitterTranspile(`synth :saw`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__b.play(52, { synth: "saw" })')
    })

    it('synth :NAME inside a loop uses the loop\'s __b', () => {
      const result = treeSitterTranspile(`live_loop :t do
  synth :prophet, note: 67, release: 0.3
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__b.play(67, { synth: "prophet", release: 0.3 })')
    })

    // Regression for #164 — top-level `use_synth` was hoisted via
    // TOP_LEVEL_SETTINGS above the bare-code wrapper, which collapsed all
    // plays to the last hoisted use_synth value. It must now flow inline
    // with the plays inside the __run_once live_loop so ordering is
    // preserved.
    it('top-level use_synth does NOT hoist above bare code', () => {
      const result = treeSitterTranspile(`use_synth :saw
play 60
use_synth :prophet
play 60`)
      expect(result.ok).toBe(true)
      // Both use_synth calls must appear inside the run_once wrapper,
      // interleaved with the plays.
      const code = result.code
      const wrapperStart = code.indexOf('live_loop("__run_once"')
      expect(wrapperStart).toBeGreaterThanOrEqual(0)
      const before = code.slice(0, wrapperStart)
      const inside = code.slice(wrapperStart)
      expect(before).not.toContain('use_synth("saw")')
      expect(before).not.toContain('use_synth("prophet")')
      expect(inside).toContain('use_synth("saw")')
      expect(inside).toContain('use_synth("prophet")')
      // Order: saw before first play, prophet before second play.
      const sawIdx = inside.indexOf('use_synth("saw")')
      const firstPlayIdx = inside.indexOf('play(60', sawIdx)
      const prophetIdx = inside.indexOf('use_synth("prophet")', firstPlayIdx)
      const secondPlayIdx = inside.indexOf('play(60', prophetIdx)
      expect(sawIdx).toBeLessThan(firstPlayIdx)
      expect(firstPlayIdx).toBeLessThan(prophetIdx)
      expect(prophetIdx).toBeLessThan(secondPlayIdx)
    })

    it('top-level use_bpm still hoists (commutative with position)', () => {
      const result = treeSitterTranspile(`use_bpm 120
play 60
play 64`)
      expect(result.ok).toBe(true)
      const code = result.code
      const wrapperStart = code.indexOf('live_loop("__run_once"')
      expect(wrapperStart).toBeGreaterThanOrEqual(0)
      const before = code.slice(0, wrapperStart)
      // use_bpm is in TOP_LEVEL_SETTINGS so it hoists above the wrapper
      expect(before).toContain('use_bpm(120)')
    })

    it('use_bpm', () => {
      const result = treeSitterTranspile(`use_bpm 120
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_bpm(120)')
    })

    it('sync and cue', () => {
      const result = treeSitterTranspile(`live_loop :a do
  cue :tick
  sleep 1
end
live_loop :b do
  sync :tick
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.cue("tick")')
      expect(result.code).toContain('b.sync("tick")')
    })

    it('ring and tick', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play (ring 60, 64, 67).tick
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__b.ring(60, 64, 67)')
      expect(result.code).toContain('.at(__b.tick())')
    })

    it('scale and choose', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play scale(:c4, :minor_pentatonic).choose
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.scale("c4", "minor_pentatonic")')
      expect(result.code).toContain('b.choose(')
    })

    it('rrand', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play rrand(50, 80)
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.rrand(50, 80)')
    })

    it('spread pattern', () => {
      const result = treeSitterTranspile(`live_loop :t do
  pattern = spread(5, 8)
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.spread(5, 8)')
    })
  })

  describe('Control flow', () => {
    it('if statement', () => {
      const result = treeSitterTranspile(`live_loop :t do
  if one_in(3)
    sample :drum_heavy_kick
  end
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('b.one_in(3)')
    })

    it('trailing if modifier', () => {
      const result = treeSitterTranspile(`live_loop :t do
  sample :bd_haus if one_in(2)
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('b.sample("bd_haus"')
    })

    it('unless modifier', () => {
      const result = treeSitterTranspile(`live_loop :t do
  sample :bd_haus unless one_in(4)
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('!(')
    })

    it('case/when', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = rrand_i(1, 3)
  case x
  when 1
    play 60
  when 2
    play 64
  when 3
    play 67
  end
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('else if')
    })
  })

  describe('Blocks', () => {
    it('with_fx', () => {
      const result = treeSitterTranspile(`live_loop :t do
  with_fx :reverb, room: 0.8 do
    play 60
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.with_fx("reverb"')
      expect(result.code).toContain('room: 0.8')
    })

    it('N.times do', () => {
      const result = treeSitterTranspile(`live_loop :t do
  4.times do
    play 60
    sleep 0.25
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('for (let')
      expect(result.code).toContain('< 4')
      expect(result.code).toContain('b.__checkBudget__()')
    })

    it('.each do |n|', () => {
      const result = treeSitterTranspile(`live_loop :t do
  [60, 64, 67].each do |n|
    play n
    sleep 0.25
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('for (const n of')
      expect(result.code).toContain('b.__checkBudget__()')
    })

    it('.each_with_index do |item, i| (#154)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  [:c4, :e4, :g4].each_with_index do |n, i|
    play n, amp: i * 0.3
    sleep 0.25
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('for (let i = 0;')
      expect(result.code).toContain('const n =')
      expect(result.code).toContain('b.__checkBudget__()')
    })

    it('.zip(other) (#154)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  notes = [60, 64, 67]
  durations = [0.5, 0.25, 1]
  pairs = notes.zip(durations)
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('.map(')
      expect(result.code).toContain('?? null')
    })

    it('in_thread', () => {
      const result = treeSitterTranspile(`live_loop :t do
  in_thread do
    play 60
    sleep 1
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.in_thread(')
    })

    // Issue #205: `loop do` inside in_thread used to emit `while(true) { __b.play; __b.sleep }`
    // whose sleep reset ProgramBuilder's budget guard → infinite Step[] push at build time
    // → tab OOM. Fix hoists the inner loop to a sibling auto-named live_loop.
    it('hoists loop do inside in_thread to sibling live_loop (no build-time while(true))', () => {
      const result = treeSitterTranspile(`in_thread do
  loop do
    sample :bd_ada
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      // Must hoist — no build-time while(true) lurking in the in_thread body
      expect(result.code).not.toContain('while (true)')
      expect(result.code).toContain('live_loop("__inthread_loop_0"')
    })

    it('keeps setup statements before loop in in_thread; hoists the loop', () => {
      const result = treeSitterTranspile(`in_thread do
  use_synth :saw
  loop do
    play 60
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).not.toContain('while (true)')
      expect(result.code).toContain('in_thread(')
      expect(result.code).toContain('live_loop("__inthread_loop_0"')
    })

    it('define with block params', () => {
      const result = treeSitterTranspile(`define :bass_hit do
  sample :bd_haus, amp: 2
end

live_loop :groove do
  bass_hit
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('function bass_hit(__b)')
      // Call to defined function should inject __b
      expect(result.code).toContain('bass_hit(__b)')
    })

    it('ndefine produces same JS function decl as define (#211)', () => {
      const result = treeSitterTranspile(`ndefine :hit do
  play 60
end

live_loop :run do
  hit
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('function hit(__b)')
      expect(result.code).toContain('hit(__b)')
    })
  })

  describe('Expressions', () => {
    it('variable assignment', () => {
      const result = treeSitterTranspile(`live_loop :t do
  n = 60
  play n
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('n = 60')
    })

    it('binary operators', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play 60 + 12
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__spAdd(60, 12)')
    })

    it('string interpolation', () => {
      const result = treeSitterTranspile(`live_loop :t do
  n = 60
  puts "playing #{n}"
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('`playing ${n}`')
    })

    it('array access', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = [60, 64, 67]
  play x[0]
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('x[0]')
    })
  })

  describe('Comments', () => {
    it('full-line comment', () => {
      const result = treeSitterTranspile(`# This is a comment
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('//')
    })
  })

  describe('Advanced constructs', () => {
    it('define with default parameters', () => {
      const result = treeSitterTranspile(`define :ocean do |num, amp_mul=1|
  num.times do
    play 60, amp: amp_mul
    sleep 1
  end
end

live_loop :t do
  ocean 3
  sleep 4
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('function ocean(__b, num, amp_mul = 1)')
    })

    it('begin/rescue', () => {
      const result = treeSitterTranspile(`live_loop :t do
  begin
    play 60
    sleep 0.5
  rescue
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('try {')
      expect(result.code).toContain('catch')
    })

    it('live_loop with sync option', () => {
      const result = treeSitterTranspile(`live_loop :kick, sync: :met1 do
  sample :bd_haus
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('live_loop("kick", {sync: "met1"}')
      expect(result.code).not.toContain('b.sync("met1")')
    })

    it('nested with_fx', () => {
      const result = treeSitterTranspile(`live_loop :t do
  with_fx :reverb do
    with_fx :echo do
      play 60
      sleep 1
    end
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.with_fx("reverb"')
      expect(result.code).toContain('b.with_fx("echo"')
    })

    it('use_synth_defaults', () => {
      const result = treeSitterTranspile(`live_loop :t do
  use_synth_defaults mod_phase: 0.125, pulse_width: 0.8
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_synth_defaults(')
      expect(result.code).toContain('mod_phase: 0.125')
    })

    it('control with node ref', () => {
      const result = treeSitterTranspile(`live_loop :t do
  s = play 60, release: 4, note_slide: 1
  sleep 1
  control s, note: 65
  sleep 3
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.play(')
      expect(result.code).toContain('b.control(')
    })

    it('kill inside live_loop emits b.kill(ref) (#225)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  n = play 60, sustain: 10
  sleep 0.5
  kill n
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.play(')
      expect(result.code).toContain('b.kill(')
    })

    it('bare-code kill triggers run-once wrapper (#225)', () => {
      const result = treeSitterTranspile(`n = play 60, sustain: 10
sleep 0.5
kill n`)
      expect(result.ok).toBe(true)
      // BARE_DSL_CALLS routes bare top-level usage through the synthetic
      // live_loop :__run_once wrapper so kill resolves to __b.kill.
      expect(result.code).toContain('__run_once')
      expect(result.code).toContain('.kill(')
    })

    it('PRNG inspection inside live_loop routes via __b (#227)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  use_random_seed 42
  puts current_random_seed
  rand_skip 3
  rand_back 1
  rand_reset
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/\.current_random_seed\(\)/)
      expect(result.code).toMatch(/\.rand_skip\(/)
      expect(result.code).toMatch(/\.rand_back\(/)
      expect(result.code).toMatch(/\.rand_reset\(\)/)
    })

    it('recording_* inside live_loop routes through __b for deferred timing (#228)', () => {
      // Recording is a deferred step now — must route through __b so the
      // step fires at the scheduled virtual time of the surrounding sleep.
      // Top-level immediate would mis-sequence: recording_save would run
      // before the play+sleep program had executed, leaving lastRecording
      // null.
      const inLoop = treeSitterTranspile(`live_loop :t do
  recording_start
  play 60
  sleep 1
  recording_stop
  recording_save "out.wav"
  recording_delete
end`)
      expect(inLoop.ok).toBe(true)
      expect(inLoop.code).toMatch(/\.recording_start\(/)
      expect(inLoop.code).toMatch(/\.recording_stop\(/)
      expect(inLoop.code).toMatch(/\.recording_save\("out.wav"\)/)
      expect(inLoop.code).toMatch(/\.recording_delete\(/)
    })

    it('bare top-level recording_start triggers run-once wrapper so __b is in scope (#228)', () => {
      // BARE_DSL_CALLS contains recording_*, so bare top-level usage
      // wraps the whole script in live_loop :__run_once and emits
      // __b.recording_start. Without this, recording_* would resolve to
      // the dslValues forwarder which itself goes through topLevelBuilder,
      // but the run-once wrapper keeps the lifecycle in lock-step with
      // surrounding `8.times` blocks.
      const result = treeSitterTranspile(`recording_start
8.times do
  play 60
  sleep 0.25
end
recording_stop
recording_save "x.wav"`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__run_once')
      expect(result.code).toMatch(/\.recording_start\(/)
      expect(result.code).toMatch(/\.recording_stop\(/)
      expect(result.code).toMatch(/\.recording_save\("x.wav"\)/)
    })

    it('current_beat / current_time inside live_loop route via __b (#226)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  sleep 1
  puts current_beat
  puts current_time
  puts current_beat_duration
  puts current_sched_ahead_time
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/\.current_beat\(\)/)
      expect(result.code).toMatch(/\.current_time\(\)/)
      expect(result.code).toMatch(/\.current_beat_duration\(\)/)
      expect(result.code).toMatch(/\.current_sched_ahead_time\(\)/)
    })

    it('defonce :name do ... end emits bare-assignment + return on last expr (#233)', () => {
      const result = treeSitterTranspile(`defonce :pad do
  chord(:c, :major)
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/pad = defonce\("pad", \{\}, \(__b\) => \{/)
      expect(result.code).toMatch(/return __b\.chord\("c", "major"\)/)
    })

    it('defonce with override: true forwards opt to runtime (#233)', () => {
      const result = treeSitterTranspile(`defonce :foo, override: true do
  10
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/foo = defonce\("foo", \{ override: true \}, \(__b\) => \{/)
      expect(result.code).toMatch(/return 10/)
    })

    it('tuplets [list], opts do |x| ... end transpiles to __b.tuplets(...) inside live_loop (#233)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  tuplets [70, [72, 72], 70], swing: 0.2 do |n|
    play n
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/\.tuplets\(\[70, \[72, 72\], 70\], \{ swing: 0\.2 \}, \(__b, n\)/)
      expect(result.code).toMatch(/__b\.play\(n,/)
    })

    it('tuplets without opts hash transpiles with empty options object (#233)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  tuplets [60, 62, 64] do |n|
    play n
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/\.tuplets\(\[60, 62, 64\], \{\}, \(__b, n\)/)
    })

    it('current_synth_defaults / current_debug etc. inside live_loop route via __b (#233)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  use_synth_defaults amp: 0.5
  puts current_synth_defaults
  puts current_sample_defaults
  puts current_arg_checks
  puts current_debug
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toMatch(/\.current_synth_defaults\(\)/)
      expect(result.code).toMatch(/\.current_sample_defaults\(\)/)
      expect(result.code).toMatch(/\.current_arg_checks\(\)/)
      expect(result.code).toMatch(/\.current_debug\(\)/)
    })

    it('with_fx at top level (outside live_loop)', () => {
      const result = treeSitterTranspile(`with_fx :reverb, mix: 0.7 do
  live_loop :t do
    play 60
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('with_fx("reverb"')
    })
  })

  describe('Built-in examples compatibility', () => {
    const examples = [
      {
        name: 'Hello Beep',
        code: `play 60
sleep 1
play 64
sleep 1
play 67`,
      },
      {
        name: 'Basic Beat',
        code: `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`,
      },
      {
        name: 'Ambient Pad',
        code: `use_synth :prophet
live_loop :pad do
  play chord(:e3, :minor), release: 4, amp: 0.6
  sleep 4
end`,
      },
      {
        name: 'Arpeggio with tick',
        code: `use_synth :tb303
live_loop :arp do
  play (ring 60, 64, 67, 72).tick, release: 0.2, cutoff: 80
  sleep 0.25
end`,
      },
      {
        name: 'Random Melody',
        code: `use_random_seed 42
live_loop :melody do
  use_synth :pluck
  play scale(:c4, :minor_pentatonic).choose, release: 0.3
  sleep 0.25
end`,
      },
      {
        name: 'FX Chain',
        code: `live_loop :fx_demo do
  with_fx :reverb, room: 0.8 do
    with_fx :distortion, distort: 0.5 do
      play 50, release: 0.5
      sleep 0.5
      play 55, release: 0.5
      sleep 0.5
    end
  end
end`,
      },
      {
        name: 'Minimal Techno',
        code: `use_bpm 130

live_loop :kick do
  sample :bd_haus, amp: 1.5
  sleep 1
end

live_loop :hats do
  pattern = spread(7, 16)
  16.times do |i|
    sample :hat_snap, amp: 0.4 if pattern[i]
    sleep 0.25
  end
end

live_loop :acid do
  use_synth :tb303
  notes = ring(:e2, :e2, :e3, :e2, :g2, :e2, :a2, :e2)
  play notes.tick, release: 0.2, cutoff: rrand(40, 120), res: 0.3
  sleep 0.25
end`,
      },
    ]

    for (const ex of examples) {
      it(`transpiles "${ex.name}" to valid JS`, () => {
        const result = treeSitterTranspile(ex.code)
        expect(result.ok).toBe(true)
        expect(result.errors).toEqual([])
        expect(() => new Function(result.code)).not.toThrow()
      })
    }
  })

  describe('Community programs (stress test)', () => {
    const communityPrograms = [
      {
        name: 'Blockgame (excerpt)',
        code: `use_bpm 130
live_loop :met1 do
  sleep 1
end
cmaster1 = 130
define :pattern do |pattern|
  return pattern.ring.at(b.tick()) == "x"
end
live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern("x--x--x---x--x--")
  sleep 0.25
end
with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sleep 1
    end
  end
end`,
      },
      {
        name: 'Sonic Dreams (excerpt)',
        code: `use_debug false
define :ocean do |num, amp_mul=1|
  num.times do
    s = synth [:bnoise, :cnoise, :gnoise].choose, amp: rrand(0.5, 1.5) * amp_mul, attack: rrand(0, 1), sustain: rrand(0, 2), release: rrand(0, 5) + 0.5, cutoff: rrand(60, 100), pan: rrand(-1, 1)
    control s, pan: rrand(-1, 1), cutoff: rrand(60, 110)
    sleep rrand(0.5, 4)
  end
end
uncomment do
  use_random_seed 1000
  with_bpm 45 do
    with_fx :reverb do
      with_fx :echo, delay: 0.5, decay: 4 do
        in_thread do
          use_random_seed 2
          ocean 5
          ocean 1, 0.5
        end
        sleep 10
      end
    end
  end
end`,
      },
      {
        name: 'Cloud Beat (excerpt)',
        code: `use_bpm 100
live_loop :hiss_loop do
  sample :vinyl_hiss, amp: 2
  sleep sample_duration(:vinyl_hiss)
end
define :hihat do
  use_synth :pnoise
  with_fx :hpf, cutoff: 120 do
    play release: 0.01, amp: 13
  end
end
live_loop :hihat_loop do
  divisors = ring(2, 4, 2, 2, 2, 2, 2, 6)
  divisors.tick.times do
    hihat
    sleep 1.0 / divisors.look
  end
end
define :bassdrum do |note1, duration, note2=note1|
  use_synth :sine
  with_fx :hpf, cutoff: 100 do
    play note1 + 24, amp: 40, release: 0.01
  end
  with_fx :distortion, distort: 0.1, mix: 0.3 do
    with_fx :lpf, cutoff: 26 do
      with_fx :hpf, cutoff: 55 do
        bass = play note1, amp: 85, release: duration, note_slide: duration
        control bass, note: note2
      end
    end
  end
  sleep duration
end
live_loop :bassdrum_schleife do
  bassdrum 36, 1.5
  bassdrum 36, 1.5
  bassdrum 36, 1.0
end`,
      },
      {
        name: 'Shufflit (excerpt)',
        code: `use_debug false
use_random_seed 667
live_loop :travelling do
  use_synth :beep
  notes = scale(:e3, :minor_pentatonic, num_octaves: 1)
  use_random_seed 679
  tick_reset_all
  with_fx :echo, phase: 0.125, mix: 0.4, reps: 16 do
    sleep 0.25
    play notes.choose, attack: 0, release: 0.1, amp: rrand(2, 2.5)
  end
end`,
      },
      {
        name: 'Hip Hop Beat',
        code: `use_bpm 90
live_loop :biitti do
  sample :bd_808, rate: 1, amp: 4
  sleep 1
  sample :elec_hi_snare, amp: 1
  sleep 1
end
live_loop :ujellus do
  with_fx :echo, phase: 1.5, mix: 0.5 do
    use_synth :mod_beep
    use_synth_defaults mod_phase: 0.125, pulse_width: 0.8, mod_wave: 2, attack: 1
    play :G5
    sleep 8
  end
end
live_loop :hihat do
  16.times do
    sample :drum_cymbal_pedal, start: 0.05, finish: 0.4, rate: 3, amp: 0.5 + rrand(-0.1, 0.1)
    sleep 0.125
  end
end`,
      },
      {
        name: 'Tilburg 2 (excerpt)',
        code: `use_debug false
live_loop :low do
  tick
  synth :zawa, wave: 1, phase: 0.25, release: 5, note: (knit(:e1, 12, :c1, 4)).look, cutoff: (line(60, 120, steps: 6)).look
  sleep 4
end
with_fx :reverb, room: 1 do
  live_loop :lands do
    use_synth :dsaw
    use_random_seed 310003
    ns = scale(:e2, :minor_pentatonic, num_octaves: 4).take(4)
    16.times do
      play ns.choose, detune: 12, release: 0.1, amp: 2, cutoff: rrand(70, 120)
      sleep 0.125
    end
  end
end
live_loop :tijd do
  sample :bd_haus, amp: 2.5, cutoff: 100
  sleep 0.5
end`,
      },
    ]

    for (const prog of communityPrograms) {
      it(`transpiles "${prog.name}" to valid JS`, () => {
        const result = treeSitterTranspile(prog.code)
        if (!result.ok) {
          console.error(`[${prog.name}] Errors:`, result.errors)
          console.error(`[${prog.name}] Output:\n${result.code}`)
        }
        expect(result.ok).toBe(true)
        expect(() => new Function(result.code)).not.toThrow()
      })
    }
  })

  describe('Semantic execution (tier 2 — runs against ProgramBuilder)', () => {
    /**
     * Execute transpiled code against a real ProgramBuilder and return
     * the program steps. This catches runtime crashes from calling
     * non-existent methods, wrong argument shapes, etc.
     */
    function executeTranspiled(ruby: string): { steps: any[]; error?: string } {
      const result = treeSitterTranspile(ruby)
      if (!result.ok) return { steps: [], error: result.errors[0] }

      try {
        // Set up a minimal execution scope matching SonicPiEngine.evaluate()
        // eslint-disable-next-line prefer-const -- assigned inside new Function callback
        let capturedBuilderFn: ((b: ProgramBuilder) => void) | null = null as ((b: ProgramBuilder) => void) | null
        const live_loop = (_name: string, fn: (b: ProgramBuilder) => void) => {
          capturedBuilderFn = fn
        }
        const use_bpm = (_bpm: number) => {}
        const use_synth = (_name: string) => {}
        const use_random_seed = (_seed: number) => {}
        const puts = (..._args: unknown[]) => {}
        const stop = () => {}
        const stop_loop = (_name: string) => {}
        const set = (_k: string, _v: unknown) => {}
        const get = new Proxy({}, { get: () => null })
        const in_thread = (fn: (b: ProgramBuilder) => void) => fn(new ProgramBuilder())
        const at = (_t: number[], _v: unknown, _fn: any) => {}
        const density = (_n: number, _fn: any) => {}
        const with_fx = (_name: string, ...args: any[]) => {
          const fn = args[args.length - 1]
          if (typeof fn === 'function') fn(new ProgramBuilder())
        }
        const sample_duration = () => 1
        const sample_names = () => []
        const sample_groups = () => []
        const sample_loaded = () => false
        // No-op define stub — the transpiler now emits `define(name, fn)` after
        // the function decl (#215). This harness doesn't need persistence; it
        // just needs the call to succeed.
        const define = (_name: string, _fn: unknown) => {}

        // Execute the transpiled code in the scope
        const fn = new Function(
          'live_loop', 'use_bpm', 'use_synth', 'use_random_seed',
          'puts', 'stop', 'stop_loop', 'set', 'get',
          'in_thread', 'at', 'density', 'with_fx',
          'ring', 'spread', 'chord', 'scale', 'chord_invert', 'note', 'note_range',
          'noteToMidi', 'midiToFreq', 'noteToFreq',
          'sample_duration', 'sample_names', 'sample_groups', 'sample_loaded',
          '__spAdd', '__spSub', '__spMul', 'define',
          result.code,
        )
        fn(
          live_loop, use_bpm, use_synth, use_random_seed,
          puts, stop, stop_loop, set, get,
          in_thread, at, density, with_fx,
          ring, spread, chord, scale, chord_invert, note, note_range,
          noteToMidi, midiToFreq, noteToFreq,
          sample_duration, sample_names, sample_groups, sample_loaded,
          __spAdd, __spSub, __spMul, define,
        )

        if (!capturedBuilderFn) return { steps: [], error: 'No live_loop captured' }

        const builder = new ProgramBuilder(42)
        capturedBuilderFn(builder)
        return { steps: builder.build() }
      } catch (e: any) {
        return { steps: [], error: e.message }
      }
    }

    it('play 60 produces a play step with correct MIDI note', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps.length).toBe(2)
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60)
      expect(steps[1].tag).toBe('sleep')
    })

    it('sample :bd_haus produces a sample step', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  sample :bd_haus
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('sample')
      expect(steps[0].name).toBe('bd_haus')
    })

    it('play with opts passes through correctly', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60, release: 0.3, amp: 0.8
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].opts.release).toBe(0.3)
      expect(steps[0].opts.amp).toBe(0.8)
    })

    it('use_synth changes the synth', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_synth :prophet
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('useSynth')
      expect(steps[0].name).toBe('prophet')
      expect(steps[1].tag).toBe('play')
    })

    it('ring and tick produce correct values', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play (ring 60, 64, 67).tick
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60) // first tick → index 0
    })

    it('variable reassignment works (bare assignment, not const)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  x = 60
  x = x + 12
  play x
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(72)
    })

    it('with_fx produces an fx step with body', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  with_fx :reverb, room: 0.8 do
    play 60
    sleep 1
  end
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('fx')
      expect(steps[0].name).toBe('reverb')
      expect(steps[0].opts.room).toBe(0.8)
      expect(steps[0].body.length).toBeGreaterThan(0)
    })

    it('N.times loop produces repeated steps', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  3.times do
    play 60
    sleep 0.25
  end
end`)
      expect(error).toBeUndefined()
      // 3 iterations × (play + sleep) = 6 steps
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      expect(playSteps.length).toBe(3)
    })

    it('cue and sync produce correct steps', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  cue :beat
  sync :bass
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('cue')
      expect(steps[0].name).toBe('beat')
      expect(steps[1].tag).toBe('sync')
      expect(steps[1].name).toBe('bass')
    })

    it('sync_bpm emits a sync step with bpmSync flag (#236)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  sync_bpm :tick
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('sync')
      expect(steps[0].name).toBe('tick')
      expect(steps[0].bpmSync).toBe(true)
    })

    it('live_audio :foo, :stop emits a stop step (Ruby symbol form, #243)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  live_audio :foo, :stop
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('liveAudio')
      expect(steps[0].name).toBe('foo')
      expect(steps[0].stop).toBe(true)
    })

    it('live_audio "foo", "stop" emits a stop step (string form, #243)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  live_audio "foo", "stop"
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('liveAudio')
      expect(steps[0].name).toBe('foo')
      expect(steps[0].stop).toBe(true)
    })

    it('live_audio :foo, input: 3 still emits a start step with opts (#243)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  live_audio :foo, input: 3
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('liveAudio')
      expect(steps[0].name).toBe('foo')
      expect(steps[0].stop).toBeUndefined()
      expect(steps[0].opts.input).toBe(3)
    })

    it('define creates callable function with b injection', () => {
      const { steps, error } = executeTranspiled(`define :hit do
  sample :bd_haus
end

live_loop :t do
  hit
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('sample')
      expect(steps[0].name).toBe('bd_haus')
    })

    it('use_transpose shifts play notes', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_transpose 12
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      const playStep = steps.find((s: any) => s.tag === 'play')
      expect(playStep).toBeDefined()
      expect(playStep!.note).toBe(72)
    })

    it('use_synth_defaults merges into play opts', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_synth_defaults release: 0.5, cutoff: 80
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].opts.release).toBe(0.5)
      expect(steps[0].opts.cutoff).toBe(80)
    })

    it('tick_reset_all clears tick counters', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  tick
  tick
  tick_reset_all
  play (ring 60, 64, 67).tick
  sleep 1
end`)
      expect(error).toBeUndefined()
      // After reset, tick starts from 0 again → note 60
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60)
    })

    it('factor? checks divisibility', () => {
      // factor_q(4, 2) → 4%2===0 → true
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60 if factor?(4, 2)
  sleep 1
end`)
      expect(error).toBeUndefined()
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      expect(playSteps.length).toBe(1)
    })

    it('bools creates boolean ring', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  pattern = bools(1, 0, 1, 0)
  sample :bd_haus if pattern[0]
  sleep 1
end`)
      expect(error).toBeUndefined()
      // bools(1,0,1,0)[0] = true → sample plays
      expect(steps[0].tag).toBe('sample')
    })

    it('tick_set :symbol coerces the symbol to a string at the call site (#218)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  tick_set :foo, 10
  play (ring 60, 64).at(look :foo)
  sleep 1
end`)
      expect(result.ok).toBe(true)
      // Symbol should land as a JS string, not a colon-prefixed identifier.
      expect(result.code).toMatch(/__b\.tick_set\(\s*"foo"\s*,\s*10\s*\)/)
      // Same coercion for look.
      expect(result.code).toMatch(/__b\.look\(\s*"foo"\s*\)/)
    })

    it('tick_set :foo, 10 lands the value in the named counter (#218)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  tick_set :foo, 10
  play (ring 60, 64, 67).at(look :foo)
  sleep 1
end`)
      expect(error).toBeUndefined()
      // After tick_set :foo, 10 then look :foo, the index lookup should be
      // (ring 60,64,67).at(10) → 64 (10 mod 3 = 1).
      const playStep = steps.find((s: any) => s.tag === 'play')
      expect(playStep).toBeDefined()
      expect(playStep!.note).toBe(64)
    })

    it('assert_error block-form transpiles to a callback (#216)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  assert_error do
    raise "boom"
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('assert_error((__b) => {')
    })

    it('time_warp offsets a block without advancing global virtual time (#211)', () => {
      const result = treeSitterTranspile(`live_loop :t do
  time_warp 0.25 do
    play 60
  end
  play 64
  sleep 1
end`)
      expect(result.ok).toBe(true)
      // time_warp transpiles to __b.at([0.25], null, ...)
      expect(result.code).toContain('__b.at([0.25]')
      expect(result.code).toContain('null')
    })

    it('synth + control captures play node ref and emits control step (#211)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  s = synth :saw, note: 60, release: 4
  sleep 0.1
  control s, cutoff: 80, amp: 0.5
  sleep 1
end`)
      expect(error).toBeUndefined()
      const playStep = steps.find((s: any) => s.tag === 'play')
      const controlStep = steps.find((s: any) => s.tag === 'control')
      expect(playStep).toBeDefined()
      expect(controlStep).toBeDefined()
      // control's nodeRef is a number — the captured __b.lastRef from the synth call.
      expect(typeof controlStep!.nodeRef).toBe('number')
      expect(controlStep!.params.cutoff).toBe(80)
      expect(controlStep!.params.amp).toBe(0.5)
    })

    it('with_fx block param captures FX node ref for control', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  with_fx :reverb, room: 0.8 do |r|
    play 60
    control r, mix: 0.5
    sleep 1
  end
end`)
      expect(error).toBeUndefined()
      const fxStep = steps.find((s: any) => s.tag === 'fx')
      expect(fxStep).toBeDefined()
      expect(fxStep!.name).toBe('reverb')
      expect(fxStep!.nodeRef).toBeDefined()
      // The inner body should have a control step targeting the FX ref
      const controlStep = fxStep!.body.find((s: any) => s.tag === 'control')
      expect(controlStep).toBeDefined()
      expect(controlStep!.nodeRef).toBe(fxStep!.nodeRef)
      expect(controlStep!.params.mix).toBe(0.5)
    })

    it('play_pattern_timed plays notes with timing', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play_pattern_timed [60, 64, 67], [0.5]
  sleep 1
end`)
      expect(error).toBeUndefined()
      // 3 notes, a sleep after each (#404), plus the trailing `sleep 1`
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      const sleepSteps = steps.filter((s: any) => s.tag === 'sleep')
      expect(playSteps.length).toBe(3)
      expect(sleepSteps.length).toBeGreaterThanOrEqual(3)
    })

    // --- Issue #95: Runtime semantic gap tests ---

    it('note + number: :c3 + 7 resolves to MIDI arithmetic', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play :c3 + 7
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      // :c3 = 48, + 7 = 55
      expect(steps[0].note).toBe(55)
    })

    it('note subtraction: :c5 - 7 resolves to MIDI arithmetic', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play :c5 - 7
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      // :c5 = 72, - 7 = 65
      expect(steps[0].note).toBe(65)
    })

    it('note + array: :c3 + [0, 7, 11] produces chord', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play :c3 + [0, 7, 11]
  sleep 1
end`)
      expect(error).toBeUndefined()
      // Should produce 3 play steps (chord): 48, 55, 59
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      expect(playSteps.length).toBe(3)
      expect(playSteps[0].note).toBe(48)
      expect(playSteps[1].note).toBe(55)
      expect(playSteps[2].note).toBe(59)
    })

    it('Ring * number: spread repeat', () => {
      const result = treeSitterTranspile(`live_loop :t do
  pattern = spread(2, 6) * 3
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__spMul')
    })

    it('Ring + Ring: concat', () => {
      const result = treeSitterTranspile(`live_loop :t do
  combined = ring(1, 2) + ring(3, 4)
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('__spAdd')
    })

    it('array .look: transpiled to .at(b.look())', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play [0, 0, 12].look
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('?.at(__b.look())')
    })
  })

  // Phase A — error hardening (#185): previously silent passthroughs now
  // surface as structured errors with a report-bug URL.
  describe('Error hardening — unsupported Ruby features', () => {
    it('Math::PI transpiles to Math.PI (known safe mapping)', () => {
      const r = treeSitterTranspile(`x = Math::PI`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Math.PI')
    })

    it('Math::E transpiles to Math.E', () => {
      const r = treeSitterTranspile(`x = Math::E`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Math.E')
    })

    it('Float::INFINITY transpiles to Infinity', () => {
      const r = treeSitterTranspile(`x = Float::INFINITY`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Infinity')
    })

    it('unknown scope_resolution flags a structured error', () => {
      const r = treeSitterTranspile(`x = MyNamespace::Something`)
      expect(r.ok).toBe(false)
      expect(r.errors.length).toBeGreaterThan(0)
      expect(r.errors[0]).toContain('scope_resolution')
      expect(r.errors[0]).toContain('MyNamespace::Something')
      expect(r.errors[0]).toContain('github.com/MrityunjayBhardwaj/SonicPi.js/issues/new')
    })

    it('error includes line number and code snippet', () => {
      const r = treeSitterTranspile(`use_bpm 120\nlive_loop :t do\n  x = MyNamespace::Missing\n  sleep 1\nend`)
      expect(r.ok).toBe(false)
      expect(r.errors[0]).toMatch(/Line 3:/)
    })

    it('splat_argument in array literal transpiles to JS spread', () => {
      const r = treeSitterTranspile(`live_loop :t do\n  a = [*ring(1,2,3)]\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('...')
    })

    it('case/when still works after pattern wrapper tightening', () => {
      const r = treeSitterTranspile(`x = 1\ncase x\nwhen 1 then play 60\nwhen 2 then play 64\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('=== 1')
      expect(r.code).toContain('=== 2')
    })
  })

  // Phase B — empirical handler fixes from the in-thread forum test run (#186).
  describe('Phase B — handler fixes from forum test run', () => {
    it('kind_of?(Integer) → __spIsA with class-name string', () => {
      const r = treeSitterTranspile(`x = 5\nif x.kind_of?(Integer)\n  play 60\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('__spIsA(x, "Integer")')
    })

    it('is_a?(Array) uses same __spIsA dispatch', () => {
      const r = treeSitterTranspile(`x = [1]\nif x.is_a?(Array)\n  play 60\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('__spIsA(x, "Array")')
    })

    it('array .take(n) transpiles (polyfill handles runtime)', () => {
      const r = treeSitterTranspile(`c = [:f3, :a3, :c4]\nlive_loop :t do\n  play c.take(1).look\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('.take(1)')
    })

    it('Array * Integer (Ruby repeat) uses __spMul', () => {
      const r = treeSitterTranspile(`hats = [1,0,1,0] * 4\nlive_loop :t do\n  play hats.tick\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('__spMul([1, 0, 1, 0], 4)')
    })

    it('.each do |a, b| emits array destructure', () => {
      const r = treeSitterTranspile(`pairs = [[:c4, 1], [:e4, 2]]\nlive_loop :t do\n  pairs.each do |n, d|\n    play n\n    sleep d\n  end\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toMatch(/for \(const \[n, d\] of pairs\)/)
    })

    it('single-arg .each do |item| still uses bare binding', () => {
      const r = treeSitterTranspile(`[1,2,3].each do |x|\n  play x\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('for (const x of')
    })

    it('top-level use_bpm rrand(…) transpiles cleanly (runtime-bound)', () => {
      const r = treeSitterTranspile(`use_bpm rrand(90, 130)\nlive_loop :t do\n  play 60\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('use_bpm(rrand(90, 130))')
    })
  })

  // Phase C — handler fixes from forum test run (#188-#192).
  describe('Phase C — handler fixes', () => {
    // #188 — Array enumerable: .sum, .avg
    it('.sum transpiles to reduce((a,b)=>a+b, 0)', () => {
      const r = treeSitterTranspile(`x = [1, 2, 3].sum`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('.reduce((a, b) => a + b, 0)')
    })

    it('.avg transpiles to reduce/length', () => {
      const r = treeSitterTranspile(`x = [1, 2, 3].avg`)
      expect(r.ok).toBe(true)
      expect(r.code).toMatch(/\.reduce\(\(a, b\) => a \+ b, 0\) \/ .*\.length/)
    })

    it('chained .sum on ring: scale(:c).sum', () => {
      const r = treeSitterTranspile(`x = scale(:c4, :major).sum`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('.reduce((a, b) => a + b, 0)')
    })

    // #189 — Hash methods: .values, .keys
    it('Hash#values → Object.values', () => {
      const r = treeSitterTranspile(`blues = { c: 1, d: 2 }\nx = blues.values`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Object.values(blues)')
    })

    it('Hash#keys → Object.keys', () => {
      const r = treeSitterTranspile(`blues = { c: 1, d: 2 }\nx = blues.keys`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Object.keys(blues)')
    })

    it('.values with a block does NOT shadow (lets block handlers match)', () => {
      // Defensive: ensure the no-block guard means future handlers can still match
      // foo.values { ... } forms without being hijacked by Object.values().
      const r = treeSitterTranspile(`x = [1,2,3].values`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('Object.values')
    })

    // #192 — case/when with multiple patterns (regression coverage for
    // existing behavior that was previously uncovered by tests).
    it('when 1, 2, 3 ORs patterns with ||', () => {
      const r = treeSitterTranspile(`x = 2\ncase x\nwhen 1, 2, 3 then y = 10\nwhen 4, 5 then y = 20\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('=== 1 || ')
      expect(r.code).toContain('=== 2')
      expect(r.code).toContain('=== 3')
    })

    // #190 — top-level `loop do` hoists to an auto-named live_loop so the
    // scheduler owns its cadence (otherwise `while(true)` inside the
    // __run_once wrapper traps the iteration and the program hangs).
    it('top-level loop do wraps in live_loop("__loop_0", …)', () => {
      const r = treeSitterTranspile(`loop do\n  play 60\n  sleep 0.25\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('live_loop("__loop_0"')
      expect(r.code).not.toContain('live_loop("__run_once"')
      expect(r.code).toContain('__b.play(60')
      expect(r.code).toContain('__b.sleep(0.25)')
    })

    it('multiple top-level loop do blocks get unique auto names', () => {
      const r = treeSitterTranspile(`loop do\n  play 60\n  sleep 1\nend\nloop do\n  play 64\n  sleep 1\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('live_loop("__loop_0"')
      expect(r.code).toContain('live_loop("__loop_1"')
    })

    it('loop do inside live_loop stays as while(true) (nested, scheduler-driven)', () => {
      const r = treeSitterTranspile(`live_loop :outer do\n  loop do\n    play 60\n    sleep 0.25\n  end\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('while (true)')
      expect(r.code).toContain('live_loop("outer"')
    })

    it('top-level loop do co-exists with bare play (play stays in __run_once)', () => {
      const r = treeSitterTranspile(`play 48\nloop do\n  play 60\n  sleep 0.5\nend`)
      expect(r.ok).toBe(true)
      expect(r.code).toContain('live_loop("__run_once"')
      expect(r.code).toContain('live_loop("__loop_0"')
    })
  })
})
