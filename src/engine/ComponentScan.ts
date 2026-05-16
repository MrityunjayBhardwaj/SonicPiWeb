/**
 * Static component scan — extract the LITERAL sample / FX / synth names a
 * piece of user code references, without building or running it. The
 * pre-Run path of the preflight EPIC (#318, child #318.3 / #323).
 *
 * Why static (not the #321 Step-walker): loop Programs are built lazily
 * per-iteration inside the scheduler (`SonicPiEngine.ts:694`); there is no
 * pre-Run moment where Step[]s exist, and re-running builderFn to get them
 * is an SP72 build-phase-state-mutation hazard. A textual scan of the user
 * code is the only side-effect-free pre-Run option. The result feeds the
 * unchanged `ComponentResolver` (#322) — same `ComponentManifest` shape.
 *
 * BOUNDED BY DESIGN: only LITERAL names are found —
 *   `sample :x` / `sample "x"` / `sample('x')`
 *   `use_synth :x` · `synth :x` · `with_fx :x`  (and quoted/paren forms)
 * Runtime-computed names (`sample SAMPS.tick`, a name from a variable) are
 * deliberately NOT found: they cannot be known pre-Run, so they are not
 * preflighted and not blocked — they fall back to normal lazy-load (which,
 * post-#320/#317, self-heals on transient failure). This is the precise,
 * intended limit, not a gap to paper over. Literal names are exactly the
 * set that bites users (typos, SP89 never-shipped names are always literal).
 *
 * Over-collection is harmless (a real, loadable name just resolves).
 * Under-collection of a literal, or collecting a name from a COMMENT,
 * is not: a commented-out `sample :typo` must never block Run — so
 * comments are stripped before scanning.
 */

import type { ComponentManifest } from './ComponentManifest'

/**
 * Strip Ruby comments so a commented-out `sample :typo` cannot false-block
 * Run. Handles line comments (`#` … EOL) and `=begin`/`=end` block
 * comments. Known v1 limit: a `#` inside a string literal on a line with
 * no real comment will truncate that line early — acceptable because the
 * DSL forms we scan (`sample :x` etc.) do not use `#` in their literal
 * name, and the failure mode is under-collection of that one line, which
 * degrades to lazy-load (no false-block, no regression). `#{}`
 * interpolation is preserved (only `#` NOT followed by `{` starts a
 * comment here).
 */
function stripComments(code: string): string {
  const withoutBlocks = code.replace(/^=begin\b[\s\S]*?^=end\b.*$/gm, '')
  return withoutBlocks
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '#' && line[i + 1] !== '{') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

// `\bsample\s*\(?\s*[:"']([name])` — `\b` before `synth` does NOT match the
// `synth` inside `use_synth` (`_` is a word char → no boundary), so the two
// patterns are unambiguous. Name = Ruby ident: letter/underscore start.
const NAME = '([a-zA-Z_][a-zA-Z0-9_]*)'
const PATTERNS: ReadonlyArray<[keyof ComponentManifest, RegExp]> = [
  ['samples', new RegExp(`\\bsample\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['synths', new RegExp(`\\buse_synth\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['synths', new RegExp(`\\bsynth\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['fx', new RegExp(`\\bwith_fx\\s*\\(?\\s*[:"']${NAME}`, 'g')],
]

/**
 * Scan user code for literal component references. Pure: input string →
 * name Sets. Feeds `resolveComponentManifest` (#322) unchanged.
 */
export function scanComponentNames(code: string): ComponentManifest {
  const manifest: ComponentManifest = {
    samples: new Set(),
    fx: new Set(),
    synths: new Set(),
  }
  const src = stripComments(code)
  for (const [bucket, re] of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) manifest[bucket].add(m[1])
  }
  return manifest
}
