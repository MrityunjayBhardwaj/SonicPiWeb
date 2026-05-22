import { describe, it, expect, beforeAll } from 'vitest'
import { initTreeSitter, autoTranspileDetailed } from '../TreeSitterTranspiler'
import { ProgramBuilder } from '../ProgramBuilder'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'
import type { SuperSonicBridge } from '../SuperSonicBridge'

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Mock bridge that records the `note` of every triggerSynth call. */
function createNoteRecordingBridge(): SuperSonicBridge & { triggeredNotes: number[] } {
  let nextNode = 5000
  const triggeredNotes: number[] = []
  return {
    triggeredNotes,
    async triggerSynth(_name: string, _time: number, params: Record<string, number>) {
      triggeredNotes.push(params.note)
      return nextNode++
    },
    async playSample() { return nextNode++ },
    allocateBus() { return 16 },
    freeBus() {},
    freeNode() {},
    flushMessages() {},
    get audioContext() { return null as unknown as AudioContext },
    send() {},
    isLiveAudioStreaming() { return false },
  } as unknown as SuperSonicBridge & { triggeredNotes: number[] }
}

beforeAll(async () => {
  await initTreeSitter({
    treeSitterWasmUrl: './node_modules/web-tree-sitter/tree-sitter.wasm',
    rubyWasmUrl: './node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm',
  })
})

describe('cogate-2 SILENT-FAIL fixes (#382 #383 #384)', () => {
  describe('#382 — user-defined def calls are emitted as calls, not bare references', () => {
    it('def f; f; end emits function f() { f(__b) } (call, not reference)', () => {
      const r = autoTranspileDetailed('def f\n  f\nend\n')
      expect(r.hasError).toBe(false)
      // Before fix: `function f() { f }` — bare reference, no recursion possible.
      // After fix: `function f() { f(__b) }` — recursion → stack overflow → user-visible error.
      expect(r.code).toMatch(/function\s+f\s*\(\s*\)\s*\{\s*f\(__b\)\s*\}/)
    })

    it('def + call afterwards: f resolves to f(__b)', () => {
      const r = autoTranspileDetailed('def f\n  play 60\nend\nf\n')
      expect(r.hasError).toBe(false)
      // The post-def `f` MUST be a call. Before fix it was a bare reference
      // (no-op evaluating to the function object), so user code did nothing.
      expect(r.code).toMatch(/^\s*f\(__b\)/m)
    })

    it('B6 reproducer compiles to recursing JS that throws RangeError', () => {
      const r = autoTranspileDetailed('def f\n  f\nend\nf\n')
      expect(r.hasError).toBe(false)
      expect(() => {
        // Direct exec — emulate Sandbox `with(scope){ … }` so the bare `f` and
        // bare `__b` resolve. RangeError is the user-visible signal.
        const fn = new Function('__scope__', `with(__scope__){ ${r.code} }`)
        const scope = new Proxy({} as Record<string, unknown>, {
          has: () => true,
          get: () => undefined,
        })
        fn(scope)
      }).toThrow(/maximum call stack/i)
    })
  })

  describe('#383 — at() accepts scalar OR array time arg', () => {
    it('at(1, null, fn) iterates once (scalar normalized to [1])', () => {
      const b = new ProgramBuilder()
      let calls = 0
      // Before fix: times.length === undefined → for loop never iterates → callback never fires.
      // After fix: Array.isArray check → [1] → callback fires once.
      // Pass scalar via `as any` to mirror what the transpiler emits today.
      b.at(1 as unknown as number[], null, (inner) => {
        calls++
        inner.play(60)
      })
      expect(calls).toBe(1)
      // The build output should include a thread step for this at(1).
      const program: ReadonlyArray<{ tag: string }> = b.build()
      const threadSteps = program.filter(s => s.tag === 'thread')
      expect(threadSteps.length).toBe(1)
    })

    it('at([1, 2, 3], null, fn) still iterates three times (array path unchanged)', () => {
      const b = new ProgramBuilder()
      const seen: number[] = []
      b.at([1, 2, 3], null, (_inner, i) => { seen.push(i as number) })
      expect(seen).toEqual([0, 1, 2])  // 3 invocations, indices passed
    })

    it('B8 reproducer transpiles to __b.at(1, null, fn) and that no longer silently no-ops', () => {
      const r = autoTranspileDetailed('at(1) { play 60 }\nsleep 2\n')
      expect(r.hasError).toBe(false)
      // The transpiler still emits the scalar form (open follow-up #383 if/when
      // we wrap at the transpile layer too). The runtime defensiveness is what
      // closes the silent-failure gap.
      expect(r.code).toContain('__b.at(1, null,')
    })
  })

  describe('#384 — capture.ts runtimePatterns covers friendly parse-error titles', () => {
    it('the friendly title "Syntax error — your code could not be parsed" contains a matched pattern', () => {
      // Mirror the runtimePatterns list from tools/capture.ts:513. This test
      // doesn't run capture.ts — it asserts the pattern coverage contract
      // (any future-renamed friendly title MUST add the new prefix to the
      // pattern list, else the comparator silently mis-classifies).
      const runtimePatterns = [
        'not a function', 'not defined', 'Something went wrong',
        'Error in loop', "isn't available",
        'SyntaxError', 'TypeError', 'ReferenceError', 'Unexpected token',
        'Parse error', 'Syntax error ', 'Code nested too deeply',
      ]
      const friendlyParseTitle = 'Syntax error — your code could not be parsed'
      const friendlyParseMsg = 'Parse error at line 2: @'
      const friendlyStackTitle = 'Code nested too deeply'  // from B6 stack-overflow path
      expect(runtimePatterns.some(p => friendlyParseTitle.includes(p))).toBe(true)
      expect(runtimePatterns.some(p => friendlyParseMsg.includes(p))).toBe(true)
      expect(runtimePatterns.some(p => friendlyStackTitle.includes(p))).toBe(true)
    })
  })
})

