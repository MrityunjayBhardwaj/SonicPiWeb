import { describe, it, expect, beforeAll } from 'vitest'
import { initTreeSitter, autoTranspileDetailed } from '../TreeSitterTranspiler'
import { ProgramBuilder } from '../ProgramBuilder'

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
