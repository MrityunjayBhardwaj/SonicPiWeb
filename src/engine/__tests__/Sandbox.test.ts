import { describe, it, expect } from 'vitest'
import { createSandboxedExecutor, createIsolatedExecutor, validateCode, BLOCKED_GLOBALS } from '../Sandbox'

describe('Sandbox', () => {
  it('blocks fetch in user code', async () => {
    const execute = createSandboxedExecutor(
      'if (typeof fetch !== "undefined") throw new Error("fetch should be blocked")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('blocks document in user code', async () => {
    const execute = createSandboxedExecutor(
      'if (typeof document !== "undefined") throw new Error("document should be blocked")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('blocks setTimeout in user code', async () => {
    const execute = createSandboxedExecutor(
      'if (typeof setTimeout !== "undefined") throw new Error("setTimeout should be blocked")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('blocks eval in user code', async () => {
    const execute = createSandboxedExecutor(
      'if (typeof eval !== "undefined") throw new Error("eval should be blocked")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('allows DSL functions to pass through', async () => {
    let called = false
    const execute = createSandboxedExecutor(
      'await myFunc()',
      ['myFunc']
    )
    await execute(async () => { called = true })
    expect(called).toBe(true)
  })

  it('allows Math, Array, and other safe globals', async () => {
    const execute = createSandboxedExecutor(
      'if (typeof Math === "undefined") throw new Error("Math should be available")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('allows user variable assignments', async () => {
    const execute = createSandboxedExecutor(
      'let x = 42; if (x !== 42) throw new Error("variable assignment failed")',
      []
    )
    await expect(execute()).resolves.toBeUndefined()
  })

  it('blocks all listed globals', () => {
    expect(BLOCKED_GLOBALS).toContain('fetch')
    expect(BLOCKED_GLOBALS).toContain('document')
    expect(BLOCKED_GLOBALS).toContain('window')
    expect(BLOCKED_GLOBALS).toContain('eval')
    expect(BLOCKED_GLOBALS).toContain('Function')
    expect(BLOCKED_GLOBALS).toContain('localStorage')
    expect(BLOCKED_GLOBALS).toContain('XMLHttpRequest')
    expect(BLOCKED_GLOBALS).toContain('WebSocket')
    expect(BLOCKED_GLOBALS.length).toBeGreaterThanOrEqual(20)
  })

  it('validateCode warns about constructor access', () => {
    const warnings = validateCode('this.constructor.constructor("return this")()')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('validateCode returns no warnings for clean code', () => {
    const warnings = validateCode('await ctx.play(60)\nawait ctx.sleep(1)')
    expect(warnings).toHaveLength(0)
  })

  // --- Per-loop scope isolation tests (Fix #3) ---

  it('per-loop scope: variable set in loop A is NOT visible in loop B', async () => {
    const { execute, scopeHandle } = createIsolatedExecutor(
      // This code simulates two loops sharing a scope
      // Loop A sets x = 42, Loop B reads x
      `
      const results = []
      // Simulate loop A
      __enterScope__("loopA")
      x = 42
      results.push(x)
      __exitScope__()
      // Simulate loop B
      __enterScope__("loopB")
      results.push(typeof x === "undefined" ? "undefined" : x)
      __exitScope__()
      storeResults(results)
      `,
      ['storeResults', '__enterScope__', '__exitScope__']
    )
    let captured: unknown[] = []
    await execute(
      (r: unknown[]) => { captured = r },
      (name: string) => scopeHandle.enterScope(name),
      () => scopeHandle.exitScope()
    )
    expect(captured[0]).toBe(42)      // Loop A sees its own x
    expect(captured[1]).toBe('undefined')  // Loop B does NOT see loop A's x
  })

  it('per-loop scope: get/set global store still works across loops', async () => {
    // Variables set at top level (outside any scope) are shared
    const { execute, scopeHandle } = createIsolatedExecutor(
      `
      // Set at top level (no scope active)
      shared = 99
      // Enter loop A — should still see top-level shared
      __enterScope__("loopA")
      const val = shared
      __exitScope__()
      storeResult(val)
      `,
      ['storeResult', '__enterScope__', '__exitScope__']
    )
    let result: unknown = null
    await execute(
      (v: unknown) => { result = v },
      (name: string) => scopeHandle.enterScope(name),
      () => scopeHandle.exitScope()
    )
    expect(result).toBe(99)
  })

  it('per-loop scope: DSL functions accessible from all loops', async () => {
    const { execute, scopeHandle } = createIsolatedExecutor(
      `
      __enterScope__("loopA")
      const r1 = myDsl()
      __exitScope__()
      __enterScope__("loopB")
      const r2 = myDsl()
      __exitScope__()
      storeResults([r1, r2])
      `,
      ['myDsl', 'storeResults', '__enterScope__', '__exitScope__']
    )
    let captured: unknown[] = []
    await execute(
      () => 'dsl_ok',
      (r: unknown[]) => { captured = r },
      (name: string) => scopeHandle.enterScope(name),
      () => scopeHandle.exitScope()
    )
    expect(captured[0]).toBe('dsl_ok')
    expect(captured[1]).toBe('dsl_ok')
  })

  // --- Fix #8: Scope persistence across iterations ---

  it('scope locals persist across iterations (enter/exit same name twice)', async () => {
    const { execute, scopeHandle } = createIsolatedExecutor(
      `
      // Iteration 1: set x
      __enterScope__("loop1")
      x = 42
      __exitScope__()
      // Iteration 2: read x from same scope name
      __enterScope__("loop1")
      storeResult(x)
      __exitScope__()
      `,
      ['storeResult', '__enterScope__', '__exitScope__']
    )
    let result: unknown = null
    await execute(
      (v: unknown) => { result = v },
      (name: string) => scopeHandle.enterScope(name),
      () => scopeHandle.exitScope()
    )
    expect(result).toBe(42)
  })

  // --- Fix #9: Concurrent scope isolation via stack ---

  it('concurrent scope isolation: nested enterScope uses stack correctly', async () => {
    const { execute, scopeHandle } = createIsolatedExecutor(
      `
      // Enter scope "a", set x=1
      __enterScope__("a")
      x = 1
      // Enter scope "b" without exiting "a" (simulating async interleave)
      __enterScope__("b")
      x = 2
      const bVal = x
      __exitScope__() // pops "b", back to "a"
      const aVal = x  // should be 1 from scope "a"
      __exitScope__() // pops "a"
      storeResults([aVal, bVal])
      `,
      ['storeResults', '__enterScope__', '__exitScope__']
    )
    let captured: unknown[] = []
    await execute(
      (r: unknown[]) => { captured = r },
      (name: string) => scopeHandle.enterScope(name),
      () => scopeHandle.exitScope()
    )
    expect(captured[0]).toBe(1)  // "a" scope has x=1
    expect(captured[1]).toBe(2)  // "b" scope has x=2
  })

  // --- Backward compatibility: createSandboxedExecutor returns a function ---

  it('createSandboxedExecutor returns a function (backward compat)', async () => {
    const execute = createSandboxedExecutor(
      'storeResult(42)',
      ['storeResult']
    )
    expect(typeof execute).toBe('function')
    let result: unknown = null
    await execute((v: unknown) => { result = v })
    expect(result).toBe(42)
  })

  // --- Issue #208: __spIsNote regex must be case-insensitive ---
  // Symptom: `:C3 + 0` produced string "C30" instead of MIDI 48,
  // poisoning downstream subtraction with NaN (bass_foundation note: NaN).
  it('uppercase symbols (e.g. :C3) flow through __spAdd as numeric MIDI', async () => {
    let result: unknown = null
    // Mimics the transpiled form of: g_grundton = :C3; g_note = g_grundton + 0; out(g_note - 24)
    const execute = createSandboxedExecutor(
      'var g = "C3"; var n = __spAdd(g, 0); var out = __spSub(n, 24); storeResult(out)',
      ['storeResult', 'note']
    )
    await execute(
      (v: unknown) => { result = v },
      (s: string) => { // note() implementation
        const str = s.toLowerCase()
        const map: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
        const m = str.match(/^([a-g])(s|b|#)?(\d+)?$/)
        if (!m) return 60
        const base = map[m[1]]
        const oct = m[3] ? parseInt(m[3]) : 4
        let midi = (oct + 1) * 12 + base
        if (m[2] === 's' || m[2] === '#') midi += 1
        if (m[2] === 'b') midi -= 1
        return midi
      }
    )
    expect(result).toBe(24) // 48 - 24, NOT NaN
  })

  // #441 — Ruby String * Integer is repeat ("0" * 5 == "00000"). Before the
  // fix __spMul fell through to `a * b` === NaN, which broke iterating helpers
  // like `shuffle("0" * n)` ("arr is not iterable").
  it('String * Integer repeats the string (both operand orders)', async () => {
    let result: unknown = null
    const execute = createSandboxedExecutor(
      'storeResult([__spMul("0", 5), __spMul(3, "ab"), __spMul("x", 0)])',
      ['storeResult']
    )
    await execute((v: unknown) => { result = v })
    expect(result).toEqual(['00000', 'ababab', ''])
  })
})
