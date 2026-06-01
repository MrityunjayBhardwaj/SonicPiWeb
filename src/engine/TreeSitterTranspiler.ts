/**
 * TreeSitterTranspiler — partial fold over the Ruby CST.
 *
 * Replaces the regex-based Ruby→JS transpiler with a tree-sitter AST walk.
 * Uses web-tree-sitter to parse Ruby into a concrete syntax tree, then
 * walks named nodes via a switch — explicit handlers for ~60 semantically
 * meaningful node types, recursive traversal for structural wrappers,
 * and error flagging for unrecognized leaf nodes.
 *
 * Not a true catamorphism (which would require exhaustive coverage of all
 * ~150 named node types in the Ruby grammar). This is a partial fold over
 * the Sonic Pi subset, following the same pattern as Semgrep and ast-grep:
 * handle what matters, recurse through structure, flag the rest.
 *
 * Variable assignment uses bare assignment (no let/const) so the Sandbox
 * Proxy's set trap captures writes into scope-isolated storage — matching
 * Ruby's mutable variable semantics and Opal/CoffeeScript's approach.
 */

// ---------------------------------------------------------------------------
// Tree-sitter init (async, one-time)
// ---------------------------------------------------------------------------

// web-tree-sitter ships as a CommonJS/ESM hybrid. The WASM loader is
// the default export and exposes an `init()` method that takes a
// locator for the core WASM binary.

// At runtime we dynamically import so the module is only loaded when
// tree-sitter is actually used (keeps the bundle lean for envs that
// never call initTreeSitter).
let Parser: any = null
let RubyLanguage: any = null
let _initPromise: Promise<boolean> | null = null

/**
 * Initialize tree-sitter WASM runtime and load the Ruby grammar.
 *
 * Safe to call multiple times — subsequent calls return the cached promise.
 * Resolves `true` on success, `false` on failure (WASM load error, CSP, etc.).
 */
export function initTreeSitter(opts?: {
  treeSitterWasmUrl?: string
  rubyWasmUrl?: string
}): Promise<boolean> {
  if (_initPromise) return _initPromise
  _initPromise = _doInit(opts)
  return _initPromise
}

