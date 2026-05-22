/**
 * Friendly error messages matching Sonic Pi's beginner-friendly style.
 *
 * Wraps runtime errors with helpful context: what went wrong, why,
 * and what to try instead.
 */

import { getSynthParams, getFxParams } from './SynthParams'
import { SANDBOX_WRAPPER_LINES } from './Sandbox'

export interface FriendlyError {
  title: string
  message: string
  line?: number
  original: Error
}

export const KNOWN_SYNTHS = [
  'beep', 'saw', 'prophet', 'tb303', 'supersaw', 'pluck',
  'pretty_bell', 'piano', 'dsaw', 'dpulse', 'dtri', 'fm',
  'mod_fm', 'mod_saw', 'mod_pulse', 'mod_tri', 'sine',
  'square', 'tri', 'pulse', 'noise', 'pnoise', 'bnoise',
  'gnoise', 'cnoise', 'chipbass', 'chiplead', 'chipnoise',
  'dark_ambience', 'hollow', 'growl', 'zawa', 'blade',
  'tech_saws', 'sound_in', 'sound_in_stereo',
]

export const KNOWN_SAMPLES = [
  'bd_haus', 'bd_zum', 'bd_808', 'bd_boom', 'bd_klub', 'bd_pure', 'bd_tek',
  'sn_dub', 'sn_dolf', 'sn_zome', 'sn_generic',
  'hat_snap', 'hat_cab', 'hat_raw',
  'loop_amen', 'loop_breakbeat', 'loop_compus', 'loop_garzul', 'loop_industrial',
  'ambi_choir', 'ambi_dark_woosh', 'ambi_drone', 'ambi_glass_hum', 'ambi_lunar_land',
  'bass_dnb_f', 'bass_hit_c', 'bass_thick_c', 'bass_voxy_c',
  'elec_beep', 'elec_bell', 'elec_blip', 'elec_chime', 'elec_ping',
  'perc_bell', 'perc_snap', 'perc_swoosh',
]

// `delay` and `chorus` omitted — not shipped in the SuperSonic CDN package
// (verified 404 across v0.57.0–v0.66.0). See FxNames.ts ALL_FX_NAMES for the
// canonical list and rationale. Suggesting these names to a user with a typo
// would lead them to a "FX not found" failure at /s_new dispatch (issue #301).
export const KNOWN_FX = [
  'reverb', 'echo', 'distortion', 'slicer',
  'wobble', 'ixi_techno', 'compressor', 'rlpf', 'rhpf',
  'hpf', 'lpf', 'normaliser', 'pan', 'band_eq',
  'flanger', 'krush', 'bitcrusher', 'ring_mod',
  'octaver', 'vowel', 'tanh', 'gverb', 'pitch_shift',
  'whammy', 'tremolo', 'record', 'sound_out', 'sound_out_stereo',
  'level', 'mono', 'autotuner',
]

/** Try to extract a line number from an error stack trace or message. */
function extractLineFromStack(err: Error, lineOffset: number): number | undefined {
  const msg = err.message ?? ''
  const stack = err.stack ?? ''

  // 1. SyntaxError from new Function() — browsers embed line info in the message
  //    Chrome: "Unexpected token '#' (line 42)"  or in stack "<anonymous>:42:5"
  //    Firefox: "SyntaxError: ... line 42"
  //    Safari: "SyntaxError: ... at line 42"
  const syntaxMatch = msg.match(/line\s+(\d+)/i) ??
                      stack.match(/Function.*?:(\d+):\d+/) ??
                      stack.match(/<anonymous>:(\d+):\d+/) ??
                      stack.match(/eval.*?:(\d+):\d+/)

  if (syntaxMatch) {
    const raw = parseInt(syntaxMatch[1], 10)
    // Use dynamically-computed wrapper line count from Sandbox
    const wrapperLines = lineOffset > 0 ? lineOffset : SANDBOX_WRAPPER_LINES
    const adjusted = raw - wrapperLines
    return adjusted > 0 ? adjusted : raw > 0 ? 1 : undefined
  }

  // 2. Runtime errors — look for the eval frame in the stack
  const runtimeMatch = stack.match(/<anonymous>:(\d+):\d+/) ??
                       stack.match(/eval.*?:(\d+):\d+/)
  if (runtimeMatch) {
    const raw = parseInt(runtimeMatch[1], 10)
    const wrapperLines = lineOffset > 0 ? lineOffset : SANDBOX_WRAPPER_LINES
    const adjusted = raw - wrapperLines
    return adjusted > 0 ? adjusted : 1
  }

  return undefined
}