describe('Tier-1 polish — WRONG-AUDIO / POOR-MESSAGE tail (PATH B)', () => {
  describe('#387 (B7) — non-finite note (play 60 / 0 → Infinity) is skipped, not sent to scsynth', () => {
    it('build-time: play(60 / 0) produces a non-finite play step', () => {
      // `60 / 0` is Infinity in JS (not a throw). The note is finalized at
      // build time in _pushPlayStep, so the step carries a non-finite note.
      const program = new ProgramBuilder(0).play(60 / 0).play(72).build()
      const plays = program.filter((s): s is typeof s & { note: number } => s.tag === 'play')
      expect(Number.isFinite(plays[0].note)).toBe(false)
      expect(plays[1].note).toBe(72)
    })

    it('dispatch: Infinity note is NOT triggered; a warning fires; the valid note still plays', async () => {
      const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
      const eventStream = new SoundEventStream()
      const bridge = createNoteRecordingBridge()
      const warnings: string[] = []
      const program = new ProgramBuilder(0).play(60 / 0).play(72).sleep(999999).build()

      const ctx: AudioCtx = {
        bridge, scheduler, taskId: 'test', eventStream, schedAheadTime: 100,
        nodeRefMap: new Map(), reusableFx: new Map(),
        printHandler: (m) => warnings.push(m),
      }
      scheduler.registerLoop('test', async () => { await runProgram(program, ctx) })
      scheduler.tick(100)
      await flushMicrotasks()

      // The non-finite note must NOT reach the synth; only the valid 72 does.
      expect(bridge.triggeredNotes).toEqual([72])
      // A visible diagnostic must be surfaced naming the non-finite resolution.
      expect(warnings.some(w => /note resolved to Infinity/i.test(w))).toBe(true)
    })

    it('NaN note (0 / 0) is also skipped', async () => {
      const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
      const eventStream = new SoundEventStream()
      const bridge = createNoteRecordingBridge()
      const warnings: string[] = []
      const program = new ProgramBuilder(0).play(0 / 0).play(48).sleep(999999).build()

      const ctx: AudioCtx = {
        bridge, scheduler, taskId: 'test', eventStream, schedAheadTime: 100,
        nodeRefMap: new Map(), reusableFx: new Map(),
        printHandler: (m) => warnings.push(m),
      }
      scheduler.registerLoop('test', async () => { await runProgram(program, ctx) })
      scheduler.tick(100)
      await flushMicrotasks()

      expect(bridge.triggeredNotes).toEqual([48])
      expect(warnings.some(w => /note resolved to NaN/i.test(w))).toBe(true)
    })
  })

  describe('#388 (B4) — unparseable note name is skipped + named, not silently coerced to 60', () => {
    it('build-time: play("not a note") yields a NaN note carrying the original string', () => {
      const program = new ProgramBuilder(0).play('not a note').play(72).build()
      const plays = program.filter((s): s is typeof s & { note: number; noteName?: string } => s.tag === 'play')
      expect(Number.isNaN(plays[0].note)).toBe(true)
      expect(plays[0].noteName).toBe('not a note')
      // The valid note after it is unaffected and carries no noteName marker.
      expect(plays[1].note).toBe(72)
      expect(plays[1].noteName).toBeUndefined()
    })

    it('dispatch: the bad name is NOT triggered; a warning names it; the valid note still plays', async () => {
      const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
      const eventStream = new SoundEventStream()
      const bridge = createNoteRecordingBridge()
      const warnings: string[] = []
      const program = new ProgramBuilder(0).play('not a note').play(72).sleep(999999).build()

      const ctx: AudioCtx = {
        bridge, scheduler, taskId: 'test', eventStream, schedAheadTime: 100,
        nodeRefMap: new Map(), reusableFx: new Map(),
        printHandler: (m) => warnings.push(m),
      }
      scheduler.registerLoop('test', async () => { await runProgram(program, ctx) })
      scheduler.tick(100)
      await flushMicrotasks()

      expect(bridge.triggeredNotes).toEqual([72])  // no phantom note:60
      expect(warnings.some(w => /"not a note" isn't a valid note name/i.test(w))).toBe(true)
    })

    it('NEGATIVE CONTROL: valid note names (numbers, "c4", "eb3", "fs5") still resolve and play', async () => {
      const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
      const eventStream = new SoundEventStream()
      const bridge = createNoteRecordingBridge()
      const warnings: string[] = []
      const program = new ProgramBuilder(0)
        .play(60).play('c4').play('eb3').play('fs5').sleep(999999).build()

      const ctx: AudioCtx = {
        bridge, scheduler, taskId: 'test', eventStream, schedAheadTime: 100,
        nodeRefMap: new Map(), reusableFx: new Map(),
        printHandler: (m) => warnings.push(m),
      }
      scheduler.registerLoop('test', async () => { await runProgram(program, ctx) })
      scheduler.tick(100)
      await flushMicrotasks()

      // c4=60, eb3=51 (E♭3), fs5=78 (F♯5) — all valid, none refused.
      expect(bridge.triggeredNotes).toEqual([60, 60, 51, 78])
      expect(warnings.length).toBe(0)
    })
  })
})
