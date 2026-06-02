/**
 * Sandbox — blocks dangerous browser globals in user code.
 *
 * Strategy: create a frozen scope object with only DSL functions,
 * then execute user code via `new Function()` with a `with()` proxy
 * that intercepts all global lookups.
 *
 * Why not iframe/Worker: user code needs synchronous access to
 * the scheduler and AudioContext — can't serialize across boundaries.
 *
 * Why not parameter shadowing: Firefox + SES extensions reject
 * certain parameter names in strict mode.
 *
 * This approach: wraps user code in a `with(scope)` block where
 * `scope` is a Proxy that returns undefined for blocked globals.
 * Works in all browsers, no strict mode issues.
 */

/**
 * Number of lines the sandbox wrapper adds before user code.
 * Set dynamically on first executor creation. Used by FriendlyErrors
 * to map JS error line numbers back to user source lines.
 */
export let SANDBOX_WRAPPER_LINES = 37 // initial estimate, updated on first createIsolatedExecutor

/** Globals that are blocked in user code. */
export const BLOCKED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'localStorage', 'sessionStorage', 'indexedDB',
  'document', 'window', 'navigator', 'location', 'history',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'Worker', 'SharedWorker', 'ServiceWorker',
  'importScripts', 'postMessage', 'globalThis',
  'eval', 'Function',
]

const BLOCKED_SET = new Set(BLOCKED_GLOBALS)

/**
 * Create a sandboxed executor using a Proxy-based scope.
 *
 * The generated function uses `with(scope)` so all variable lookups
 * go through our proxy. The proxy returns undefined for blocked globals
 * and the real value for DSL functions.
 *
 * Per-loop scope isolation: when __enterScope__(name) is called, variable
 * writes go to a per-scope storage Map. Reads check local scope first,
 * then fall through to DSL functions and safe globals. This prevents
 * live_loops from accidentally sharing user variables.
 */
/** Scope management handle returned alongside the executor. */
export interface ScopeHandle {
  enterScope(name: string): void
  exitScope(): void
}

/**
 * Create an isolated executor with scope management handle.
 * Returns `{ execute, scopeHandle }` for full control over per-loop scoping.
 */