/** Find the closest match from a list using edit distance. */
function closestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestDist = Infinity

  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }

  // Only suggest if reasonably close (within 3 edits)
  return bestDist <= 3 ? best : null
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** Pattern matchers for common runtime errors. */
const ERROR_PATTERNS: Array<{
  test: (msg: string) => boolean
  transform: (msg: string, err: Error) => { title: string; message: string; line?: number }
}> = [
  // Unknown synth
  {
    test: (msg) => /unknown synth|synthdef.*not found|loadSynthDef/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sonic-pi-(\w+)/i) ??
                         msg.match(/synth[:\s]+["']?(\w+)["']?/i)
      const name = nameMatch?.[1]?.replace('sonic-pi-', '') ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_SYNTHS)
      return {
        title: `Synth :${name} not found`,
        message: `I don't know a synth called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nAvailable synths include: ${KNOWN_SYNTHS.slice(0, 8).map(s => ':' + s).join(', ')}...` +
          `\n\nTry: use_synth("${suggestion ?? 'beep'}")`,
      }
    },
  },
  // Unknown sample
  {
    test: (msg) => /sample.*not found|loadSample.*failed|sample.*flac/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sample[:\s]*["']?(\w+)["']?/i) ??
                         msg.match(/(\w+)\.flac/i)
      const name = nameMatch?.[1] ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_SAMPLES)
      return {
        title: `Sample :${name} not found`,
        message: `I couldn't find a sample called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nSome built-in samples: ${KNOWN_SAMPLES.slice(0, 6).map(s => ':' + s).join(', ')}...`,
      }
    },
  },
  // Unknown FX
  {
    test: (msg) => /unknown fx|fx.*not found|loadSynthDef.*fx/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sonic-pi-fx_(\w+)/i) ??
                         msg.match(/fx[:\s]+["']?(\w+)["']?/i)
      const name = nameMatch?.[1]?.replace('sonic-pi-fx_', '') ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_FX)
      return {
        title: `FX :${name} not found`,
        message: `I don't know an FX called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nAvailable FX include: ${KNOWN_FX.slice(0, 8).map(f => ':' + f).join(', ')}...`,
      }
    },
  },
  // Unknown parameter for synth or FX
  {
    test: (msg) => /unknown param|invalid.*param|unrecognised.*param|unrecognized.*param/i.test(msg),
    transform: (msg) => {
      // Try to extract synth/FX name and the bad param from the message
      const synthMatch = msg.match(/synth[:\s]+["']?(\w+)["']?/i)
      const fxMatch = msg.match(/fx[:\s]+["']?(\w+)["']?/i)
      const paramMatch = msg.match(/param(?:eter)?[:\s]+["']?(\w+)["']?/i)

      const badParam = paramMatch?.[1] ?? 'unknown'
      const isFx = !!fxMatch
      const name = fxMatch?.[1] ?? synthMatch?.[1] ?? 'unknown'

      const validParams = isFx ? getFxParams(name) : getSynthParams(name)
      const suggestion = validParams.length > 0 ? closestMatch(badParam, validParams) : null

      const kind = isFx ? 'FX' : 'synth'
      return {
        title: `Unknown parameter :${badParam} for ${kind} :${name}`,
        message: `The ${kind} :${name} doesn't have a parameter called :${badParam}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nValid parameters for :${name} include:\n  ` +
          validParams.slice(0, 12).map(p => ':' + p).join(', ') +
          (validParams.length > 12 ? '...' : ''),
      }
    },
  },
  // Note out of range or invalid
  {
    test: (msg) => /invalid note|note.*range|unknown note|cannot convert.*note/i.test(msg),
    transform: (msg) => ({
      title: 'Invalid note',
      message: `That doesn't look like a valid note.\n\n` +
        `Notes can be:\n` +
        `  - MIDI numbers: play(60)  (middle C)\n` +
        `  - Note names:   play("c4"), play("fs3"), play("eb5")\n` +
        `  - Symbols:      play("c4")  (use strings in JS, not Ruby symbols)`,
    }),
  },
  // sleep with bad value
  {
    test: (msg) => /sleep.*NaN|sleep.*undefined|sleep.*negative/i.test(msg),
    transform: (msg) => ({
      title: 'Invalid sleep value',
      message: `sleep() needs a positive number of beats.\n\n` +
        `Examples:\n` +
        `  sleep(1)     → wait 1 beat\n` +
        `  sleep(0.5)   → wait half a beat\n` +
        `  sleep(0.25)  → wait a quarter beat`,
    }),
  },
  // Not initialized
  {
    test: (msg) => /not initialized|call init/i.test(msg),
    transform: () => ({
      title: 'Engine not ready',
      message: `The sound engine hasn't started yet.\n\n` +
        `Make sure to call init() before evaluating code:\n` +
        `  const engine = new SonicPiEngine()\n` +
        `  await engine.init()\n` +
        `  await engine.evaluate(code)`,
    }),
  },
  // Unknown task
  {
    test: (msg) => /unknown task/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/task[:\s]*["']?(\w+)["']?/i)
      const name = nameMatch?.[1] ?? 'unknown'
      return {
        title: `Unknown loop: ${name}`,
        message: `There's no live_loop called "${name}" running.\n\n` +
          `Make sure your code defines the loop:\n` +
          `  live_loop("${name}", async ({play, sleep}) => {\n` +
          `    await play(60)\n` +
          `    await sleep(1)\n` +
          `  })`,
      }
    },
  },
  // Transpile failure — code couldn't be converted to JS
  {
    test: (msg) => /transpile|tree-?sitter|invalid js output/i.test(msg),
    transform: (msg) => {
      const detail = msg.replace(/.*?:\s*/, '')
      return {
        title: 'Code couldn\'t be understood',
        message: `Your code has a syntax issue the transpiler couldn't handle.\n\n` +
          `Detail: ${detail}\n\n` +
          `Common causes:\n` +
          `  - Unclosed do/end block (every "do" needs a matching "end")\n` +
          `  - Missing comma between arguments\n` +
          `  - Unsupported Ruby syntax (not all Ruby features are available)\n\n` +
          `Tip: Try commenting out sections to find which part causes the issue.`,
      }
    },
  },
  // Infinite loop detected
  {
    test: (msg) => /infinite loop|did you forget.*sleep/i.test(msg),
    transform: () => ({
      title: 'Infinite loop detected',
      message: `Your code is running in a tight loop without sleeping.\n\n` +
        `Every live_loop and loop needs a sleep:\n\n` +
        `  live_loop :drums do\n` +
        `    sample :bd_haus\n` +
        `    sleep 0.5          # ← don't forget this!\n` +
        `  end\n\n` +
        `Without sleep, the loop runs thousands of times per second and freezes the browser.`,
    }),
  },
  // Nil/undefined access (very common with get/set)
  {
    test: (msg) => /cannot read prop.*of undefined|cannot read prop.*of null|undefined is not an object/i.test(msg),
    transform: (msg) => {
      const propMatch = msg.match(/property '(\w+)'/i) ?? msg.match(/property "(\w+)"/i)
      const prop = propMatch?.[1] ?? 'unknown'
      return {
        title: 'Trying to use something that doesn\'t exist yet',
        message: `You tried to access .${prop} on something that is nil/undefined.\n\n` +
          `Common causes:\n` +
          `  - Using get[:name] before set :name was called\n` +
          `  - Variable not yet assigned in this iteration\n` +
          `  - case/when didn't match any branch (variables inside when are undefined outside)\n\n` +
          `Tip: Make sure set() runs before get[], or provide a default:\n` +
          `  val = get[:myval] || 0`,
      }
    },
  },
  // Wrong number of arguments
  {
    test: (msg) => /expected \d+ arguments|takes \d+ arguments|too (many|few) arguments/i.test(msg),
    transform: (msg) => ({
      title: 'Wrong number of arguments',
      message: `${msg}\n\n` +
        `Check the function signature. In Sonic Pi:\n` +
        `  play 60                    → one note\n` +
        `  play 60, amp: 0.5          → note + options\n` +
        `  sample :bd_haus, rate: 2   → sample + options\n\n` +
        `Options use key: value syntax (colon after the name).`,
    }),
  },
  // Stack overflow (deeply nested calls)
  {
    test: (msg) => /maximum call stack|stack overflow/i.test(msg),
    transform: () => ({
      title: 'Code nested too deeply',
      message: `Your code has too many nested calls — it ran out of stack space.\n\n` +
        `Common causes:\n` +
        `  - A define function calling itself without stopping (infinite recursion)\n` +
        `  - Very deeply nested with_fx blocks (try reducing nesting)\n\n` +
        `Tip: Make sure recursive functions have a base case that stops the recursion.`,
    }),
  },
  // Redeclaration error (const/let)
  {
    test: (msg) => /redeclaration|has already been declared|identifier.*already/i.test(msg),
    transform: (msg) => {
      const varMatch = msg.match(/(?:of\s+|identifier\s+)'?(\w+)'?/i)
      const name = varMatch?.[1] ?? 'variable'
      return {
        title: `"${name}" declared twice`,
        message: `The variable "${name}" is being declared more than once.\n\n` +
          `In Sonic Pi, you can reassign variables freely:\n` +
          `  x = 1\n` +
          `  x = 2    # ← this is fine\n\n` +
          `If you're seeing this error, it may be a transpiler issue.\n` +
          `Try renaming the variable or restarting.`,
      }
    },
  },
  // Invalid note / NaN play
  {
    test: (msg) => /NaN.*play|play.*NaN|invalid.*midi/i.test(msg),
    transform: () => ({
      title: 'Note couldn\'t be played',
      message: `The note value resolved to something that isn't a valid pitch.\n\n` +
        `Valid notes:\n` +
        `  play 60          → MIDI note 60 (middle C)\n` +
        `  play :c4          → C in octave 4\n` +
        `  play :eb3         → E-flat in octave 3\n` +
        `  play :fs5         → F-sharp in octave 5\n\n` +
        `Note: Sharps use "s" (not #), flats use "b".`,
    }),
  },
  // B9 (#390): `raise`/`fail` are real Ruby keywords we don't support in the
  // browser sandbox. They transpile to a bare call, so the generic handler below
  // would frame them as a typo ("raise is not a function"). Name them as
  // unsupported keywords instead. Must precede the generic "is not a function".
  {
    test: (msg) => /\b(raise|fail) is not a function/i.test(msg),
    transform: (msg) => {
      const kw = /\bfail is not a function/i.test(msg) ? 'fail' : 'raise'
      return {
        title: `${kw} isn't supported yet`,
        message: `"${kw}" is a Ruby keyword that isn't available in the browser sandbox yet.\n\n` +
          `If you want to stop your code, use \`stop\` instead.\n` +
          `To leave a note for yourself, use a comment (\`# like this\`).`,
      }
    },
  },
  // Type errors (common JS mistakes)
  {
    test: (msg) => /is not a function/i.test(msg),
    transform: (msg) => {
      const fnMatch = msg.match(/(\w+) is not a function/i)
      const fn = fnMatch?.[1] ?? 'unknown'
      return {
        title: `${fn} is not a function`,
        message: `Hmm, "${fn}" isn't available as a function here.\n\n` +
          `Common causes:\n` +
          `  - Typo in function name\n` +
          `  - Using a Ruby method that hasn't been implemented yet\n` +
          `  - Calling a DSL function outside a live_loop`,
      }
    },
  },
  // ReferenceError (undefined variable)
  {
    test: (msg) => /is not defined/i.test(msg),
    transform: (msg) => {
      const varMatch = msg.match(/(\w+) is not defined/i)
      const name = varMatch?.[1] ?? 'unknown'
      return {
        title: `${name} is not defined`,
        message: `I don't know what "${name}" means.\n\n` +
          `If this is a Sonic Pi symbol like :${name}, use a string instead: "${name}"\n` +
          `If this is a variable, make sure to define it with let or const first.`,
      }
    },
  },
  // Parse errors from TreeSitter transpiler (contain "Parse error at line N")
  {
    test: (msg) => /parse error at line/i.test(msg),
    transform: (msg) => {
      // Extract all "Parse error at line N: ..." entries
      const errors = msg.split(';').map(s => s.trim()).filter(Boolean)
      const formatted = errors.map(e => `  ${e}`).join('\n')
      // Extract line number from first error (already source-level, no offset needed)
      const lineMatch = msg.match(/parse error at line (\d+)/i)
      const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined
      return {
        title: 'Syntax error — your code could not be parsed',
        message: `${formatted}\n\nCheck for:\n` +
          `  - Missing "do" after live_loop :name\n` +
          `  - Unclosed do/end blocks\n` +
          `  - Mismatched quotes or parentheses`,
        line,
      }
    },
  },
  // Syntax errors (JS-level, from new Function())
  {
    test: (msg) => /syntaxerror|unexpected token|unexpected end/i.test(msg),
    transform: (msg) => ({
      title: 'Syntax error',
      message: `There's a syntax problem in your code.\n\n` +
        `Common causes:\n` +
        `  - Missing closing bracket ) or }\n` +
        `  - Using Ruby do/end instead of JS { }\n` +
        `  - Missing comma between arguments\n\n` +
        `Tip: If you're writing Sonic Pi syntax, the transpiler handles most Ruby → JS conversion automatically.`,
    }),
  },
]

/**
 * Transform a raw runtime error into a friendly, Sonic Pi-style error.
 */
export function friendlyError(err: Error, lineOffset = 0): FriendlyError {
  const msg = err.message

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      const result = pattern.transform(msg, err)
      return {
        title: result.title,
        message: result.message,
        line: result.line ?? extractLineFromStack(err, lineOffset),
        original: err,
      }
    }
  }

  // Fallback: unknown error, still wrap it nicely
  return {
    title: 'Something went wrong',
    message: `${msg}\n\nIf this keeps happening, try simplifying your code and adding things back one at a time.`,
    line: extractLineFromStack(err, lineOffset),
    original: err,
  }
}

/**
 * Format a FriendlyError for display (log pane or console).
 */
export function formatFriendlyError(fe: FriendlyError): string {
  const lineInfo = fe.line ? ` (line ${fe.line})` : ''
  return `── ${fe.title}${lineInfo} ──\n\n${fe.message}`
}