async function _doInit(opts?: {
  treeSitterWasmUrl?: string
  rubyWasmUrl?: string
}): Promise<boolean> {
  // Emscripten's abort() throws globally even when we catch the promise.
  // Install a temporary error suppressor so it doesn't leak to window.onerror.
  const isBrowser = typeof window !== 'undefined'
  let prevOnError: typeof window.onerror | null = null
  let rejectHandler: ((e: PromiseRejectionEvent) => void) | null = null
  if (isBrowser) {
    prevOnError = window.onerror
    window.onerror = (msg) => {
      if (typeof msg === 'string' && (msg.includes('Aborted') || msg.includes('_abort'))) {
        return true // suppress — we handle it via the promise rejection
      }
      return prevOnError ? (prevOnError as any)(...arguments) : false
    }
    // Also suppress unhandled promise rejections from Emscripten abort
    rejectHandler = (e: PromiseRejectionEvent) => {
      const reason = String(e.reason ?? '')
      if (reason.includes('Aborted') || reason.includes('_abort') || reason.includes('LinkError')) {
        e.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', rejectHandler)
  }

  try {
    const mod: any = await import('web-tree-sitter')
    // web-tree-sitter <0.22 exports a default function (the Parser class)
    // web-tree-sitter >=0.22 exports named { Parser, Language }
    const TSParser = mod.Parser ?? mod.default ?? mod

    // Resolve WASM URLs — default to /public/ paths served by Vite
    const tsWasm = opts?.treeSitterWasmUrl ?? '/tree-sitter.wasm'
    const rubyWasm = opts?.rubyWasmUrl ?? '/tree-sitter-ruby.wasm'

    // Race init with a 5-second timeout to avoid hanging in test environments
    const initWithTimeout = Promise.race([
      TSParser.init({
        locateFile: (_filename: string, _scriptDir: string) => tsWasm,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tree-sitter init timeout')), 5000)
      ),
    ])

    await initWithTimeout

    // Language is only available after init() in older versions
    const TSLanguage = mod.Language ?? TSParser.Language

    Parser = new TSParser()
    RubyLanguage = await TSLanguage.load(rubyWasm)
    Parser.setLanguage(RubyLanguage)
    return true
  } catch (err) {
    console.warn('[TreeSitter] Init failed, regex fallback will be used:', err)
    _initPromise = null // allow retry
    return false
  } finally {
    // Restore original error handlers
    if (isBrowser) {
      // Delay restore to catch any async Emscripten abort throws
      setTimeout(() => {
        window.onerror = prevOnError
        if (rejectHandler) window.removeEventListener('unhandledrejection', rejectHandler)
      }, 200)
    }
  }
}

/** Check if tree-sitter has been initialized. */
export function isTreeSitterReady(): boolean {
  return Parser !== null && RubyLanguage !== null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TreeSitterTranspileResult {
  code: string
  ok: boolean
  errors: string[]
}

/**
 * Transpile Sonic Pi Ruby code to JavaScript via tree-sitter AST fold.
 *
 * Requires `initTreeSitter()` to have completed successfully.
 * If tree-sitter is not ready, returns `{ ok: false }` so the caller
 * can fall back to the regex transpiler.
 */
/**
 * Depth-first search for the first ERROR or MISSING node in the tree — used to
 * locate the line of a parse failure that tree-sitter recovered from. Returns
 * null if none is found (caller only calls this when rootNode.hasError).
 */
function findFirstErrorNode(node: any): any | null {
  if (node.type === 'ERROR' || node.isMissing) return node
  for (let i = 0; i < node.childCount; i++) {
    const found = findFirstErrorNode(node.child(i))
    if (found) return found
  }
  return null
}

export function treeSitterTranspile(ruby: string): TreeSitterTranspileResult {
  if (!isTreeSitterReady()) {
    return { code: '', ok: false, errors: ['tree-sitter not initialized'] }
  }

  // Pre-process: Sonic Pi uses /text/ as single-line comments (Ruby regex syntax
  // repurposed). TreeSitter's Ruby grammar may parse these as division depending
  // on context. Convert to # comments before parsing so TreeSitter sees clean Ruby.
  ruby = ruby.split('\n').map(line => {
    const trimmed = line.trim()
    if (/^\/[^/].*\/$/.test(trimmed) && !/[=~<>!]/.test(trimmed)) {
      return line.replace(trimmed, `# ${trimmed.slice(1, -1).trim()}`)
    }
    return line
  }).join('\n')

  const tree = Parser.parse(ruby)
  const errors: string[] = []
  const ctx: TranspileContext = {
    source: ruby,
    errors,
    insideLoop: false,
    definedFunctions: new Set(),
    indent: '',
    inthreadLoopCounter: { n: 0 },
    fxLoopCounter: { n: 0 },
  }

  const js = transpileNode(tree.rootNode, ctx)

  // B2 (#389) — SV19 refuse-or-accept safety net. tree-sitter recovers from
  // malformed input (e.g. an unterminated string `puts "hello`) by inserting
  // ERROR/MISSING nodes, but those can sit as children of a node whose handler
  // only visits specific named fields (e.g. `call` reads identifier +
  // argument_list, skipping the orphaned-quote ERROR). The walker never visits
  // them, so no parse error is pushed and the malformed program silently
  // degrades while the next line's audio fires. `rootNode.hasError` is true iff
  // any ERROR/MISSING node exists anywhere in the tree — catch it here so the
  // run is refused with a syntax error rather than partially executed. Valid
  // heredocs and multi-line strings parse cleanly (hasError=false), so this
  // does not over-refuse.
  if (errors.length === 0 && tree.rootNode.hasError) {
    const bad = findFirstErrorNode(tree.rootNode)
    const line = (bad ?? tree.rootNode).startPosition.row + 1
    const snippet = (bad?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)
    errors.push(`Syntax error at line ${line}: your code could not be parsed${snippet ? ` (near \`${snippet}\`)` : ''}`)
  }

  // Validate output
  if (errors.length > 0) {
    return { code: js, ok: false, errors }
  }

  try {
    new Function(js)
    return { code: js, ok: true, errors: [] }
  } catch (e: any) {
    return { code: js, ok: false, errors: [`Invalid JS output: ${e.message}`] }
  }
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// AST walk context
// ---------------------------------------------------------------------------

interface TranspileContext {
  source: string
  errors: string[]
  insideLoop: boolean
  definedFunctions: Set<string>
  indent: string
  /** Current node's source line (1-based) for _srcLine injection */
  srcLine?: number
  /** Hoisted-loop counter for `loop do` inside `in_thread` (issue #205). */
  inthreadLoopCounter?: { n: number }
  /** Hoisted-loop counter for `loop do` inside `with_fx` (issue #426/SP111). */
  fxLoopCounter?: { n: number }
  /**
   * SP95(d) #393: true while transpiling the *direct* body of a live_loop,
   * whose wrapper arrow is emitted `async`. Lets `sync` emit `await __b.sync()`
   * (build-time cue resolution). Propagates through control-flow blocks
   * (if/for/times/each — same JS function scope) but MUST be reset to false at
   * every nested non-async function boundary (with_fx/in_thread/define/at/…),
   * or `await` would land in a non-async arrow → refused run.
   */
  asyncBody?: boolean
}

// ---------------------------------------------------------------------------
// DSL functions — split by where they actually exist
// ---------------------------------------------------------------------------

/**
 * Functions that exist as methods on ProgramBuilder.
 * Inside a loop, these get the `b.` prefix.
 */
const BUILDER_METHODS = new Set([
  // Core
  'play', 'sleep', 'wait', 'sample', 'sync', 'sync_bpm', 'cue', 'set', 'get',
  'use_synth', 'use_bpm', 'use_random_seed',
  'control', 'stop', 'live_audio',
  'with_fx', 'in_thread', 'at',
  'puts', 'print',
  // Random (resolved eagerly)
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in', 'rdist', 'rand_look',
  'shuffle', 'pick',
  // Tick (#211)
  'tick', 'look', 'tick_reset', 'tick_reset_all', 'tick_set',
  // Transpose
  'use_transpose', 'with_transpose',
  // Synth defaults / BPM / synth blocks
  'use_synth_defaults', 'use_sample_defaults', 'with_synth_defaults', 'with_sample_defaults',
  'with_bpm', 'with_synth', 'use_density',
  // Debug + latency
  'use_debug', 'use_real_time',
  // BPM scaling control
  'use_arg_bpm_scaling', 'with_arg_bpm_scaling',
  // Utility
  'factor_q', 'bools', 'play_pattern_timed', 'sample_duration', 'stretch', 'ramp',
  'hz_to_midi', 'midi_to_hz', 'quantise', 'quantize', 'octs',
  'kill', 'play_chord', 'play_pattern', 'tuplets',
  'with_octave', 'with_random_seed', 'with_density',
  'noteToMidi', 'midiToFreq', 'noteToFreq', 'note_info',
  // Data constructors
  'ring', 'knit', 'range', 'line', 'spread',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
  'chord_degree', 'degree', 'chord_names', 'scale_names',
  // OSC
  'osc_send',
  // Sample BPM
  'use_sample_bpm',
  // Tier B — timing introspection (#226). Per-task pure reads — must route
  // through __b so the value reflects the calling task, not engine state.
  'current_beat', 'current_beat_duration', 'current_time', 'current_sched_ahead_time',
  // Tier C PR #3 — bt/rt/vt (#255). Per-task pure reads (bt/rt depend on the
  // calling task's bpm; vt is a current_time alias). Inside live_loops the
  // task's __b carries the right bpm; top-level dslValues forward to topLevelBuilder.
  'bt', 'rt', 'vt',
  // Tier B — PRNG inspection (#227). Per-task RNG mutations — route through
  // __b so they hit the calling builder's seeded random stream.
  'current_random_seed', 'rand_back', 'rand_skip', 'rand_reset',
  // Tier B PR #2 — defaults / setting introspection (#233). Per-task pure
  // reads — route through __b so per-loop use_*_defaults are visible.
  'current_synth_defaults', 'current_sample_defaults',
  'current_arg_checks', 'current_debug', 'current_timing_guarantees',
  // Tier C PR #1 — state wrappers (#251). Imperative toggle/merge family
  // routes through __b so per-task state mutations don't leak to siblings.
  // Block forms are registered separately at the block-opener path below.
  'use_arg_checks', 'use_timing_guarantees',
  'use_merged_synth_defaults', 'use_merged_sample_defaults',
  'with_arg_checks', 'with_debug', 'with_timing_guarantees',
  'with_merged_synth_defaults', 'with_merged_sample_defaults',
  // Deferred-step DSL contract (issue #193 — must mirror methods on
  // ProgramBuilder so they fire at scheduled virtual time, not build time).
  'stop_loop', 'set_volume', 'use_osc', 'osc',
  'midi', 'midi_note_on', 'midi_note_off', 'midi_cc',
  'midi_pitch_bend', 'midi_channel_pressure', 'midi_poly_pressure',
  'midi_prog_change', 'midi_clock_tick',
  'midi_start', 'midi_stop', 'midi_continue',
  'midi_all_notes_off', 'midi_notes_off',
  // Tier B — recording (#228). Deferred so the lifecycle sequences against
  // the audio playback timeline. Building them at top-level immediate
  // would fire recording_save before any notes from the surrounding
  // `8.times do` had played, leaving the WAV empty.
  'recording_start', 'recording_stop', 'recording_save', 'recording_delete',
  // Tier C PR #3 — mixer setters (#255). Deferred so a `set_mixer_control!
  // lpf: 30; sleep 4; reset_mixer!` sweep sequences with playback. Same
  // lifecycle reasoning as set_volume (#197).
  'set_mixer_control', 'reset_mixer',
  // Budget
  '__checkBudget__',
])

/**
 * Functions that exist ONLY in the top-level execution scope
 * (injected by SonicPiEngine.evaluate), NOT on ProgramBuilder.
 * Inside a loop, these must NOT get the `b.` prefix —
 * they're captured from the enclosing scope via the Proxy.
 */
const TOP_LEVEL_SCOPE = new Set([
  'live_loop', 'stop_loop', 'define',
  'use_bpm', 'use_synth', 'use_random_seed', 'use_arg_bpm_scaling',
  'in_thread', 'at', 'density',
  'with_fx', 'with_arg_bpm_scaling',
  // Global store
  'set', 'get',
  // Sample catalog
  'sample_duration', 'sample_names', 'sample_groups', 'sample_loaded',
  // Output
  'puts', 'print', 'stop',
  // Volume & introspection
  'set_volume', 'current_synth', 'current_volume',
  // Catalog queries
  'synth_names', 'fx_names', 'all_sample_names',
  // Sample management
  'load_sample', 'sample_info',
  // Math / music theory
  'hz_to_midi', 'midi_to_hz', 'quantise', 'quantize', 'octs',
  'chord_degree', 'degree', 'chord_names', 'scale_names',
  'current_bpm',
  // Data constructors (also on builder, but available at top level)
  'ring', 'knit', 'range', 'line', 'spread',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
  // OSC
  'use_osc', 'osc', 'osc_send',
  // MIDI shorthand
  'midi',
  // Sample BPM
  'use_sample_bpm',
])

/**
 * Functions that don't exist on ProgramBuilder and have no runtime equivalent.
 * Transpile without `b.` prefix — they're no-ops or produce clear errors.
 */
const UNIMPLEMENTED_DSL = new Set([
  'load_samples', 'load_sample',
])

/**
 * No-arg DSL functions that Ruby code calls without parentheses.
 * When a bare identifier matches one of these, emit it as a function call.
 * e.g., `tick` → `__b.tick()`, `look` → `__b.look()`, `stop` → `b.stop()`
 */
const BARE_CALLABLE = new Set([
  'tick', 'look', 'stop', 'tick_reset_all',
  'rand', 'rand_i',
  'chord_names', 'scale_names',
  // Tier B — timing introspection (#226). Ruby calls these without parens.
  'current_beat', 'current_beat_duration', 'current_time', 'current_sched_ahead_time',
  // Tier B — PRNG inspection (#227). current_random_seed and rand_reset are
  // typically called without parens. rand_back / rand_skip take an optional
  // arg but are also valid bare (rand_back == rand_back(1)).
  'current_random_seed', 'rand_back', 'rand_skip', 'rand_reset',
  // Tier B — recording (#228). Three of the four are 0-arity and routinely
  // called bare (`recording_start`, not `recording_start()`). Inside a
  // BARE_DSL_CALLS-wrapped run-once block they need __b.recording_*()
  // emitted so the deferred step actually pushes onto the program.
  // `recording_save` always carries an arg and parses as a method_call,
  // so it doesn't need this list — but including it means a bare
  // `recording_save` (forgotten filename) trips the arity guard at build.
  'recording_start', 'recording_stop', 'recording_delete', 'recording_save',
  // Tier B PR #2 — defaults / setting introspection (#233). Routinely called
  // bare in user code (`puts current_debug`, `if current_arg_checks`).
  'current_synth_defaults', 'current_sample_defaults',
  'current_arg_checks', 'current_debug',
])

/**
 * Top-level no-arg functions that Ruby calls without parens.
 * These do NOT get the `b.` prefix — they're captured from enclosing scope.
 */
const BARE_CALLABLE_TOP_LEVEL = new Set([
  'current_bpm',
])

// Synth names that can be used as bare commands: `beep 60`
// 65 entries verified loadable from the `supersonic-scsynth-synthdefs` CDN
// via exp-001 (artifacts/investigations/exp-001-synth-audit.md, #156).
// `winwood_lead` is omitted — Desktop SP defines it (synthinfo.rb:3296) but
// the CDN package does not ship `sonic-pi-winwood_lead.scsyndef` (HTTP 404).
// `sine` and `mod_beep` also 404 on the CDN but are aliased at the SoundLayer
// to `beep` and `mod_sine` respectively (see SoundLayer.ts SYNTH_NAME_ALIASES).
const SYNTH_NAMES = new Set([
  'beep', 'sine', 'saw', 'pulse', 'subpulse', 'square', 'tri',
  'dsaw', 'dpulse', 'dtri', 'fm', 'mod_fm', 'mod_saw', 'mod_dsaw',
  'mod_sine', 'mod_beep', 'mod_tri', 'mod_pulse',
  'supersaw', 'hoover', 'prophet', 'zawa', 'dark_ambience', 'growl',
  'hollow', 'blade', 'piano', 'pluck', 'pretty_bell', 'dull_bell',
  'tech_saws', 'chipbass', 'chiplead', 'chipnoise',
  'tb303', 'bass_foundation', 'bass_highend',
  'organ_tonewheel', 'rhodey', 'rodeo', 'kalimba',
  'gabberkick',
  'noise', 'pnoise', 'bnoise', 'gnoise', 'cnoise',
  'sound_in', 'sound_in_stereo',
  'sc808_bassdrum', 'sc808_snare', 'sc808_clap',
  'sc808_tomlo', 'sc808_tommid', 'sc808_tomhi',
  'sc808_congalo', 'sc808_congamid', 'sc808_congahi',
  'sc808_rimshot', 'sc808_claves', 'sc808_maracas', 'sc808_cowbell',
  'sc808_closed_hihat', 'sc808_open_hihat', 'sc808_cymbal',
])

// ---------------------------------------------------------------------------
// Catamorphism — the exhaustive fold over the Ruby CST
// ---------------------------------------------------------------------------

function transpileNode(node: any, ctx: TranspileContext): string {
  const type: string = node.type

  switch (type) {
    // ---- Root ----
    case 'program':
      return transpileProgram(node, ctx)

    // ---- Literals ----
    case 'integer':
    case 'float':
      return node.text

    case 'true':
      return 'true'
    case 'false':
      return 'false'
    case 'nil':
      return 'null'
    case 'self':
      return 'this'

    case 'simple_symbol':
      // :name → "name"
      return `"${node.text.slice(1)}"`

    case 'hash_key_symbol':
      // name: (in hash) — just the identifier part
      return node.text.replace(/:$/, '')

    case 'string': {
      return transpileString(node, ctx)
    }

    case 'string_content':
      return node.text

    case 'escape_sequence':
      return node.text

    case 'interpolation': {
      // #{expr} → ${expr}
      const inner = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
        .join('')
      return '${' + inner + '}'
    }

    case 'symbol_array':
    case 'string_array':
      // %w(a b c) → ["a", "b", "c"] / %i(a b c) → ["a", "b", "c"]
      return `[${node.namedChildren.map((c: any) => `"${c.text}"`).join(', ')}]`

    case 'array': {
      const elements = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      return `[${elements.join(', ')}]`
    }

    case 'hash': {
      const pairs = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      return `{ ${pairs.join(', ')} }`
    }

    case 'pair': {
      const key = node.namedChildren[0]
      const value = node.namedChildren[1]
      const keyStr = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : transpileNode(key, ctx)
      return `${keyStr}: ${transpileNode(value, ctx)}`
    }

    case 'subarray':
      return `[${node.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')}]`

    // ---- Identifiers ----
    case 'identifier': {
      const name = node.text
      // Ruby nil/true/false handled above as their own node types
      if (name === 'nil') return 'null'
      if (name === 'true') return 'true'
      if (name === 'false') return 'false'

      // Only transform bare identifiers to calls in statement context
      const parentType = node.parent?.type
      const isStatement = parentType === 'body_statement' || parentType === 'program' ||
                          parentType === 'then' || parentType === 'block_body'

      // Bare identifier that matches a user-defined function → call it with __b
      if (isStatement && ctx.definedFunctions.has(name)) {
        return `${name}(__b)`
      }

      // Bare identifier that matches a known no-arg DSL function.
      // Ruby allows calling methods without parens: `tick` = `tick()`
      // This applies in any context (statement, argument, etc.)
      // because `tick`, `look`, `stop` are always function calls in Sonic Pi.
      if (BARE_CALLABLE.has(name)) {
        const prefix = ctx.insideLoop ? '__b.' : ''
        return `${prefix}${name}()`
      }

      // Top-level bare callables — no b. prefix, just append ()
      if (BARE_CALLABLE_TOP_LEVEL.has(name)) {
        return `${name}()`
      }

      // SP95(d) #350 slice 2: bare `get` identifier (e.g. the bracket form
      // `get[:k]` → element_reference whose object is the identifier `get`)
      // must route to the builder's vt-aware `get` Proxy inside a loop, so the
      // bracket read happens at the reader's current_time() (SV28-safe). The
      // call form `get(:k)` is handled via BUILDER_METHODS. At top level it
      // stays the sandbox closure (no prefix), which routes through the active
      // build builder.
      if (name === 'get' && ctx.insideLoop) {
        return '__b.get'
      }

      return name
    }

    case 'constant':
      return node.text

    case 'global_variable':
      return node.text

    case 'instance_variable':
      // @var → this._var
      return `this.${node.text.slice(1)}`

    case 'class_variable':
      return node.text

    // ---- Expressions ----
    case 'assignment': {
      const lhs = node.namedChildren[0]
      const rhs = node.namedChildren[1]
      const lhsStr = transpileNode(lhs, ctx)
      const rhsStr = transpileNode(rhs, ctx)

      // If RHS is __b.play or __b.sample, capture lastRef
      if (ctx.insideLoop && /^__b\.(play|sample)\(/.test(rhsStr)) {
        return `${rhsStr}; ${lhsStr} = __b.lastRef`
      }

      // Bare assignment (no let/const/var) — the Sandbox's Proxy `set` trap
      // captures it into scope-isolated storage. This matches Ruby semantics:
      // variables are mutable and re-assignable. Using `const` or `let` would
      // create a lexical binding invisible to the Proxy, breaking scope isolation.
      return `${lhsStr} = ${rhsStr}`
    }

    case 'operator_assignment': {
      const lhs = node.namedChildren[0]
      const op = node.children.find((c: any) => c.type.endsWith('=') && c.type !== 'identifier')
      const rhs = node.namedChildren[1]
      const opText = op ? op.text : '+='
      return `${transpileNode(lhs, ctx)} ${opText} ${transpileNode(rhs, ctx)}`
    }

    case 'conditional': {
      // ternary: a ? b : c
      const cond = node.namedChildren[0]
      const trueBranch = node.namedChildren[1]
      const falseBranch = node.namedChildren[2]
      return `${transpileNode(cond, ctx)} ? ${transpileNode(trueBranch, ctx)} : ${transpileNode(falseBranch, ctx)}`
    }

    case 'binary': {
      const left = node.namedChildren[0]
      const right = node.namedChildren[1]
      const op = node.children.find((c: any) => !c.isNamed)?.text
        ?? node.children[1]?.text ?? '+'

      // Ruby `and`/`or` → JS `&&`/`||`
      const jsOp = op === 'and' ? '&&'
        : op === 'or' ? '||'
        : op === '**' ? '**'
        : op

      if (op === '**') {
        return `Math.pow(${transpileNode(left, ctx)}, ${transpileNode(right, ctx)})`
      }

      const lhs = transpileNode(left, ctx)
      const rhs = transpileNode(right, ctx)

      // Sonic Pi operator helpers — handle note strings (:c3→48),
      // Ring arithmetic (ring*3→repeat, ring+ring→concat),
      // and note+array mapping (:c3+[0,7,11]→[48,55,59]).
      if (op === '+') return `__spAdd(${lhs}, ${rhs})`
      if (op === '-') return `__spSub(${lhs}, ${rhs})`
      if (op === '*') return `__spMul(${lhs}, ${rhs})`

      return `${lhs} ${jsOp} ${rhs}`
    }

    case 'unary': {
      const operand = node.namedChildren[0]
      const op = node.children[0]?.text ?? '-'
      // defined? x → typeof x !== 'undefined'
      if (op === 'defined?') return `(typeof ${transpileNode(operand, ctx)} !== 'undefined')`
      const jsOp = op === 'not' ? '!' : op
      return `${jsOp}${transpileNode(operand, ctx)}`
    }

    case 'parenthesized_statements': {
      const inner = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      if (inner.length === 1) return `(${inner[0]})`
      return `(${inner.join(', ')})`
    }

    case 'range': {
      // (a..b) — used for note ranges, slicing, etc.
      const from = transpileNode(node.namedChildren[0], ctx)
      const to = transpileNode(node.namedChildren[1], ctx)
      const exclusive = node.text.includes('...')
      if (exclusive) {
        return `Array.from({length: ${to} - ${from}}, (_, _i) => ${from} + _i)`
      }
      return `Array.from({length: ${to} - ${from} + 1}, (_, _i) => ${from} + _i)`
    }

    // ---- Method calls — the heart of the DSL ----
    case 'call':
    case 'method_call': {
      return transpileMethodCall(node, ctx)
    }

    case 'argument_list': {
      return transpileArgList(node, ctx)
    }

    case 'element_reference': {
      // a[b]
      const obj = transpileNode(node.namedChildren[0], ctx)
      // Handle range slice: a[1..-1] → a.slice(1)
      if (node.namedChildren[1]?.type === 'range') {
        const rangeNode = node.namedChildren[1]
        const from = transpileNode(rangeNode.namedChildren[0], ctx)
        const toNode = rangeNode.namedChildren[1]
        const toStr = transpileNode(toNode, ctx)
        // Negative index: a[1..-1] → a.slice(1)
        if (toStr === '-1' || (toNode.type === 'unary' && toNode.namedChildren[0]?.text === '1')) {
          return `${obj}.slice(${from})`
        }
        // Other negative: a[0..-2] → a.slice(0, -1)
        if (toStr.startsWith('-')) {
          const absVal = parseInt(toStr.slice(1))
          return `${obj}.slice(${from}, ${-(absVal - 1) || undefined})`
        }
        return `${obj}.slice(${from}, ${toStr} + 1)`
      }
      const args = node.namedChildren.slice(1)
        .map((c: any) => transpileNode(c, ctx))
      return `${obj}[${args.join(', ')}]`
    }

    case 'scope_resolution':
      return transpileScopeResolution(node, ctx)

    // Ruby splat `*expr` → JS spread `...expr` (works in array literals
    // and call arguments — same surface as Ruby's common usage).
    case 'splat_argument': {
      const child = node.namedChildren[0]
      return child ? `...${transpileNode(child, ctx)}` : '...'
    }

    // ---- Blocks ----
    case 'do_block':
    case 'block': {
      return transpileBlockBody(node, ctx)
    }

    case 'block_parameters': {
      const params = node.namedChildren.map((c: any) => transpileNode(c, ctx))
      return params.join(', ')
    }

    case 'block_body':
    case 'body_statement': {
      return transpileChildren(node, ctx)
    }

    // ---- Control flow ----
    case 'if': {
      return transpileIf(node, ctx)
    }

    case 'unless': {
      return transpileUnless(node, ctx)
    }

    case 'if_modifier': {
      // statement if condition
      const body = node.namedChildren[0]
      const cond = node.namedChildren[1]
      return `if (${transpileNode(cond, ctx)}) { ${transpileNode(body, ctx)} }`
    }

    case 'unless_modifier': {
      const body = node.namedChildren[0]
      const cond = node.namedChildren[1]
      return `if (!(${transpileNode(cond, ctx)})) { ${transpileNode(body, ctx)} }`
    }

    case 'while': {
      const cond = node.namedChildren[0]
      const bodyNode = node.namedChildren[1]
      const bodyCtx = { ...ctx }
      const bodyStr = bodyNode ? transpileNode(bodyNode, bodyCtx) : ''
      return `while (${transpileNode(cond, ctx)}) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'until': {
      const cond = node.namedChildren[0]
      const bodyNode = node.namedChildren[1]
      const bodyStr = bodyNode ? transpileNode(bodyNode, ctx) : ''
      return `while (!(${transpileNode(cond, ctx)})) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'for': {
      const varNode = node.namedChildren[0]
      const iterNode = node.namedChildren[1]
      const bodyNode = node.namedChildren[2]
      const bodyStr = bodyNode ? transpileNode(bodyNode, ctx) : ''
      return `for (const ${transpileNode(varNode, ctx)} of ${transpileNode(iterNode, ctx)}) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'case': {
      return transpileCase(node, ctx)
    }

    case 'when': {
      // Handled inside transpileCase
      return ''
    }

    case 'else':
      // Handled by if/case
      return ''

    case 'then':
      return transpileChildren(node, ctx)

    case 'begin': {
      return transpileBeginRescue(node, ctx)
    }

    case 'rescue':
    case 'ensure':
      // Handled inside transpileBeginRescue
      return ''

    case 'return': {
      const val = node.namedChildren[0]
      if (val) return `return ${transpileNode(val, ctx)}`
      return 'return'
    }

    // ---- Method/function definitions ----
    case 'method': {
      // def name(args) ... end — not the DSL's `define`, but allowed (#382).
      const nameNode = node.namedChildren[0]
      const params = node.namedChildren.find((c: any) => c.type === 'method_parameters')
      const body = node.namedChildren.find((c: any) => c.type === 'body_statement')
      // Register the def name BEFORE transpiling the body so a recursive
      // self-call (and any in-scope reference after the def) resolves to a JS
      // call `name(__b)` instead of a bare reference. Without this, the body
      // of `def f; f; end` emitted `function f() { f }` — valid JS that does
      // nothing — and unconditional recursion never tripped a stack overflow,
      // so the user saw silent acceptance of demonstrably broken Ruby (#382).
      ctx.definedFunctions.add(nameNode.text)
      const paramStr = params
        ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')
        : ''
      const bodyStr = body ? transpileNode(body, ctx) : ''
      return `function ${nameNode.text}(${paramStr}) {\n${bodyStr}\n${ctx.indent}}`
    }

    // ---- Lambda ----
    case 'lambda': {
      // ->(x) { x * 2 } → (x) => { return x * 2 }
      const params = node.namedChildren.find((c: any) => c.type === 'lambda_parameters' || c.type === 'block_parameters')
      const body = node.namedChildren.find((c: any) => c.type === 'block' || c.type === 'do_block') ?? node.namedChildren[node.namedChildCount - 1]
      const paramStr = params ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ') : ''
      const bodyStr = body ? transpileNode(body, ctx) : ''
      return `(${paramStr}) => { ${bodyStr} }`
    }

    // ---- Block argument (&:method → (x) => x.method()) ----
    case 'block_argument': {
      const inner = node.namedChildren[0]
      if (inner?.type === 'simple_symbol') {
        const method = inner.text.slice(1) // strip :
        return `(__x) => __x.${method}()`
      }
      return transpileNode(inner, ctx)
    }

    // ---- Multiple assignment: a, b = [1, 2] → [a, b] = [1, 2] ----
    case 'left_assignment_list': {
      const vars = node.namedChildren.map((c: any) => transpileNode(c, ctx))
      return `[${vars.join(', ')}]`
    }

    // ---- Splat/rest ----
    case 'splat_parameter':
    case 'rest_assignment':
      return `...${node.namedChildren[0]?.text ?? ''}`

    case 'keyword_parameter': {
      const name = node.namedChildren[0]?.text ?? ''
      const defaultVal = node.namedChildren[1]
      if (defaultVal) return `${name} = ${transpileNode(defaultVal, ctx)}`
      return name
    }

    case 'optional_parameter': {
      const name = node.namedChildren[0]?.text ?? ''
      const defaultVal = node.namedChildren[1]
      if (defaultVal) return `${name} = ${transpileNode(defaultVal, ctx)}`
      return name
    }

    case 'destructured_parameter':
      return node.text

    // ---- Comments ----
    case 'comment':
      return `//${node.text.slice(1)}`

    // Sonic Pi uses /text/ as multi-line comments. Ruby's grammar parses
    // these as regex literals. Convert to JS comments.
    case 'regex':
      return `// ${node.text.slice(1, -1).trim()}`

    // ---- Misc ----
    case 'expression_statement':
      return transpileChildren(node, ctx)

    case 'empty_statement':
      return ''

    case 'ERROR': {
      ctx.errors.push(`Parse error at line ${node.startPosition.row + 1}: ${node.text.slice(0, 50)}`)
      return `/* PARSE ERROR: ${node.text.slice(0, 30)} */`
    }

    // ---- Default: structural wrapper OR unsupported feature ----
    // Only nodes in STRUCTURAL_WRAPPERS silently pass through. Everything
    // else flags via pushUnsupported so the user gets a report link instead
    // of a cryptic JS parser error downstream. This closes the silent-leak
    // path where an unknown node with namedChildren would recurse and emit
    // malformed JS (e.g., `Math::PI` → `Math::PI` → "Unexpected token ':'").
    default: {
      if (STRUCTURAL_WRAPPERS.has(node.type)) {
        return node.namedChildCount > 0 ? transpileChildren(node, ctx) : node.text
      }
      if (node.text.trim()) {
        pushUnsupported(
          ctx, node,
          node.type,
          `Ruby construct \`${node.type}\` isn't supported yet`,
        )
      }
      return 'undefined'
    }
  }
}

// ---------------------------------------------------------------------------
// Program root handler — wraps bare DSL calls in an implicit live_loop
// ---------------------------------------------------------------------------

// Bare DSL calls that trigger wrapping in an implicit `live_loop :__run_once`.
// These are calls that need a ProgramBuilder (`__b`) in scope.
// This list replaces the regex detection in the old `wrapBareCode` preprocessor (#125).
const BARE_DSL_CALLS = new Set([
  'play', 'sleep', 'sample', 'cue', 'sync',
  'puts', 'print', 'control', 'kill', 'synth',
  'play_chord', 'play_pattern', 'play_pattern_timed',
  'use_synth_defaults', 'use_sample_defaults', 'use_transpose',
  // Tier B — recording (#228). Bare top-level recording_* triggers the
  // implicit live_loop :__run_once wrapper so __b is in scope; the
  // resulting __b.recording_* calls fire as deferred steps at scheduled
  // virtual time.
  'recording_start', 'recording_stop', 'recording_save', 'recording_delete',
])
// Top-level `loop do … end` is NOT bare code — it is its own scheduler-owned
// live_loop (auto-named below). Wrapping it in `__run_once` would trap the
// run_once iteration inside `while(true)` and the loop would never yield
// (SV16 — bare code runs once, not forever). Detected via `hasBareLoop` below.
// Settings that are safe to hoist above the bare-code wrapper — they are typically
// set once and not interleaved with plays. `use_synth` is deliberately NOT here:
// it is flow-sensitive (users change it between plays), so hoisting it would
// collapse all plays to the last use_synth value (#164).
const TOP_LEVEL_SETTINGS = new Set(['use_bpm', 'use_random_seed', 'use_debug', 'use_arg_bpm_scaling'])

// #419/SV55: extract a literal synth name from a `use_synth :X` / `use_synth "X"`
// call. Returns the bare name for a literal symbol/string arg, or null for a
// non-literal (runtime expression) arg — in which case the synth cannot be
// known at build time and NO eager prefix may be emitted (do not guess).
function extractLiteralSynthArg(callNode: any): string | null {
  const argsNode = callNode.childForFieldName('arguments')
  const argNode = argsNode?.namedChildren?.[0]
  if (!argNode) return null
  if (argNode.type === 'simple_symbol') return argNode.text.slice(1)
  if (argNode.type === 'string') return argNode.text.replace(/['"]/g, '')
  return null
}

function transpileProgram(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren

  // Check if there are bare DSL calls at the top level
  // Also detect .times do, .each do blocks, and bare with_fx (no live_loop inside)
  const hasBareCode = children.some((c: any) => {
    if (c.type === 'call' || c.type === 'method_call') {
      const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
      if (BARE_DSL_CALLS.has(method)) return true
      // .times do / .each do — method_call on a receiver
      if (method === 'times' || method === 'each') return true
    }
    return false
  })
  // Also check for bare with_fx that doesn't contain live_loops
  const hasBareFx = children.some((c: any) => {
    if (c.type !== 'call' && c.type !== 'method_call') return false
    const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
    if (method !== 'with_fx') return false
    // Check if with_fx contains a live_loop — if so, it's a block, not bare
    const text = c.text ?? ''
    if (/live_loop/.test(text)) return false
    // #426/SP111: a with_fx wrapping a bare `loop do` is ALSO a registering
    // block (the loop is hoisted to an auto-named live_loop inside the fx),
    // NOT bare code. Routing it through __run_once would emit a synchronous
    // build-time `while(true)` → infinite Step[] push → renderer OOM.
    const wfBlk = c.namedChildren.find((x: any) => x.type === 'do_block' || x.type === 'block')
    return !(wfBlk && blockBodyHasBareLoop(wfBlk))
  })
  // Top-level `loop do … end` triggers the split so it can be hoisted to a
  // named live_loop. Without this flag, a program that contains only
  // `loop do … end` would bypass the split and emit bare `while(true)` at
  // the program root — no scheduler, no sleep yielding, browser hang (#190).
  const hasBareLoop = children.some((c: any) => {
    if (c.type !== 'call' && c.type !== 'method_call') return false
    const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
    if (method !== 'loop') return false
    return c.namedChildren.some((x: any) => x.type === 'do_block' || x.type === 'block')
  })

  if (!hasBareCode && !hasBareFx && !hasBareLoop) {
    // No wrapping needed — transpile all children normally
    return transpileChildren(node, ctx)
  }

  // Separate top-level settings from bare code
  const topLevel: any[] = []
  const bareCode: any[] = []
  const blocks: any[] = []

  // #419/SV55: track the top-level `use_synth` in SOURCE ORDER so each block
  // inherits the synth in effect at its definition point (desktop fork-snapshot
  // parity, runtime.rb:1067). `blockSynth` tags each registration-capturing
  // block with the synth that was current when it appeared. use_synth still
  // flows to bareCode (deferred) for bare-play interleave — this only records.
  let currentTopSynth: string | null = null
  const blockSynth = new Map<any, string | null>()

  for (const child of children) {
    if (child.type === 'comment') {
      bareCode.push(child)
      continue
    }
    const method = (child.type === 'call' || child.type === 'method_call')
      ? (child.childForFieldName('method')?.text ?? child.namedChildren[0]?.text)
      : null

    // #419/SV55: a top-level `use_synth` advances the source-order synth. A
    // non-literal arg yields null (unknowable at build time → no eager prefix).
    if (method === 'use_synth') {
      currentTopSynth = extractLiteralSynthArg(child)
    }

    // Bare with_fx (no live_loop inside) should be treated as bare code, not a
    // block — UNLESS it wraps a bare `loop do`, which is hoisted to a live_loop
    // inside the fx (#426/SP111). Mirrors the hasBareFx check above.
    const wfBlk = method === 'with_fx'
      ? child.namedChildren.find((x: any) => x.type === 'do_block' || x.type === 'block')
      : null
    const isBareFxNode = method === 'with_fx'
      && !/live_loop/.test(child.text ?? '')
      && !(wfBlk && blockBodyHasBareLoop(wfBlk))

    // Bare top-level `loop do … end` — route to blocks and emit below as a
    // dedicated auto-named live_loop (SV16 — do not let the loop become
    // bare while(true) inside the __run_once wrapper).
    const isBareLoopNode = method === 'loop' &&
      child.namedChildren.some((c: any) => c.type === 'do_block' || c.type === 'block')

    if (method && TOP_LEVEL_SETTINGS.has(method)) {
      topLevel.push(child)
    // `comment` and `uncomment` are control-flow (like if-true/if-false), NOT
    // structural blocks. They stay in bareCode so their content gets the __b.
    // prefix when wrapped. Separating them would produce bare `play()` at top level.
    } else if (method && !isBareFxNode && (method === 'live_loop' || method === 'define' || method === 'ndefine' || method === 'defonce' || method === 'with_fx' ||
                          method === 'in_thread' || isBareLoopNode)) {
      blocks.push(child)
      blockSynth.set(child, currentTopSynth)
    } else {
      bareCode.push(child)
    }
  }

  // Pre-scan `define` blocks to collect function names BEFORE transpiling bareCode.
  // Without this, bare calls to user-defined functions (e.g., `my_melody`) inside the
  // __run_once wrapper would not be recognized and would emit without `(__b)` args.
  for (const child of blocks) {
    const m = (child.type === 'call' || child.type === 'method_call')
      ? (child.childForFieldName('method')?.text ?? child.namedChildren[0]?.text)
      : null
    if (m === 'define' || m === 'ndefine') {
      const argsNode = child.childForFieldName('arguments')
      const nameNode = argsNode?.namedChildren?.[0]
      if (nameNode) {
        const funcName = nameNode.type === 'simple_symbol'
          ? nameNode.text.slice(1)
          : nameNode.type === 'string' ? nameNode.text.replace(/['"]/g, '') : nameNode.text
        ctx.definedFunctions.add(funcName)
      }
    }
  }

  // Transpile top-level settings
  const topJS = topLevel.map(c => transpileNode(c, ctx)).filter(Boolean)

  // Transpile bare code inside an implicit in_thread (runs once, not forever)
  // Desktop SP runs bare code once — thread terminates at end.
  // SP95(d): bare top-level code runs inside an async `__run_once` live_loop,
  // so `await __b.sync()` is legal there too.
  const bareCtx: TranspileContext = { ...ctx, insideLoop: true, asyncBody: true }
  const bareJS = bareCode
    .map(c => '  ' + transpileNode(c, bareCtx))
    .filter(s => s.trim())

  // Transpile block-level constructs. Top-level bare `loop do … end` blocks
  // are hoisted to auto-named live_loops so the scheduler owns their cadence
  // (SV16 — bare code runs once, not forever; `loop do` is its own forever
  // live_loop, not fall-through-to-`__run_once` bare code).
  let topLoopCounter = 0
  // #419/SV55: tracks the last EAGER use_synth value emitted, so a run of
  // loops sharing the same source-order synth emits the prefix only once
  // (defaultSynth persists across registrations at runtime).
  let lastEagerSynth: string | null = null
  const blockJS = blocks.map(c => {
    const m = (c.type === 'call' || c.type === 'method_call')
      ? (c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text)
      : null
    // #419/SV55 + #421: emit an eager top-level `use_synth("X")` (→
    // topLevelUseSynth → defaultSynth) immediately before registration-
    // capturing blocks so the loop registers with the source-order synth
    // (SonicPiEngine.ts:879). Covers every block that registers a loop at
    // depth 0 reading defaultSynth: live_loop, auto-named bare loop, top-level
    // in_thread (topLevelInThread → fxAwareWrappedLiveLoop, same path), and
    // with_fx whose inner live_loop registers synchronously inside the fx
    // callback. NOT `use_synth` INSIDE an in_thread body (that mutates the
    // in_thread builder and reaches nested loops via SP72's parentBuilder path,
    // SV28) — only the top-level source-order synth is tracked in
    // `currentTopSynth`. A with_fx node only reaches `blocks` when it contains a
    // live_loop (else it is bareCode), so `m === 'with_fx'` here always wraps a
    // registering loop. Skipped for non-literal args (tagged === null) and when
    // the value is unchanged from the last eager emit.
    const tagged = blockSynth.get(c) ?? null
    let eagerPrefix = ''
    if (tagged !== null &&
        (m === 'live_loop' || m === 'loop' || m === 'in_thread' || m === 'with_fx') &&
        tagged !== lastEagerSynth) {
      eagerPrefix = `use_synth(${JSON.stringify(tagged)})\n`
      lastEagerSynth = tagged
    }
    if (m === 'loop') {
      const body = c.namedChildren.find((x: any) => x.type === 'do_block' || x.type === 'block')
      if (body) {
        const bodyCtx: TranspileContext = { ...ctx, insideLoop: true, asyncBody: true }
        const bodyStr = transpileBlockBody(body, bodyCtx)
        const name = `__loop_${topLoopCounter++}`
        return `${eagerPrefix}live_loop("${name}", async (__b) => {\n${bodyStr}\n${ctx.indent}})`
      }
    }
    return eagerPrefix + transpileNode(c, ctx)
  }).filter(Boolean)

  const parts: string[] = []
  if (topJS.length > 0) parts.push(topJS.join('\n'))
  if (bareJS.length > 0) {
    parts.push(`live_loop("__run_once", async (__b) => {\n${bareJS.join('\n')}\n  __b.stop()\n})`)
  }
  if (blockJS.length > 0) parts.push(blockJS.join('\n'))

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Method call handling — this is where most DSL dispatch happens
// ---------------------------------------------------------------------------

function transpileMethodCall(node: any, ctx: TranspileContext): string {
  // tree-sitter method_call: receiver.method(args) or receiver.method
  // tree-sitter call: method(args) or method arg1, arg2 (no receiver)

  const type = node.type

  // Bare method call: `method args` (no receiver, no parens)
  if (type === 'call' || type === 'method_call') {
    const receiver = node.childForFieldName('receiver')
    const methodNode = node.childForFieldName('method')
    const argsNode = node.childForFieldName('arguments')
    const blockNode = node.namedChildren.find((c: any) =>
      c.type === 'do_block' || c.type === 'block')

    // --- Receiver.method call ---
    if (receiver && methodNode) {
      return transpileReceiverMethodCall(receiver, methodNode, argsNode, blockNode, node, ctx)
    }

    // --- Bare method call (no receiver) ---
    // Strip Ruby bang (!) from method names: set_volume! → set_volume
    const rawMethodName = methodNode?.text ?? node.namedChildren[0]?.text ?? node.text
    const methodName = rawMethodName.endsWith('!') ? rawMethodName.slice(0, -1) : rawMethodName

    // live_loop :name do ... end
    if (methodName === 'live_loop') {
      return transpileLiveLoop(node, argsNode, blockNode, ctx)
    }

    // define :name do |args| ... end  (and ndefine — same surface, doesn't persist; #211/#215)
    if (methodName === 'define' || methodName === 'ndefine') {
      return transpileDefine(node, argsNode, blockNode, ctx, methodName)
    }

    // defonce :name, override: true do ... end  (#212 / #233)
    if (methodName === 'defonce') {
      return transpileDefonce(node, argsNode, blockNode, ctx)
    }

    // with_fx :name, opts do ... end
    if (methodName === 'with_fx' || methodName === 'with_synth' || methodName === 'with_bpm' || methodName === 'with_transpose' || methodName === 'with_arg_bpm_scaling' || methodName === 'with_synth_defaults' || methodName === 'with_sample_defaults' || methodName === 'with_random_seed' || methodName === 'with_octave' || methodName === 'with_density' || methodName === 'with_arg_checks' || methodName === 'with_debug' || methodName === 'with_timing_guarantees' || methodName === 'with_merged_synth_defaults' || methodName === 'with_merged_sample_defaults') {
      return transpileWithBlock(methodName, argsNode, blockNode, ctx)
    }

    // in_thread do ... end
    if (methodName === 'in_thread') {
      return transpileInThread(argsNode, blockNode, ctx)
    }

    // at [times], [values] do |params| ... end
    if (methodName === 'at') {
      return transpileAt(argsNode, blockNode, ctx)
    }

    // time_warp offset do ... end
    if (methodName === 'time_warp') {
      return transpileTimeWarp(argsNode, blockNode, ctx)
    }

    // tuplets [list], opts do |x| ... end  (#233)
    if (methodName === 'tuplets') {
      return transpileTuplets(argsNode, blockNode, ctx)
    }

    // assert_error do … end → assert_error((__b) => { … })  (#216)
    if (methodName === 'assert_error' && blockNode) {
      const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
      const bodyStr = transpileBlockBody(blockNode, bodyCtx)
      return `assert_error((__b) => {\n${bodyStr}\n${ctx.indent}})`
    }

    // density N do ... end
    if (methodName === 'density') {
      return transpileDensity(argsNode, blockNode, ctx)
    }

    // uncomment do ... end → emit the body
    if (methodName === 'uncomment') {
      if (blockNode) {
        const bodyCtx = { ...ctx }
        return transpileBlockBody(blockNode, bodyCtx)
      }
      return ''
    }

    // comment do ... end → skip
    if (methodName === 'comment') {
      return '/* commented out */'
    }

    // loop do ... end  OR  loop { ... }
    if (methodName === 'loop') {
      const block = blockNode ?? node.namedChildren.find((c: any) => c.type === 'block')
      if (block) {
        const bodyStr = transpileBlockBody(block, ctx)
        return `while (true) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
      }
    }

    // stop
    if (methodName === 'stop') {
      return '__b.stop()'
    }

    // stop_loop :name — dispatched via BUILDER_METHODS so it gets `__b.`
    // prefix inside loops (deferred step at scheduled virtual time, not
    // build time). See issue #194.

    // use_synth :name
    if (methodName === 'use_synth') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? '__b.' : ''
      return `${prefix}use_synth(${args})`
    }

    // use_bpm N
    if (methodName === 'use_bpm') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? '__b.' : ''
      return `${prefix}use_bpm(${args})`
    }

    // use_random_seed N
    if (methodName === 'use_random_seed') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? '__b.' : ''
      return `${prefix}use_random_seed(${args})`
    }

    // use_synth_defaults / use_sample_defaults — all args become a single opts object
    if (methodName === 'use_synth_defaults' || methodName === 'use_sample_defaults') {
      const args = argsNode ? transpileArgListAsOpts(argsNode, ctx) : '{}'
      const prefix = ctx.insideLoop ? '__b.' : ''
      return `${prefix}${methodName}(${args})`
    }

    // load_samples / load_sample — no-op
    if (methodName === 'load_samples' || methodName === 'load_sample') {
      return '/* load_samples: no-op in browser */'
    }

    // osc_send — emit to host-provided handler
    if (methodName === 'osc_send') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? '__b.' : ''
      return `${prefix}osc_send(${args})`
    }

    // synth command: `synth :name, opts`
    if (methodName === 'synth') {
      return transpileSynthCommand(argsNode, ctx)
    }

    // Bare synth name: `beep 60, release: 0.3`
    if (SYNTH_NAMES.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `__b.play(${args}, { synth: "${methodName}" })`
    }

    // User-defined function call
    if (ctx.definedFunctions.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(__b${args ? ', ' + args : ''})`
    }

    // Methods ending with ? — rename to _q, with b. prefix (on ProgramBuilder)
    if (methodName.endsWith('?')) {
      const cleanName = methodName.slice(0, -1) + '_q'
      const prefix = ctx.insideLoop ? '__b.' : ''
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${prefix}${cleanName}(${args})`
    }

    // SP95(d) #393: `sync` resolves a cue payload at BUILD time (returns the
    // payload), so `e = sync :beat; e[:val]` and `play get(:root)` after a
    // bare `sync` read fresh state. Emit `await` only inside an async live_loop
    // body (asyncBody) — inside with_fx/define/in_thread the arrow is not async,
    // so sync there falls back to the (non-awaited) runtime-step path. sync_bpm
    // keeps the runtime step (returns this); awaiting a non-thenable is identity.
    if ((methodName === 'sync' || methodName === 'sync_bpm') && ctx.asyncBody) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `await __b.${methodName}(${args})`
    }

    // --- Dispatch by which set the function belongs to ---

    // Functions that exist on ProgramBuilder → b.method() inside loops
    if (BUILDER_METHODS.has(methodName)) {
      const prefix = ctx.insideLoop ? '__b.' : ''
      // Inject _srcLine for play/sample for friendly error source mapping
      const needsSrcLine = methodName === 'play' || methodName === 'sample'
      const nodeCtx = { ...ctx, srcLine: node.startPosition.row + 1 }
      const args = argsNode ? transpileArgList(argsNode, nodeCtx, needsSrcLine) : ''
      return `${prefix}${methodName}(${args})`
    }

    // Functions that exist only at top-level scope → never b. prefix
    // (captured from enclosing scope via the Proxy)
    if (TOP_LEVEL_SCOPE.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(${args})`
    }

    // Unimplemented DSL functions → emit without b. prefix
    // (will be undefined at runtime — clear error message)
    if (UNIMPLEMENTED_DSL.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(${args})`
    }

    // Generic: unknown bare function call — emit as-is
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${methodName}(${args})`
  }

  return node.text
}

// ---------------------------------------------------------------------------
// Receiver.method calls: a.b(args) / a.b / a.b do ... end
// ---------------------------------------------------------------------------

function transpileReceiverMethodCall(
  receiver: any, methodNode: any, argsNode: any, blockNode: any,
  fullNode: any, ctx: TranspileContext
): string {
  const method = methodNode.text
  const recStr = transpileNode(receiver, ctx)

  // N.times do |i| ... end
  if (method === 'times' && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const varName = params?.namedChildren[0]?.text ?? '_i'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    return `for (let ${varName} = 0; ${varName} < ${recStr}; ${varName}++) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
  }

  // .each do |item| ... end  /  .each do |a, b| ... end (destructure)
  // Multi-arg block over a tuple-yielding iterator (e.g. arr.zip(b).each do |a, b|)
  // emits JS array destructure: for (const [a, b] of iter).
  if (method === 'each' && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const paramNames = params?.namedChildren?.map((c: any) => c.text) ?? []
    const bodyStr = transpileBlockBody(blockNode, ctx)
    const bindings = paramNames.length === 0 ? '_item'
      : paramNames.length === 1 ? paramNames[0]
      : `[${paramNames.join(', ')}]`
    return `for (const ${bindings} of ${recStr}) {\n${ctx.indent}  __b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
  }

  // .each_with_index do |item, i| ... end → for (let i = 0; ...) { const item = arr[i]; ... }
  if (method === 'each_with_index' && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const itemVar = params?.namedChildren[0]?.text ?? '_item'
    const idxVar = params?.namedChildren[1]?.text ?? '_i'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    const arrTmp = `__ewi_${ctx.indent.length}`
    return `{ const ${arrTmp} = ${recStr}; for (let ${idxVar} = 0; ${idxVar} < ${arrTmp}.length; ${idxVar}++) {\n${ctx.indent}  __b.__checkBudget__()\n${ctx.indent}  const ${itemVar} = ${arrTmp}[${idxVar}]\n${bodyStr}\n${ctx.indent}} }`
  }

  // .map/.select/.reject/.collect do |item| ... end
  if ((method === 'map' || method === 'select' || method === 'reject' || method === 'collect') && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const varName = params?.namedChildren[0]?.text ?? '_item'
    const jsMethod = (method === 'select' || method === 'reject') ? 'filter' : 'map'
    const isReject = method === 'reject'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    const negation = isReject ? '!' : ''
    return `${recStr}.${jsMethod}((${varName}) => ${negation}(${bodyStr}))`
  }

  // .map { |item| expr } — inline block
  if ((method === 'map' || method === 'select' || method === 'reject' || method === 'collect') && !blockNode) {
    // If there's an inline block child
    const inlineBlock = fullNode.namedChildren.find((c: any) => c.type === 'block')
    if (inlineBlock) {
      const params = inlineBlock.namedChildren.find((c: any) => c.type === 'block_parameters')
      const varName = params?.namedChildren[0]?.text ?? '_item'
      const jsMethod = (method === 'select' || method === 'reject') ? 'filter' : 'map'
      const isReject = method === 'reject'
      const bodyStr = transpileBlockBody(inlineBlock, ctx)
      const negation = isReject ? '!' : ''
      return `${recStr}.${jsMethod}((${varName}) => ${negation}(${bodyStr}))`
    }
  }

  // .tick / .tick() → .at(__b.tick())
  // Use optional chaining (?.) so undefined receivers (e.g. npat when no case matched) return undefined instead of crashing
  if (method === 'tick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    if (args) return `${recStr}?.at(__b.tick(${args}))`
    return `${recStr}?.at(__b.tick())`
  }

  // .look / .look() → .at(__b.look())
  if (method === 'look') {
    return `${recStr}?.at(__b.look())`
  }

  // .choose → b.choose(receiver) — works on both arrays and Rings
  if (method === 'choose') {
    return `__b.choose(${recStr})`
  }

  // .reverse → .reverse()
  if (method === 'reverse') {
    return `${recStr}.reverse()`
  }

  // .shuffle → b.shuffle(receiver) — works on both arrays and Rings
  if (method === 'shuffle') {
    return `__b.shuffle(${recStr})`
  }

  // .mirror(n) / .reflect(n) → thread the optional repeat arg (desktop
  // core.rb:796-805 both take n=1). #354 — was hardcoded `.mirror()`,
  // silently dropping `n`.
  if (method === 'mirror' || method === 'reflect') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.${method}(${args})`
  }

  // .ramp → .ramp()
  if (method === 'ramp') {
    return `${recStr}.ramp()`
  }

  // .stretch(n) → .stretch(n)
  if (method === 'stretch') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.stretch(${args})`
  }

  // .drop(n) → .drop(n)
  if (method === 'drop') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.drop(${args})`
  }

  // .butlast → .butlast()
  if (method === 'butlast') {
    return `${recStr}.butlast()`
  }

  // .take(n) — Ring has native take()
  if (method === 'take') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.take(${args})`
  }

  // .pick(n) → b.pick(receiver, n)
  if (method === 'pick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `__b.pick(${recStr}${args ? ', ' + args : ''})`
  }

  // .ring → .ring (for arrays becoming rings)
  if (method === 'ring') {
    return `__b.ring(...${recStr})`
  }

  // .to_a → (identity, arrays are already arrays)
  if (method === 'to_a') {
    return `Array.from(${recStr})`
  }

  // .to_sym → identity (already strings in our DSL)
  if (method === 'to_sym' || method === 'to_s') {
    return recStr
  }

  // .to_i → Math.floor
  if (method === 'to_i') {
    return `Math.floor(${recStr})`
  }

  // .to_f → Number()
  if (method === 'to_f') {
    return `Number(${recStr})`
  }

  // .length / .size / .count → .length
  if (method === 'length' || method === 'size' || method === 'count') {
    return `${recStr}.length`
  }

  // .abs → Math.abs
  if (method === 'abs') {
    return `Math.abs(${recStr})`
  }

  // .min / .max
  if (method === 'min') return `Math.min(...${recStr})`
  if (method === 'max') return `Math.max(...${recStr})`

  // .sum — Ruby Array#sum. reduce((a,b)=>a+b, 0) works for numbers; Ring values
  // propagate through the same spread Ruby uses (Array/Ring indexable).
  if (method === 'sum' && !blockNode) {
    return `${recStr}.reduce((a, b) => a + b, 0)`
  }

  // .avg — Sonic Pi Ring extension (arithmetic mean).
  if (method === 'avg' && !blockNode) {
    return `(${recStr}.reduce((a, b) => a + b, 0) / ${recStr}.length)`
  }

  // .values / .keys — Ruby Hash methods. Plain JS objects use Object.values/keys.
  // Rings don't define these, and Object.values(ring) would return the ring's
  // internal indexed values — avoid by only handling the no-args, no-block form.
  if (method === 'values' && !blockNode && !argsNode) {
    return `Object.values(${recStr})`
  }
  if (method === 'keys' && !blockNode && !argsNode) {
    return `Object.keys(${recStr})`
  }

  // .first → [0]
  if (method === 'first') {
    return `${recStr}[0]`
  }

  // .last → .at(-1) or slice(-1)[0]
  if (method === 'last') {
    return `${recStr}.at(-1)`
  }

  // .flat_map
  if (method === 'flat_map') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.flatMap(${args})`
  }

  // .include? → .includes
  if (method === 'include?') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.includes(${args})`
  }

  // .sort → .sort()
  if (method === 'sort') {
    return `${recStr}.sort()`
  }

  // .zip(other, ...) → Ruby semantics: zip arrays element-wise, pad shorter with null
  if (method === 'zip') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.map((__v, __i) => [__v, ${args ? args.split(', ').map(a => `(${a})[__i] ?? null`).join(', ') : ''}])`
  }

  // .sample → b.choose (Ruby's Array#sample is random pick)
  if (method === 'sample' && !argsNode) {
    return `__b.choose(${recStr})`
  }

  // Ruby type predicates: x.kind_of?(Integer) / x.is_a?(Integer).
  // Arg is a class name (constant node), not a value — transpile it as a
  // STRING so the runtime helper can match on type name. JS has no direct
  // equivalent for Ruby's class hierarchy; __spIsA dispatches on the name.
  if (method === 'kind_of?' || method === 'is_a?' || method === 'instance_of?') {
    const arg = argsNode?.namedChildren?.[0]
    const argText = arg ? arg.text : 'Object'
    return `__spIsA(${recStr}, ${JSON.stringify(argText)})`
  }

  // Methods with ? suffix → rename to _q
  if (method.endsWith('?')) {
    const cleanName = method.slice(0, -1) + '_q'
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    // factor? is a DSL function
    if (method === 'factor?') {
      return `__b.factor_q(${args ? recStr + ', ' + args : recStr})`
    }
    return `${recStr}.${cleanName}(${args})`
  }

  // Default: receiver.method(args)
  const args = argsNode ? transpileArgList(argsNode, ctx) : ''
  if (args) return `${recStr}.${method}(${args})`
  // No args and no parens in source — could be property access or method call
  if (fullNode.text.includes('(')) return `${recStr}.${method}()`
  return `${recStr}.${method}()`
}

// ---------------------------------------------------------------------------
// scope_resolution (`Foo::Bar`) — Ruby namespace / constant access.
// ---------------------------------------------------------------------------

// Known-safe Ruby constants that map cleanly to JS. Anything not here
// triggers an error via pushUnsupported() so the user gets a report link
// instead of a cryptic JS parser error.
const SCOPE_RESOLUTION_MAP: Record<string, string> = {
  'Math::PI':        'Math.PI',
  'Math::E':         'Math.E',
  'Float::INFINITY': 'Infinity',
  'Float::NAN':      'NaN',
}

function transpileScopeResolution(node: any, ctx: TranspileContext): string {
  const text = node.text as string
  if (text in SCOPE_RESOLUTION_MAP) return SCOPE_RESOLUTION_MAP[text]
  pushUnsupported(
    ctx, node,
    'scope_resolution',
    `Ruby namespace/constant access \`${text}\` isn't mapped yet`,
  )
  return 'undefined'
}

// ---------------------------------------------------------------------------
// Structured unsupported-feature reporting.
//
// Emits a single line into ctx.errors with enough context for triage:
// node type, line number, source snippet, and a clickable new-issue URL
// pre-populated with feature + location. The sandbox surfaces this verbatim
// in the editor error panel.
// ---------------------------------------------------------------------------

const REPORT_BUG_URL = 'https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/new'

function pushUnsupported(
  ctx: TranspileContext,
  node: any,
  featureId: string,
  humanMessage: string,
): void {
  const line = node.startPosition.row + 1
  const snippet = (node.text as string).replace(/\s+/g, ' ').slice(0, 60)
  const title = `Unsupported Ruby feature: ${featureId}`
  const body = [
    `The transpiler doesn't handle this yet.`,
    ``,
    `**Feature:** \`${featureId}\``,
    `**Code:** \`${snippet}\``,
    `**Line:** ${line}`,
  ].join('\n')
  const reportUrl = `${REPORT_BUG_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  ctx.errors.push(
    `Line ${line}: ${humanMessage}. Report: ${reportUrl}`,
  )
}

// Nodes that are purely structural wrappers in the tree-sitter-ruby grammar
// and carry no semantic content — safe to silently recurse through if an
// explicit handler isn't found. Everything not listed here triggers the
// unsupported-feature path instead of silent passthrough.
const STRUCTURAL_WRAPPERS: Set<string> = new Set([
  'program',
  'expression_statement',
  'parenthesized_statements',
  'body_statement',
  'block_body',
  'then',
  'else',
  'elsif',
  'argument_list',
  'empty_statement',
  // Pattern inside `case/when` — wraps a single value (literal, range, class,
  // etc.) that `case` already compares against. Passes through to the child.
  'pattern',
  // `do` keyword block inside for/until/while constructs that already have
  // explicit handlers — the grammar wraps the body in a `do` node.
  'do',
  // `in` keyword inside `for x in arr` — the `for` handler at case 'for'
  // already pulls the iterator from namedChildren, so `in` here is just
  // the keyword token with no semantic payload.
  'in',
])

// ---------------------------------------------------------------------------
// DSL-specific transpilers
// ---------------------------------------------------------------------------

function transpileLiveLoop(
  node: any, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  // Extract name from args — first symbol argument
  const args = argsNode?.namedChildren ?? []
  let name = 'main'
  let syncName: string | null = null
  const extraOpts: string[] = []

  for (const arg of args) {
    if (arg.type === 'simple_symbol') {
      name = arg.text.slice(1) // strip :
    } else if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.text.replace(/:$/, '')
      if (keyName === 'sync') {
        syncName = val.type === 'simple_symbol' ? val.text.slice(1) : transpileNode(val, ctx)
      } else if (keyName === 'delay') {
        extraOpts.push(`delay: ${transpileNode(val, ctx)}`)
      }
      // auto_cue: false — just skip (engine handles this)
    }
  }

  if (!blockNode) {
    const line = node.startPosition?.row != null ? node.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: live_loop :${name} is missing 'do ... end' block`)
    return `/* parse error: live_loop :${name} missing block */`
  }

  // SP95(d) #393: live_loop body is emitted `async` so `await __b.sync()` can
  // resolve a cue payload mid-build. asyncBody scopes that await to this arrow.
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true, asyncBody: true }
  const bodyStr = transpileBlockBody(blockNode, bodyCtx)

  // sync: option — pass as registration option (one-time sync before first iteration),
  // NOT as b.sync() inside the body (which would re-sync every iteration).
  const optsArg = syncName ? `{sync: "${syncName}"}, ` : ''

  return `live_loop("${name}", ${optsArg}async (__b) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileDefine(
  node: any, argsNode: any, blockNode: any, ctx: TranspileContext, methodName: string = 'define'
): string {
  const args = argsNode?.namedChildren ?? []
  let name = 'unnamed'

  for (const arg of args) {
    if (arg.type === 'simple_symbol') {
      name = arg.text.slice(1)
    }
  }

  ctx.definedFunctions.add(name)

  if (!blockNode) {
    const line = node.startPosition?.row != null ? node.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: ${methodName} :${name} is missing 'do ... end' block`)
    return `/* parse error: ${methodName} :${name} missing block */`
  }

  // Get block parameters (|a, b = default|)
  const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
  const paramStr = params
    ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')
    : ''

  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = transpileBlockBody(blockNode, bodyCtx)

  // For `define`, also call the runtime registrar so the engine persists the
  // function across re-evals (#215). `ndefine` skips this — its semantic is
  // per-eval only.
  const decl = `function ${name}(__b${paramStr ? ', ' + paramStr : ''}) {\n${bodyStr}\n${ctx.indent}}`
  if (methodName === 'define') {
    return `${decl};\n${ctx.indent}define(${JSON.stringify(name)}, ${name})`
  }
  return decl
}

/**
 * `defonce :name, override: true do ... end`  (#212 / #233)
 *
 *   defonce :pad do
 *     chord(:c, :major)
 *   end
 *     →  pad = defonce("pad", {}, (__b) => {
 *          return __b.chord("c", "major")
 *        })
 *
 * Bare assignment so the Sandbox proxy captures the cached value into
 * scope-isolated storage (let/const bypass the proxy). The last block
 * statement is wrapped as `return EXPR` so the caller gets the value
 * Ruby's implicit-last-expr-return convention would have produced.
 *
 * The runtime registrar `defonce(name, opts, fn)` lives in dslValues and
 * caches against `engine.defonceCache`. Re-evaluating the buffer skips
 * the body unless `override: true`, mirroring upstream core.rb:2722-2738.
 */
function transpileDefonce(
  node: any, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const args = argsNode?.namedChildren ?? []
  let name = 'unnamed'
  const optPairs: string[] = []
  for (const arg of args) {
    if (arg.type === 'simple_symbol') {
      name = arg.text.slice(1)
    } else if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      optPairs.push(`${keyName}: ${transpileNode(val, ctx)}`)
    }
  }

  if (!blockNode) {
    const line = node.startPosition?.row != null ? node.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: defonce :${name} is missing 'do ... end' block`)
    return `/* parse error: defonce :${name} missing block */`
  }

  const bodyChildren = blockNode.namedChildren.filter((c: any) => c.type !== 'block_parameters')
  if (bodyChildren.length === 0) {
    return `${name} = defonce(${JSON.stringify(name)}, ${optPairs.length > 0 ? `{ ${optPairs.join(', ')} }` : '{}'}, (__b) => undefined)`
  }

  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const lastIdx = bodyChildren.length - 1
  const stmts = bodyChildren.map((c: any, i: number) => {
    const expr = transpileNode(c, bodyCtx)
    return i === lastIdx
      ? `${ctx.indent}  return ${expr}`
      : `${ctx.indent}  ${expr}`
  })

  const optsStr = optPairs.length > 0 ? `{ ${optPairs.join(', ')} }` : '{}'

  return `${name} = defonce(${JSON.stringify(name)}, ${optsStr}, (__b) => {\n${stmts.join('\n')}\n${ctx.indent}})`
}

/**
 * Drill into a do_block/block's `body_statement` wrapper to get the real
 * statement children (skipping any block_parameters). Mirrors the body
 * extraction in transpileInThread (#205).
 */
function blockBodyChildren(blockNode: any): any[] {
  const raw = (blockNode?.namedChildren ?? []).filter((c: any) => c.type !== 'block_parameters')
  if (raw.length === 1 && raw[0]?.type === 'body_statement') {
    return raw[0].namedChildren ?? []
  }
  return raw
}

/** True if a do/brace block directly contains a `loop do … end` statement (#426/SP111). */
function blockBodyHasBareLoop(blockNode: any): boolean {
  return blockBodyChildren(blockNode).some((c: any) => {
    const m = (c.type === 'call' || c.type === 'method_call')
      ? (c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text)
      : null
    return m === 'loop' && c.namedChildren.some((x: any) => x.type === 'do_block' || x.type === 'block')
  })
}

/**
 * Transpile a with_fx body that contains a bare `loop do`, hoisting each loop
 * to an auto-named live_loop INSIDE the fx callback (#426/SP111, SV16). Setup
 * statements before the loop are emitted as-is; statements after a loop are
 * unreachable (a `loop` runs forever) and dropped with a warning — same policy
 * as transpileInThread.
 */
function transpileWithFxLoopBody(
  blockNode: any, bodyCtx: TranspileContext, ctx: TranspileContext
): string {
  const counter = ctx.fxLoopCounter ?? { n: 0 }
  // `live_loop` is always a FREE function (a global from the sandbox scope),
  // never a ProgramBuilder method — transpileLiveLoop emits it unprefixed at
  // every depth, and BUILDER_METHODS excludes it. So emit it unprefixed here
  // too; `__b.live_loop` would throw "is not a function".
  const parts: string[] = []
  let sawLoop = false
  let droppedAfterLoop = false
  for (const child of blockBodyChildren(blockNode)) {
    const m = (child.type === 'call' || child.type === 'method_call')
      ? (child.childForFieldName('method')?.text ?? child.namedChildren[0]?.text)
      : null
    const isLoop = m === 'loop' &&
      child.namedChildren.some((c: any) => c.type === 'do_block' || c.type === 'block')
    if (isLoop) {
      const body = child.namedChildren.find((c: any) => c.type === 'do_block' || c.type === 'block')
      // live_loop bodies are emitted async (SP95(d) — `await __b.sync()`).
      const innerCtx: TranspileContext = { ...bodyCtx, insideLoop: true, asyncBody: true }
      const innerStr = transpileBlockBody(body, innerCtx)
      const idx = counter.n++
      parts.push(`${ctx.indent}  live_loop("__fxloop_${idx}", async (__b) => {\n${innerStr}\n${ctx.indent}  })`)
      sawLoop = true
    } else if (sawLoop) {
      droppedAfterLoop = true
    } else {
      parts.push(`${ctx.indent}  ${transpileNode(child, bodyCtx)}`)
    }
  }
  if (droppedAfterLoop) {
    const line = blockNode.startPosition?.row != null ? blockNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Warning at line ${line}: statements after \`loop do\` inside with_fx are unreachable and were dropped.`)
  }
  return parts.filter(s => s.trim()).join('\n')
}

function transpileWithBlock(
  methodName: string, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const args = argsNode?.namedChildren ?? []
  const positional: string[] = []
  const opts: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.text.replace(/:$/, '')
      // reps: N → special handling
      if (keyName === 'reps') {
        opts.push(`reps: ${transpileNode(val, ctx)}`)
      } else {
        opts.push(`${keyName}: ${transpileNode(val, ctx)}`)
      }
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: ${methodName} is missing 'do ... end' block`)
    return `/* parse error: ${methodName} missing block */`
  }

  const prefix = ctx.insideLoop ? '__b.' : ''

  // Inside a loop, the block body is inside ProgramBuilder context (insideLoop: true).
  // At top level, with_fx just wraps live_loops — the body stays at top-level context.
  // The engine's topLevelWithFx passes null to the callback, so `b` is not available.
  const bodyCtx: TranspileContext = ctx.insideLoop
    ? { ...ctx, insideLoop: true }
    : { ...ctx }  // keep insideLoop false — live_loops inside will set their own
  // #426/SP111: a bare `loop do … end` directly inside with_fx must be hoisted
  // to an auto-named live_loop, exactly as top-level (lines ~1116) and in_thread
  // (transpileInThread) loops are (SV16). Building it inline emits a synchronous
  // `while(true) { __b.play; __b.sleep }` whose build-time sleep-step resets the
  // budget guard every iteration → infinite Step[] push during the build pass →
  // renderer OOM (issue #426 / crushed.rb). The live_loop stays INSIDE the
  // with_fx callback so the FX bus still wraps it (SV13). Only with_fx is
  // affected because it is the only with-block that reaches `blocks` (registering
  // path); other with-blocks keep current behaviour.
  const bodyStr = (methodName === 'with_fx' && blockBodyHasBareLoop(blockNode))
    ? transpileWithFxLoopBody(blockNode, bodyCtx, ctx)
    : transpileBlockBody(blockNode, bodyCtx)

  const optsStr = opts.length > 0 ? `{ ${opts.join(', ')} }` : ''
  const posStr = positional.join(', ')

  // Check for block parameter: with_fx :reverb do |lv| → (b, lv) => { ... }
  const blockParams = blockNode?.namedChildren.find((c: any) => c.type === 'block_parameters')
  const fxParamName = blockParams?.namedChildren[0]?.text

  let callbackParams: string
  if (ctx.insideLoop) {
    // Inside loop: callback receives ProgramBuilder + optional FX ref
    callbackParams = fxParamName ? `(__b, ${fxParamName})` : '(__b)'
  } else {
    // Top level: engine passes null, we use _ to discard it
    callbackParams = fxParamName ? `(${fxParamName})` : '()'
  }

  const argParts = [posStr, optsStr, `${callbackParams} => {\n` + bodyStr + '\n' + ctx.indent + '}'].filter(Boolean)
  return `${prefix}${methodName}(${argParts.join(', ')})`
}

function transpileInThread(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: in_thread is missing 'do ... end' block`)
    return `/* parse error: in_thread missing block */`
  }

  const prefix = ctx.insideLoop ? '__b.' : ''

  // Resolve `name:` option (used both for the in_thread wrapper and as a base
  // for hoisted-loop names so hot-swap is stable across re-evaluation).
  let nameExpr: string | null = null
  const args = argsNode?.namedChildren ?? []
  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]?.text?.replace(/:$/, '')
      if (key === 'name') {
        nameExpr = transpileNode(arg.namedChildren[1], ctx)
      }
    }
  }

  // SV16 / issue #205: `loop do` inside an in_thread body must be hoisted to
  // a sibling auto-named live_loop. Building it inline emits `while(true) {
  // __b.play; __b.sleep; }` whose sleep resets the budget guard on every
  // iteration → infinite Step[] push at build time → tab OOM. The top-level
  // hoist (lines ~888-901, 936-955) handles this for bare top-level loops;
  // we do the equivalent here for in_thread bodies.
  // The do_block wraps its statements in a body_statement child — drill in.
  const rawChildren = blockNode.namedChildren ?? []
  const bodyChildren = rawChildren.length === 1 && rawChildren[0]?.type === 'body_statement'
    ? (rawChildren[0].namedChildren ?? [])
    : rawChildren
  const setupChildren: any[] = []
  const loopChildren: any[] = []
  let sawLoop = false
  let droppedAfterLoop = false
  for (const child of bodyChildren) {
    const m = (child.type === 'call' || child.type === 'method_call')
      ? (child.childForFieldName('method')?.text ?? child.namedChildren[0]?.text)
      : null
    const isLoop = m === 'loop' &&
      child.namedChildren.some((c: any) => c.type === 'do_block' || c.type === 'block')
    if (isLoop) {
      loopChildren.push(child)
      sawLoop = true
    } else if (sawLoop) {
      // Statements after a `loop do` are unreachable in Sonic Pi — `loop` runs forever.
      droppedAfterLoop = true
    } else {
      setupChildren.push(child)
    }
  }

  if (loopChildren.length === 0) {
    // No nested loop → original codepath.
    const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
    const bodyStr = transpileBlockBody(blockNode, bodyCtx)
    if (nameExpr !== null) {
      return `${prefix}in_thread({ name: ${nameExpr} }, (__b) => {\n${bodyStr}\n${ctx.indent}})`
    }
    return `${prefix}in_thread((__b) => {\n${bodyStr}\n${ctx.indent}})`
  }

  if (droppedAfterLoop) {
    const line = blockNode.startPosition?.row != null ? blockNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Warning at line ${line}: statements after \`loop do\` inside in_thread are unreachable and were dropped.`)
  }

  // Build pieces: setup-only in_thread (if any setup), then sibling live_loops
  // for each hoisted loop. We can only emit sibling top-level live_loop calls
  // when we are at the program root (ctx.insideLoop === false). When the
  // in_thread is itself nested, we cannot top-level-hoist; in that case we
  // fall back to a single live_loop per hoisted loop using __b.live_loop.
  const counter = ctx.inthreadLoopCounter ?? { n: 0 }
  const baseName = nameExpr !== null ? nameExpr : null
  const parts: string[] = []

  if (setupChildren.length > 0) {
    const setupCtx: TranspileContext = { ...ctx, insideLoop: true }
    const setupStr = setupChildren
      .map(c => '  ' + transpileNode(c, setupCtx))
      .filter(s => s.trim())
      .join('\n')
    if (nameExpr !== null) {
      parts.push(`${prefix}in_thread({ name: ${nameExpr} }, (__b) => {\n${setupStr}\n${ctx.indent}})`)
    } else {
      parts.push(`${prefix}in_thread((__b) => {\n${setupStr}\n${ctx.indent}})`)
    }
  }

  for (const loopNode of loopChildren) {
    const body = loopNode.namedChildren.find((c: any) => c.type === 'do_block' || c.type === 'block')
    const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
    const bodyStr = transpileBlockBody(body, bodyCtx)
    const idx = counter.n++
    const autoName = baseName !== null
      ? `(${baseName}) + "__loop_${idx}"`
      : `"__inthread_loop_${idx}"`
    // At program root, emit as bare live_loop so the engine registers it
    // as a top-level scheduler-owned loop. Inside another deferred context,
    // route through __b.live_loop.
    const liveLoopPrefix = ctx.insideLoop ? '__b.' : ''
    parts.push(`${liveLoopPrefix}live_loop(${autoName}, (__b) => {\n${bodyStr}\n${ctx.indent}})`)
  }

  return parts.join('\n')
}