export function createIsolatedExecutor(
  transpiledCode: string,
  dslParamNames: string[],
  extraScope?: Record<string, unknown>,
): { execute: (...args: unknown[]) => Promise<void>; scopeHandle: ScopeHandle } {
  // Build the scope object with DSL functions
  const scopeBase: Record<string, unknown> = {}

  // Pre-populate blocked globals as undefined
  for (const name of BLOCKED_GLOBALS) {
    scopeBase[name] = undefined
  }

  // Seed user-defined fns from prior evals (#211 — define/defonce persistence)
  if (extraScope) {
    for (const [k, v] of Object.entries(extraScope)) {
      scopeBase[k] = v
    }
  }

  // Per-loop scope isolation state — stack-based to handle async interleaving
  const scopeStack: string[] = []
  const scopeLocals = new Map<string, Map<string, unknown>>()

  // Create a proxy that intercepts all property access
  const scope = new Proxy(scopeBase, {
    has() {
      // Tell `with()` that we handle ALL variables
      return true
    },
    get(target, prop) {
      if (typeof prop === 'string') {
        // Blocked global
        if (BLOCKED_SET.has(prop)) return undefined

        // Check per-loop local scope first (if inside a scope)
        const currentScopeName = scopeStack[scopeStack.length - 1] ?? null
        if (currentScopeName !== null) {
          const locals = scopeLocals.get(currentScopeName)
          if (locals && locals.has(prop)) return locals.get(prop)
        }

        // DSL function / top-level variable
        if (prop in target) return target[prop]
      }
      // Fall through to real global for everything else (Math, Array, etc.)
      return (globalThis as Record<string | symbol, unknown>)[prop]
    },
    set(target, prop, value) {
      if (typeof prop === 'string') {
        // Inside a scope: write to per-loop local storage…
        const currentScopeName = scopeStack[scopeStack.length - 1] ?? null
        if (currentScopeName !== null && currentScopeName !== '__run_once') {
          // …EXCEPT for __run_once. That synthetic loop wraps bare top-level
          // user code (`m = [...]; c = choose(m)`) which Sonic Pi semantics
          // expect to be visible to other live_loops. Treating __run_once
          // assignments as top-level routes them to the shared scope so the
          // canonical pattern works (#206):
          //   m = [:c4, :e4, :g4]
          //   loop do; play choose(m); sleep 1; end
          let locals = scopeLocals.get(currentScopeName)
          if (!locals) {
            locals = new Map()
            scopeLocals.set(currentScopeName, locals)
          }
          locals.set(prop, value)
          return true
        }
      }
      // Outside any scope (or inside __run_once): write to shared scope.
      target[prop as string] = value
      return true
    },
  })

  const scopeHandle: ScopeHandle = {
    enterScope(name: string) { scopeStack.push(name) },
    exitScope() { scopeStack.pop() },
  }

  // Wrap code in with(scope) block — this routes all lookups through the proxy
  // Note: `with` is forbidden in strict mode, so we do NOT use "use strict"
  // Polyfill: Ruby's Hash#merge → JS Object spread. Injected so `opts.merge({amp: 1})` works.
  const mergePolyfill = `if (!Object.prototype.merge) { Object.defineProperty(Object.prototype, 'merge', { value: function(other) { return {...this, ...other}; }, writable: true, configurable: true, enumerable: false }); }\n`
  // Polyfill: Ruby's String#ring → split string into array of characters (ring-like).
  // Usage: "x-x-".ring.tick → ["x","-","x","-"].at(b.tick())
  const stringRingPolyfill = `if (!String.prototype.ring) { Object.defineProperty(String.prototype, 'ring', { get: function() { return this.split(''); }, configurable: true, enumerable: false }); }\n`
  // Polyfill: Array.at() wrapping — Sonic Pi treats all arrays as rings (wrapping on tick).
  // JS Array.at() returns undefined for index >= length. This wraps with modulo.
  const arrayAtPolyfill = `{ const _origAt = Array.prototype.at; Object.defineProperty(Array.prototype, 'at', { value: function(i) { return this[((i % this.length) + this.length) % this.length]; }, writable: true, configurable: true }); }\n`
  // Polyfill: Array#take(n) — Ruby Array method, not in JS. Ring has a native take(),
  // but plain arrays (common in user code: `c = [:f3,:a3,:c4]; c.take(1)`) need this.
  // Semantics match Ruby: returns first n elements as a new array.
  const arrayTakePolyfill = `if (!Array.prototype.take) { Object.defineProperty(Array.prototype, 'take', { value: function(n) { return this.slice(0, n); }, writable: true, configurable: true }); }\n`
  // Polyfill: Sonic Pi operator helpers — handle note strings, Ring/Array arithmetic.
  // Ruby auto-coerces :c3 to MIDI 48 and overloads +/-/* on Ring/Array.
  // JS can't do operator overloading, so the transpiler emits __spAdd/__spSub/__spMul
  // instead of raw +/-/* operators. These helpers detect types at runtime and dispatch.
  const spOperatorPolyfill = [
    'var __spNoteRe = /^[a-g][sb#]?\\d*$/i;',
    'function __spIsNote(v) { return typeof v === "string" && __spNoteRe.test(v); }',
    'function __spToNum(v) { return __spIsNote(v) && typeof note === "function" ? note(v) : v; }',
    'function __spIsRing(v) { return v != null && typeof v === "object" && typeof v.toArray === "function" && typeof v.tick === "function"; }',
    'function __spAdd(a, b) {',
    '  if (a == null || b == null) return null;',
    '  a = __spToNum(a); b = __spToNum(b);',
    '  if (__spIsRing(a) && __spIsRing(b)) return a.concat(b);',
    '  if (__spIsRing(a) && Array.isArray(b)) return a.concat(b);',
    '  if (Array.isArray(a) && __spIsRing(b)) return ring.apply(null, [].concat(a, b.toArray()));',
    '  if (typeof a === "number" && Array.isArray(b)) return b.map(function(x) { return a + x; });',
    '  if (Array.isArray(a) && typeof b === "number") return a.map(function(x) { return x + b; });',
    '  if (typeof a === "number" && __spIsRing(b)) return ring.apply(null, b.toArray().map(function(x) { return a + x; }));',
    '  if (__spIsRing(a) && typeof b === "number") return ring.apply(null, a.toArray().map(function(x) { return x + b; }));',
    '  return a + b;',
    '}',
    'function __spSub(a, b) {',
    '  if (a == null || b == null) return null;',
    '  a = __spToNum(a); b = __spToNum(b);',
    '  if (typeof a === "number" && Array.isArray(b)) return b.map(function(x) { return a - x; });',
    '  if (Array.isArray(a) && typeof b === "number") return a.map(function(x) { return x - b; });',
    '  if (typeof a === "number" && __spIsRing(b)) return ring.apply(null, b.toArray().map(function(x) { return a - x; }));',
    '  if (__spIsRing(a) && typeof b === "number") return ring.apply(null, a.toArray().map(function(x) { return x - b; }));',
    '  return a - b;',
    '}',
    'function __spMul(a, b) {',
    '  if (__spIsRing(a) && typeof b === "number") return a.repeat(b);',
    '  if (typeof a === "number" && __spIsRing(b)) return b.repeat(a);',
    // Ruby Array * Integer → repeat the array (not arithmetic).
    // Needed for patterns like `hats = [1,0,1,0] * 4`.
    '  if (Array.isArray(a) && typeof b === "number") return new Array(b).fill(a).flat();',
    '  if (typeof a === "number" && Array.isArray(b)) return new Array(a).fill(b).flat();',
    // Ruby String * Integer → repeat the string (e.g. `"0" * 5 == "00000"`).
    // Without this, string*number fell through to `a * b` === NaN, which then
    // broke iterating helpers like `shuffle("0" * n)` ("arr is not iterable",
    // #441). Clamp to a non-negative integer so a stray negative/float can't
    // crash a live loop (Ruby would raise; silent-safe is better mid-loop).
    '  if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, Math.floor(b)));',
    '  if (typeof a === "number" && typeof b === "string") return b.repeat(Math.max(0, Math.floor(a)));',
    '  return a * b;',
    '}',
    // Ruby x.kind_of?(Class) / x.is_a?(Class) — dispatch by class name.
    // Class arg comes in as a string (the transpiler JSON-encodes the
    // constant name) so we can match without needing the runtime to have
    // bindings for Integer, Numeric, etc.
    'function __spIsA(x, cls) {',
    '  switch (cls) {',
    '    case "Integer":  return Number.isInteger(x);',
    '    case "Float":    return typeof x === "number" && !Number.isInteger(x);',
    '    case "Numeric":  return typeof x === "number";',
    '    case "String":   return typeof x === "string";',
    '    case "Symbol":   return typeof x === "string";',
    '    case "Array":    return Array.isArray(x);',
    '    case "Hash":     return x !== null && typeof x === "object" && !Array.isArray(x) && !__spIsRing(x);',
    '    case "NilClass": return x === null || x === undefined;',
    '    case "TrueClass":  return x === true;',
    '    case "FalseClass": return x === false;',
    '    case "Proc":     return typeof x === "function";',
    '  }',
    // Unknown class name — try the runtime binding. If it's a function,
    // fall back to instanceof; otherwise return false (Ruby semantics for
    // an undefined class would raise NameError, but silent false is safer
    // than crashing a live loop).
    '  try { var t = eval(cls); return typeof t === "function" ? (x instanceof t) : false; }',
    '  catch (e) { return false; }',
    '}',
  ].join('\n') + '\n'
  const wrappedCode = `with(__scope__) { return (async () => {\n${mergePolyfill}${stringRingPolyfill}${arrayAtPolyfill}${arrayTakePolyfill}${spOperatorPolyfill}${transpiledCode}\n})(); }`

  // Count polyfill lines so we can map error line numbers back to user code
  // 2 = new Function wrapper (1) + with/async IIFE wrapper (1)
  const polyfillLineCount = (mergePolyfill + stringRingPolyfill + arrayAtPolyfill + arrayTakePolyfill + spOperatorPolyfill).split('\n').length
  SANDBOX_WRAPPER_LINES = 2 + polyfillLineCount

  try {
    const fn = new Function('__scope__', wrappedCode)
    const execute = (...dslArgs: unknown[]) => {
      // Populate scope with DSL values
      for (let i = 0; i < dslParamNames.length; i++) {
        scope[dslParamNames[i]] = dslArgs[i]
      }
      return fn(scope)
    }
    return { execute, scopeHandle }
  } catch (e) {
    // SyntaxError from new Function() — enrich with line info before re-throwing
    if (e instanceof SyntaxError) {
      const msg = e.message
      // Try to extract line number from the SyntaxError
      // Chrome: stack contains "<anonymous>:42:5"
      // Firefox/Safari: message may contain "line 42"
      const lineMatch = e.stack?.match(/<anonymous>:(\d+):\d+/) ??
                        msg.match(/line\s+(\d+)/i)
      if (lineMatch) {
        const jsLine = parseInt(lineMatch[1], 10)
        // Subtract: 1 (new Function wrapper) + 1 (with+async IIFE) + polyfill lines
        const wrapperLines = 2 + polyfillLineCount
        const sourceLine = jsLine - wrapperLines
        const enriched = new SyntaxError(`${msg} (line ${sourceLine > 0 ? sourceLine : 1})`)
        enriched.stack = e.stack
        throw enriched
      }
      throw e
    }
    // Non-syntax error (e.g., CSP violation) — fallback to plain executor
    console.warn('[SonicPi] Sandbox unavailable — running without global blocking')
    const asyncBody = `return (async () => {\n${transpiledCode}\n})();`
    try {
      const fn = new Function(...dslParamNames, asyncBody)
      return { execute: fn as (...args: unknown[]) => Promise<void>, scopeHandle }
    } catch (fallbackErr) {
      // Fallback also failed — enrich and re-throw
      if (fallbackErr instanceof SyntaxError) {
        const fbMsg = fallbackErr.message
        const fbMatch = (fallbackErr.stack?.match(/<anonymous>:(\d+):\d+/) ??
                        fbMsg.match(/line\s+(\d+)/i))
        if (fbMatch) {
          const raw = parseInt(fbMatch[1], 10)
          const adjusted = raw - 2 // subtract async IIFE wrapper (no polyfills in fallback)
          const enriched = new SyntaxError(`${fbMsg} (line ${adjusted > 0 ? adjusted : 1})`)
          enriched.stack = fallbackErr.stack
          throw enriched
        }
      }
      throw fallbackErr
    }
  }
}

/**
 * Create a sandboxed executor. Returns just the execute function for backward
 * compatibility. Use `createIsolatedExecutor` for scope management.
 */
export function createSandboxedExecutor(
  transpiledCode: string,
  dslParamNames: string[],
): (...args: unknown[]) => Promise<void> {
  return createIsolatedExecutor(transpiledCode, dslParamNames).execute
}

/**
 * Validate user code doesn't use obvious escape hatches.
 */
export function validateCode(code: string): string[] {
  const warnings: string[] = []
  if (/\bconstructor\b/.test(code)) {
    warnings.push('Code accesses "constructor" — this may not work in sandbox mode.')
  }
  if (/__proto__/.test(code)) {
    warnings.push('Code accesses "__proto__" — this may not work in sandbox mode.')
  }
  return warnings
}