function transpileAt(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: at is missing 'do ... end' block`)
    return `/* parse error: at missing block */`
  }

  const args = argsNode?.namedChildren ?? []
  const positional = args.filter((a: any) => a.type !== 'pair').map((a: any) => transpileNode(a, ctx))

  const timesArr = positional[0] ?? '[]'
  const valuesArr = positional[1] ?? 'null'
  const prefix = ctx.insideLoop ? '__b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }

  // Get block parameters
  const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
  const paramNames = params?.namedChildren.map((c: any) => c.text) ?? []
  const bodyStr = transpileBlockBody(blockNode, bodyCtx)

  const paramStr = paramNames.length > 0 ? ', ' + paramNames.join(', ') : ''
  return `${prefix}at(${timesArr}, ${valuesArr}, (__b${paramStr}) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileTimeWarp(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: time_warp is missing 'do ... end' block`)
    return `/* parse error: time_warp missing block */`
  }

  const offset = argsNode?.namedChildren[0]
    ? transpileNode(argsNode.namedChildren[0], ctx)
    : '0'
  const prefix = ctx.insideLoop ? '__b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = transpileBlockBody(blockNode, bodyCtx)
  return `${prefix}at([${offset}], null, (__b) => {\n${bodyStr}\n${ctx.indent}})`
}

/**
 * `tuplets [list], opts do |x| ... end`  (#233)
 *
 *   tuplets [70, [72, 72]], swing: 0.2 do |n| play n end
 *     →  __b.tuplets([70, [72, 72]], { swing: 0.2 }, (__b, n) => { __b.play(n) })
 *
 * The first positional arg is the list. Remaining keyword pairs become an
 * options object. Block params come through as additional callback args.
 */
function transpileTuplets(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: tuplets is missing 'do ... end' block`)
    return `/* parse error: tuplets missing block */`
  }

  const args = argsNode?.namedChildren ?? []
  const positional = args.filter((a: any) => a.type !== 'pair').map((a: any) => transpileNode(a, ctx))
  const pairs = args.filter((a: any) => a.type === 'pair')

  const listExpr = positional[0] ?? '[]'
  const optsExpr = pairs.length > 0
    ? '{ ' + pairs.map((p: any) => {
        const key = p.namedChildren[0]
        const val = p.namedChildren[1]
        const keyName = key.type === 'hash_key_symbol'
          ? key.text.replace(/:$/, '')
          : key.type === 'simple_symbol'
          ? key.text.slice(1)
          : transpileNode(key, ctx)
        return `${keyName}: ${transpileNode(val, ctx)}`
      }).join(', ') + ' }'
    : '{}'

  const prefix = ctx.insideLoop ? '__b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
  const paramNames = params?.namedChildren.map((c: any) => c.text) ?? []
  const bodyStr = transpileBlockBody(blockNode, bodyCtx)
  const paramStr = paramNames.length > 0 ? ', ' + paramNames.join(', ') : ''

  return `${prefix}tuplets(${listExpr}, ${optsExpr}, (__b${paramStr}) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileDensity(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  if (!blockNode) {
    const line = argsNode?.startPosition?.row != null ? argsNode.startPosition.row + 1 : '?'
    ctx.errors.push(`Parse error at line ${line}: density is missing 'do ... end' block`)
    return `/* parse error: density missing block */`
  }

  const factor = argsNode?.namedChildren[0]
    ? transpileNode(argsNode.namedChildren[0], ctx)
    : '1'
  const bodyStr = transpileBlockBody(blockNode, ctx)
  const bRef = ctx.insideLoop ? '__b' : '__densityB'
  const lines = ['{']
  if (!ctx.insideLoop) lines.push(`  const ${bRef} = { density: 1 }`)
  lines.push(`  const __prevDensity = ${bRef}.density`)
  lines.push(`  ${bRef}.density = __prevDensity * ${factor}`)
  lines.push(bodyStr)
  lines.push(`  ${bRef}.density = __prevDensity`)
  lines.push('}')
  return lines.join('\n' + ctx.indent)
}

function transpileSynthCommand(argsNode: any, ctx: TranspileContext): string {
  // `synth :name` — no args means play the default synth at the default note.
  if (!argsNode) return `__b.play(52, { synth: "beep" })`
  const args = argsNode.namedChildren
  // First arg is the synth name (symbol)
  const synthNameNode = args[0]
  const synthName = synthNameNode ? transpileNode(synthNameNode, ctx) : '"beep"'

  // Separate positional and keyword args from the rest.
  // `note:` kwarg must be promoted to a positional arg — ProgramBuilder.play(noteVal, opts)
  // expects the note first, and an options-hash-as-noteVal coerces to "[object Object]" (see #163).
  const positional: string[] = []
  const kwargs: string[] = [`synth: ${synthName}`]
  let noteExpr: string | null = null

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      if (keyName === 'note') {
        noteExpr = transpileNode(val, ctx)
      } else {
        kwargs.push(`${keyName}: ${transpileNode(val, ctx)}`)
      }
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  const optsStr = `{ ${kwargs.join(', ')} }`
  if (positional.length > 0) {
    // `synth :name, 60, amp: 0.5` — rare but valid form: first positional after name is the note.
    return `__b.play(${positional.join(', ')}, ${optsStr})`
  }
  // `synth :name, note: 60, ...` — normal form with explicit note.
  // `synth :name, amp: 0.5`      — no note; fall back to MIDI 52 (matches Sonic Pi synthinfo default).
  const note = noteExpr ?? '52'
  return `__b.play(${note}, ${optsStr})`
}

// ---------------------------------------------------------------------------
// Control flow transpilers
// ---------------------------------------------------------------------------

function transpileIf(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  const condition = children[0]
  const consequence = children[1]

  let result = `if (${transpileNode(condition, ctx)}) {\n`
  if (consequence) result += transpileNode(consequence, ctx) + '\n'
  result += ctx.indent + '}'

  // Handle elsif/else
  for (let i = 2; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'elsif') {
      const elsifCond = child.namedChildren[0]
      const elsifBody = child.namedChildren[1]
      result += ` else if (${transpileNode(elsifCond, ctx)}) {\n`
      if (elsifBody) result += transpileNode(elsifBody, ctx) + '\n'
      result += ctx.indent + '}'
    } else if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileUnless(node: any, ctx: TranspileContext): string {
  const condition = node.namedChildren[0]
  const body = node.namedChildren[1]
  let result = `if (!(${transpileNode(condition, ctx)})) {\n`
  if (body) result += transpileNode(body, ctx) + '\n'
  result += ctx.indent + '}'

  // Handle else
  for (let i = 2; i < node.namedChildren.length; i++) {
    const child = node.namedChildren[i]
    if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileCase(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  const expr = children[0]
  const exprStr = transpileNode(expr, ctx)
  let result = ''
  let first = true

  for (let i = 1; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'when') {
      const pattern = child.namedChildren[0]
      const body = child.namedChildren[1]
      // when can have multiple patterns separated by commas
      const patterns = child.namedChildren.filter((_: any, idx: number) => {
        // All named children except the last (body) are patterns
        return idx < child.namedChildCount - 1 || child.namedChildCount === 1
      })

      let conditions: string[]
      if (child.namedChildCount === 1) {
        // Single child — it's the pattern (when :r → no body, just skip)
        conditions = [transpileNode(pattern, ctx)]
        const condStr = conditions.map(c => `${exprStr} === ${c}`).join(' || ')
        if (first) {
          result += `if (${condStr}) {\n`
          first = false
        } else {
          result += ` else if (${condStr}) {\n`
        }
        result += ctx.indent + '}'
        continue
      }

      // Multiple children: patterns + body (filter out comment nodes)
      const patternNodes = child.namedChildren.slice(0, -1)
        .filter((p: any) => p.type !== 'comment')
      const bodyNode = child.namedChildren[child.namedChildCount - 1]
      conditions = patternNodes.map((p: any) => transpileNode(p, ctx))
      const condStr = conditions.map(c => `${exprStr} === ${c}`).join(' || ')

      if (first) {
        result += `if (${condStr}) {\n`
        first = false
      } else {
        result += ` else if (${condStr}) {\n`
      }
      if (bodyNode) result += transpileNode(bodyNode, ctx) + '\n'
      result += ctx.indent + '}'
    } else if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileBeginRescue(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  let result = 'try {\n'

  // Body is first child(ren) until rescue/ensure
  for (const child of children) {
    if (child.type === 'rescue') {
      const errorVar = child.namedChildren.find((c: any) =>
        c.type === 'exception_variable')?.namedChildren[0]?.text ?? '_e'
      const rescueBody = child.namedChildren.find((c: any) =>
        c.type === 'then' || c.type === 'body_statement')
      result += ctx.indent + `} catch (${errorVar}) {\n`
      if (rescueBody) result += transpileNode(rescueBody, ctx) + '\n'
    } else if (child.type === 'ensure') {
      const ensureBody = child.namedChildren[0]
      result += ctx.indent + '} finally {\n'
      if (ensureBody) result += transpileNode(ensureBody, ctx) + '\n'
    } else {
      // Body statement
      result += transpileNode(child, ctx) + '\n'
    }
  }

  result += ctx.indent + '}'
  return result
}

// ---------------------------------------------------------------------------
// String handling
// ---------------------------------------------------------------------------

function transpileString(node: any, ctx: TranspileContext): string {
  // Check for interpolation
  const hasInterpolation = node.namedChildren.some((c: any) => c.type === 'interpolation')

  if (hasInterpolation) {
    // Use template literal
    let result = '`'
    for (const child of node.children) {
      if (child.type === '"') continue // skip quote delimiters
      if (child.type === 'interpolation') {
        result += transpileNode(child, ctx)
      } else if (child.type === 'string_content') {
        result += child.text
      } else if (child.type === 'escape_sequence') {
        result += child.text
      }
    }
    result += '`'
    return result
  }

  // Plain string — keep as double-quoted
  return node.text
}

// ---------------------------------------------------------------------------
// Block body helper
// ---------------------------------------------------------------------------

function transpileBlockBody(blockNode: any, ctx: TranspileContext): string {
  // Block children: optional block_parameters, then body statements
  const bodyChildren = blockNode.namedChildren.filter(
    (c: any) => c.type !== 'block_parameters'
  )
  return bodyChildren
    .map((c: any) => ctx.indent + '  ' + transpileNode(c, ctx))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Argument list handling
// ---------------------------------------------------------------------------

function transpileArgList(node: any, ctx: TranspileContext, injectSrcLine = false): string {
  const args = node.namedChildren
  const positional: string[] = []
  const kwargs: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      if (key.type === 'hash_key_symbol') {
        kwargs.push(`${key.text.replace(/:$/, '')}: ${transpileNode(val, ctx)}`)
      } else if (key.type === 'simple_symbol') {
        kwargs.push(`${key.text.slice(1)}: ${transpileNode(val, ctx)}`)
      } else {
        // Computed key: opt => value → [opt]: value
        // (opt.to_s+"_slide").to_sym => dt → [opt + "_slide"]: dt
        kwargs.push(`[${transpileNode(key, ctx)}]: ${transpileNode(val, ctx)}`)
      }
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  // Inject _srcLine for source mapping (play/sample calls)
  if (injectSrcLine && ctx.srcLine !== undefined) {
    kwargs.push(`_srcLine: ${ctx.srcLine}`)
  }

  if (kwargs.length > 0) {
    return [...positional, `{ ${kwargs.join(', ')} }`].join(', ')
  }
  return positional.join(', ')
}

/** Transpile all args as a single options object. */
function transpileArgListAsOpts(node: any, ctx: TranspileContext): string {
  const args = node.namedChildren
  const opts: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      opts.push(`${keyName}: ${transpileNode(val, ctx)}`)
    }
  }

  return `{ ${opts.join(', ')} }`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transpileChildren(node: any, ctx: TranspileContext): string {
  return node.namedChildren
    .map((c: any) => transpileNode(c, ctx))
    .filter((s: string) => s.trim() !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------
// Language detection (moved from RubyTranspiler.ts — #125/#135)
// ---------------------------------------------------------------------------

/**
 * Detect whether code looks like Ruby (Sonic Pi) or JavaScript.
 */
export function detectLanguage(code: string): 'ruby' | 'js' {
  const trimmed = code.trim()

  // Strong Ruby indicators
  if (/\bdo\s*(\|.*\|)?\s*$/.test(trimmed)) return 'ruby'
  if (/\bend\s*$/.test(trimmed)) return 'ruby'
  if (/:\w+/.test(trimmed) && !/['"`]/.test(trimmed.split(':')[0])) return 'ruby'
  if (/\blive_loop\s+:/.test(trimmed)) return 'ruby'
  if (/\bsample\s+:/.test(trimmed)) return 'ruby'
  if (/\buse_synth\s+:/.test(trimmed)) return 'ruby'

  // Strong JS indicators
  if (/\basync\b/.test(trimmed)) return 'js'
  if (/\bawait\b/.test(trimmed)) return 'js'
  if (/\bb\./.test(trimmed)) return 'js'
  if (/=>/.test(trimmed)) return 'js'
  if (/\bconst\b|\blet\b|\bvar\b/.test(trimmed)) return 'js'

  // Default to Ruby (Sonic Pi is the primary use case)
  return 'ruby'
}

// ---------------------------------------------------------------------------
// Public API — autoTranspile entry points (moved from RubyTranspiler.ts — #125/#135)
// ---------------------------------------------------------------------------

/** Result of autoTranspile — includes error metadata for callers (#138). */
export interface TranspileResult {
  code: string
  hasError: boolean
  errorMessage?: string
  method?: 'tree-sitter'
}

/**
 * Auto-detect language and transpile if needed.
 * Returns the transpiled JS code string (backward compatible).
 */
export function autoTranspile(code: string): string {
  return autoTranspileDetailed(code).code
}

/**
 * Auto-detect language and transpile with detailed result.
 * TreeSitter is the sole transpiler — WASM must be initialized before
 * calling this (browser: SonicPiEngine.init(), tests: setupFiles).
 *
 * No `wrapBareCode` preprocessor — tree-sitter's `transpileProgram`
 * handles bare code detection and wrapping directly from the AST (#125).
 */
export function autoTranspileDetailed(code: string): TranspileResult {
  const lang = detectLanguage(code)
  if (lang === 'js') return { code, hasError: false }

  if (!isTreeSitterReady()) {
    throw new Error('[SonicPi] TreeSitter parser not available — the audio engine may still be loading. Try clicking Run again.')
  }

  const tsResult = treeSitterTranspile(code)
  if (tsResult.errors.length > 0) {
    return { code: code, hasError: true, errorMessage: tsResult.errors.join('; '), method: 'tree-sitter' }
  }

  try {
    new Function(tsResult.code)
  } catch (e) {
    return { code: tsResult.code, hasError: true, errorMessage: `TreeSitter produced invalid JS: ${e}`, method: 'tree-sitter' }
  }

  return { code: tsResult.code, hasError: false, method: 'tree-sitter' }
}
