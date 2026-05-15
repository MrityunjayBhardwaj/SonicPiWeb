/**
 * CodeMirror 6 editor — loaded from CDN, Sonic Pi-style dark theme.
 * Falls back to styled textarea if CDN unavailable.
 */

import { HELP_DB } from './helpData'
import { KNOWN_SYNTHS, KNOWN_SAMPLES, KNOWN_FX } from '../engine/FriendlyErrors'
import { SYNTH_PARAMS, FX_PARAMS } from '../engine/SynthParams'
import { theme } from './theme'

// Minimal types for the CodeMirror API surface we use
interface EditorState {
  doc: { toString(): string; length: number }
  selection?: { main: { from: number; to: number } }
  wordAt?(pos: number): { from: number; to: number; text: string } | null
}

interface EditorView {
  state: EditorState
  dispatch(tr: unknown): void
  destroy(): void
  dom: HTMLElement
}

interface CMModule {
  EditorView: {
    new (config: Record<string, unknown>): EditorView
    theme(spec: Record<string, unknown>): unknown
    updateListener: { of(fn: (update: unknown) => void): unknown }
  }
  EditorState: {
    create(config: Record<string, unknown>): EditorState
  }
  basicSetup: unknown
  keymap: { of(bindings: unknown[]): unknown }
  rubyLang: unknown | null
  highlightStyle: unknown | null
  autocompletion: ((config: Record<string, unknown>) => unknown) | null
}

// Sonic Pi stream parser for CodeMirror — inline, no CDN dependency
const SP_KEYWORDS = new Set([
  'live_loop', 'do', 'end', 'with_fx', 'in_thread', 'define',
  'if', 'elsif', 'else', 'unless', 'loop', 'while', 'until',
  'begin', 'rescue', 'ensure', 'for', 'case', 'when', 'then',
  'and', 'or', 'not', 'true', 'false', 'nil', 'return',
])
const SP_BUILTINS = new Set([
  'play', 'sleep', 'sample', 'use_synth', 'use_bpm', 'use_random_seed',
  'sync', 'cue', 'control', 'stop', 'density', 'puts', 'print',
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in',
  'ring', 'knit', 'range', 'line', 'spread', 'chord', 'scale',
  'chord_invert', 'note', 'note_range', 'tick', 'look',
  // Tier B PR #2 — ring helpers, defaults introspection, tuplets, defonce
  'doubles', 'halves', 'tuplets', 'defonce',
  'current_synth_defaults', 'current_sample_defaults',
  'current_arg_checks', 'current_debug',
  // Tier B PR #3 — sync_bpm, dynamic eval, load_example, live_audio
  'sync_bpm', 'run_code', 'eval_file', 'run_file', 'load_example', 'live_audio',
  // Tier C PR #1 — state wrappers
  'use_arg_checks', 'use_timing_guarantees',
  'use_merged_synth_defaults', 'use_merged_sample_defaults',
  'with_arg_checks', 'with_debug', 'with_timing_guarantees',
  'with_merged_synth_defaults', 'with_merged_sample_defaults',
  'current_timing_guarantees',
  // Tier C PR #2 — sample/buffer registry
  'sample_paths', 'sample_buffer', 'sample_free', 'sample_free_all',
  'load_samples', 'buffer',
  // Tier C PR #3 — mixer + introspection (set_mixer_control! / reset_mixer!
  // enter as bare names; transpiler strips trailing ! at parse time)
  'set_mixer_control', 'reset_mixer', 'scsynth_info', 'status', 'vt', 'bt', 'rt',
])
// Block-opening keywords that increase indent on the next line
const SP_BLOCK_OPENERS = new Set(['do', 'then', 'begin', 'else', 'elsif', 'rescue', 'ensure'])

interface SonicPiParserState {
  indentLevel: number
}

const sonicPiStreamParser = {
  startState(): SonicPiParserState {
    return { indentLevel: 0 }
  },
  copyState(s: SonicPiParserState): SonicPiParserState {
    return { indentLevel: s.indentLevel }
  },
  token(stream: { match(re: RegExp): string[] | null; next(): string; eol(): boolean; skipToEnd(): void; peek(): string; sol(): boolean }, state: SonicPiParserState) {
    // Comment
    if (stream.match(/^#.*/)) return 'comment'
    // String (double-quoted with interpolation, single-quoted)
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return 'string'
    // Symbol :name — notes like :c4, :eb3 get special treatment
    if (stream.match(/^:[a-g][sb#]?\d+/)) return 'atom' // note symbols — same as other symbols
    if (stream.match(/^:\w+/)) return 'atom'
    // Hash key (word followed by colon) — amp:, release:, cutoff:
    if (stream.match(/^\w+(?=:\s)/)) return 'propertyName'
    // Number
    if (stream.match(/^-?\d+\.?\d*/)) return 'number'
    // Word
    const wordMatch = stream.match(/^\w+[!?]?/)
    if (wordMatch) {
      const w = wordMatch[0]
      if (SP_KEYWORDS.has(w)) {
        // Track indent: block openers at end of line increase indent
        if (SP_BLOCK_OPENERS.has(w) && stream.eol()) {
          state.indentLevel++
        }
        // 'end' at start of meaningful content decreases indent
        if (w === 'end') {
          state.indentLevel = Math.max(0, state.indentLevel - 1)
        }
        return 'keyword'
      }
      if (SP_BUILTINS.has(w)) return 'builtin'
      return 'variable'
    }
    // Pipe delimiters |x| in block params
    if (stream.match(/^\|/)) return 'bracket'
    // Operator
    if (stream.match(/^[+\-*/%=<>!&|^~]+/)) return 'operator'
    // Brackets and punctuation
    if (stream.match(/^[()[\]{},;.]/)) return 'punctuation'
    // Skip unknown
    stream.next()
    return null
  },
  indent(state: SonicPiParserState, textAfter: string) {
    let level = state.indentLevel
    // If the line being indented starts with 'end', dedent one level
    if (/^\s*end\b/.test(textAfter)) {
      level = Math.max(0, level - 1)
    }
    return level * 2  // 2-space indent (Sonic Pi convention)
  },
}

// ---------------------------------------------------------------------------
// Static completion list — built once at module load from existing catalogues
// ---------------------------------------------------------------------------
interface CompletionItem {
  label: string
  type: string
  info?: string
}

function buildCompletions(): CompletionItem[] {
  const items: CompletionItem[] = []

  // DSL functions (from help DB + builtins)
  const dslFunctions: Record<string, string> = {
    play: 'Play a note with the current synth',
    sleep: 'Wait for beats before continuing',
    sample: 'Play a built-in or custom sample',
    live_loop: 'Named loop that repeats and supports live editing',
    with_fx: 'Wrap code in an audio effect',
    use_synth: 'Set the synth for subsequent play calls',
    use_bpm: 'Set the tempo in BPM',
    in_thread: 'Run code in a concurrent thread',
    sync: 'Block until a matching cue is received',
    cue: 'Send a named cue to unblock sync',
    control: 'Modify parameters of a running synth',
    define: 'Define a reusable named function',
    at: 'Schedule code at specific beat offsets',
    density: 'Speed up time within a block',
    time_warp: 'Shift virtual time forward or backward',
    puts: 'Print a message to the log',
    print: 'Print a message to the log',
    ring: 'Create a wrapping ring buffer',
    knit: 'Create a ring by repeating values',
    spread: 'Euclidean rhythm distribution',
    chord: 'Return MIDI notes for a chord',
    scale: 'Return MIDI notes for a scale',
    choose: 'Pick a random element from a list',
    rrand: 'Random float between min and max',
    rrand_i: 'Random integer between min and max',
    rand: 'Random float between 0 and max',
    rand_i: 'Random integer between 0 and max',
    dice: 'Roll a dice with N sides',
    one_in: 'True with probability 1/n',
    note: 'Convert a note name to MIDI number',
    note_range: 'Range of MIDI notes',
    tick: 'Advance thread-local counter',
    look: 'Read thread-local counter without advancing',
    set: 'Store value in global time-state',
    get: 'Retrieve value from global time-state',
    stop: 'Stop the current thread',
    use_random_seed: 'Set the random seed for reproducibility',
    play_pattern_timed: 'Play notes with timed sleeps',
    play_chord: 'Play multiple notes simultaneously',
    chord_invert: 'Invert a chord by N positions',
    range: 'Create a numeric range',
    line: 'Create a linear ramp between values',
    loop: 'Infinite loop (use sleep inside!)',
    // Tier B PR #2
    doubles: 'Ring of N doublings starting at value',
    halves: 'Ring of N halvings starting at value',
    tuplets: 'Schedule N notes evenly across N beats',
    defonce: 'Cache a block result by name (survives hot-swap)',
    current_synth_defaults: 'Get current synth defaults map',
    current_sample_defaults: 'Get current sample defaults map',
    current_arg_checks: 'Get current arg-check setting',
    current_debug: 'Get current debug setting',
    // Tier B PR #3
    sync_bpm: 'Sync to a cue and adopt its BPM',
    run_code: 'Dynamically evaluate a Sonic Pi code string',
    eval_file: 'File-based eval (browser: use run_code instead)',
    run_file: 'File-based run (browser: use load_example instead)',
    load_example: 'Load a bundled example into the editor',
    live_audio: 'Named live audio stream from soundcard',
    // Tier C PR #1 — state wrappers
    use_arg_checks: 'Enable or disable arg-name checking',
    with_arg_checks: 'Block-scoped enable/disable of arg-name checking',
    use_timing_guarantees: 'Drop synth/sample triggers that arrive late',
    with_timing_guarantees: 'Block-scoped late-trigger drop policy',
    use_merged_synth_defaults: 'Merge new synth defaults with the existing ones',
    with_merged_synth_defaults: 'Block-scoped merge of synth defaults',
    use_merged_sample_defaults: 'Merge new sample defaults with the existing ones',
    with_merged_sample_defaults: 'Block-scoped merge of sample defaults',
    with_debug: 'Block-scoped enable/disable of debug logging',
    current_timing_guarantees: 'Get current timing-guarantees setting',
    // Tier C PR #2 — sample/buffer registry
    sample_paths: 'Ring of known sample names (optional substring filter)',
    sample_buffer: 'Buffer-info object for a named sample',
    sample_free: 'Drop a single sample from the loaded cache',
    sample_free_all: 'Drop every sample from the loaded cache',
    load_samples: 'Pre-load bundled samples to avoid first-trigger latency',
    buffer: 'Browser stub: returns {name, duration} for a named buffer',
    // Tier C PR #3 — mixer + introspection
    set_mixer_control: 'Control the main mixer (lpf/hpf/amp/bypass)',
    reset_mixer: 'Reset the main mixer to its default settings',
    scsynth_info: 'Audio engine info (sample rate, bus counts, etc.)',
    status: 'Synthesis environment status (active synths, CPU load)',
    vt: 'Current thread\'s virtual run time (alias of current_time)',
    bt: 'Beat-time conversion: scales seconds by current BPM',
    rt: 'Real-time conversion: bypasses BPM scaling',
  }
  for (const [name, info] of Object.entries(dslFunctions)) {
    items.push({ label: name, type: 'function', info })
  }

  // Keywords
  for (const kw of ['do', 'end', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'true', 'false', 'nil']) {
    items.push({ label: kw, type: 'keyword' })
  }

  // Synths — prefixed with : for Sonic Pi style
  for (const s of KNOWN_SYNTHS) {
    items.push({ label: s, type: 'enum', info: `Synth: ${s}` })
  }

  // Samples
  for (const s of KNOWN_SAMPLES) {
    items.push({ label: s, type: 'enum', info: `Sample: ${s}` })
  }

  // FX
  for (const f of KNOWN_FX) {
    items.push({ label: f, type: 'enum', info: `FX: ${f}` })
  }

  // Parameters (union of all synth + FX params, deduplicated)
  const allParams = new Set<string>()
  for (const params of Object.values(SYNTH_PARAMS)) {
    for (const p of params) allParams.add(p)
  }
  for (const params of Object.values(FX_PARAMS)) {
    for (const p of params) allParams.add(p)
  }
  for (const p of allParams) {
    items.push({ label: p, type: 'property', info: `Parameter: ${p}` })
  }

  return items
}

const COMPLETIONS = buildCompletions()

export class Editor {
  private view: EditorView | null = null
  private container: HTMLElement
  private fallbackTextarea: HTMLTextAreaElement | null = null
  private onRunCallback: (() => void) | null = null
  private onStopCallback: (() => void) | null = null
  private onCursorWordChange: ((word: string) => void) | null = null
  private currentFontSize: number = 14

  constructor(container: HTMLElement) {
    this.container = container
    this.container.style.cssText = `
      height: 100%; overflow: hidden;
      background: ${theme.bgDarker};
    `
    // Load saved font size
    try {
      const saved = localStorage.getItem('spw-font-size')
      if (saved) this.currentFontSize = Math.max(10, Math.min(24, parseInt(saved)))
    } catch { /* ignore */ }
  }

  async init(initialCode: string): Promise<void> {
    try {
      const cm = await this.loadCodeMirror()
      this.createEditorView(cm, initialCode)
    } catch (err) {
      console.warn('CodeMirror load failed, using textarea fallback:', err)
      this.createFallback(initialCode)
    }
  }

  getValue(): string {
    if (this.view) return this.view.state.doc.toString()
    if (this.fallbackTextarea) return this.fallbackTextarea.value
    return ''
  }

  setValue(code: string): void {
    if (this.view) {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: code },
      })
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea.value = code
    }
  }

  /** Insert text at the current cursor position (or replace selection). */
  insertAtCursor(text: string): void {
    if (this.view) {
      const sel = this.view.state.selection?.main ?? { from: 0, to: 0 }
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
      })
    } else if (this.fallbackTextarea) {
      const ta = this.fallbackTextarea
      const start = ta.selectionStart
      const end = ta.selectionEnd
      ta.value = ta.value.substring(0, start) + text + ta.value.substring(end)
      ta.selectionStart = ta.selectionEnd = start + text.length
    }
  }

  onRun(callback: () => void): void { this.onRunCallback = callback }
  onStop(callback: () => void): void { this.onStopCallback = callback }
  /** Register a callback for cursor word changes (used by HelpPanel). */
  onCursorWord(callback: (word: string) => void): void { this.onCursorWordChange = callback }

  /** Return the word currently under the cursor (for Help panel on-show). */
  getCurrentWord(): string {
    if (this.view) {
      const doc = this.view.state.doc.toString()
      const pos = this.view.state.selection?.main?.from ?? 0
      let start = pos, end = pos
      while (start > 0 && /\w/.test(doc[start - 1])) start--
      while (end < doc.length && /\w/.test(doc[end])) end++
      return start < end ? doc.slice(start, end) : ''
    }
    if (this.fallbackTextarea) {
      const val = this.fallbackTextarea.value
      const pos = this.fallbackTextarea.selectionStart
      let start = pos, end = pos
      while (start > 0 && /\w/.test(val[start - 1])) start--
      while (end < val.length && /\w/.test(val[end])) end++
      return start < end ? val.slice(start, end) : ''
    }
    return ''
  }

  /** Highlight an error line (1-based). Call with null to clear. */
  highlightErrorLine(line: number | null): void {
    // Remove previous error highlight
    if (this.errorLineEl) {
      // If it's a marker with a styled element reference, restore styles
      const styledEl = (this.errorLineEl as any)._styledEl as HTMLElement | undefined
      if (styledEl) {
        styledEl.style.background = ''
        styledEl.style.borderLeft = ''
      }
      this.errorLineEl.remove()
      this.errorLineEl = null
    }

    if (line === null) return

    if (this.view) {
      const doc = this.view.state.doc.toString()
      const lines = doc.split('\n')
      if (line > 0 && line <= lines.length) {
        // Compute char offset to scroll to the error line
        let charOffset = 0
        for (let i = 0; i < line - 1; i++) charOffset += lines[i].length + 1
        try { this.view.dispatch({ selection: { anchor: charOffset } }) } catch { /* ignore scroll errors */ }

        // Style the .cm-line element directly
        const cmLines = this.container.querySelectorAll('.cm-line')
        const targetEl = cmLines[line - 1] as HTMLElement | undefined
        if (targetEl) {
          targetEl.style.background = 'rgba(232,82,124,0.15)'
          targetEl.style.borderLeft = '3px solid #E8527C'
          const marker = document.createElement('span')
          marker.style.display = 'none'
          this.container.appendChild(marker)
          this.errorLineEl = marker
          ;(marker as any)._styledEl = targetEl
        } else {
          // Fallback: CSS nth-child
          const style = document.createElement('style')
          style.textContent = `.cm-line:nth-child(${line}) { background: rgba(232,82,124,0.15) !important; border-left: 3px solid #E8527C !important; }`
          this.container.appendChild(style)
          this.errorLineEl = style
        }
      }
    } else if (this.fallbackTextarea) {
      // Textarea: can't highlight lines
    }
  }

  private errorLineEl: HTMLElement | null = null
  private onZenCallback: (() => void) | null = null

  /** Register a callback for fullscreen/zen mode (F11). */
  onZen(callback: () => void): void { this.onZenCallback = callback }

  /** Get the current font size. */
  getFontSize(): number { return this.currentFontSize }

  /** Toggle line number gutter visibility. */
  setLineNumbers(show: boolean): void {
    if (this.view) {
      const gutters = this.view.dom.querySelector('.cm-lineNumbers') as HTMLElement | null
      if (gutters) gutters.style.display = show ? '' : 'none'
    }
  }

  /** Toggle word wrap. */
  setWordWrap(on: boolean): void {
    if (this.view) {
      const content = this.view.dom.querySelector('.cm-content') as HTMLElement | null
      if (content) content.style.whiteSpace = on ? 'pre-wrap' : 'pre'
      const scroller = this.view.dom.querySelector('.cm-scroller') as HTMLElement | null
      if (scroller) scroller.style.overflowX = on ? 'hidden' : 'auto'
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea.style.whiteSpace = on ? 'pre-wrap' : 'pre'
      this.fallbackTextarea.style.overflowX = on ? 'hidden' : 'auto'
    }
  }

  /** Change editor font size by delta px. Persists to localStorage. */
  changeFontSize(delta: number): void {
    this.currentFontSize = Math.max(10, Math.min(24, this.currentFontSize + delta))
    try { localStorage.setItem('spw-font-size', String(this.currentFontSize)) } catch { /* ignore */ }

    if (this.view) {
      // CodeMirror: update the editor's CSS font-size via its DOM element
      const scroller = this.view.dom.querySelector('.cm-scroller') as HTMLElement | null
      if (scroller) scroller.style.fontSize = `${this.currentFontSize}px`
      // Also update the top-level & wrapper
      this.view.dom.style.fontSize = `${this.currentFontSize}px`
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea.style.fontSize = `${this.currentFontSize}px`
    }
  }

  dispose(): void {
    this.view?.destroy()
    this.fallbackTextarea?.remove()
  }

  private async loadCodeMirror(): Promise<CMModule> {
    // CDN dependencies — use esm.sh with major version to avoid multiple
    // @codemirror/state instances (which break instanceof checks).
    // See src/engine/cdn-manifest.ts for the full dependency manifest.

    // @ts-ignore — CDN URLs. Pin exact versions to avoid multiple @codemirror/state instances.
    const viewMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/view@6')
    // @ts-ignore
    const stateMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/state@6')
    // @ts-ignore — commands for history (undo/redo), keymaps
    const cmdMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/commands@6')

    // Sonic Pi syntax highlighting — inline tokenizer, no CDN dependency
    let rubyLang: unknown = null
    let highlightStyle: unknown = null
    try {
      // @ts-ignore
      const langMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/language@6')
      // @ts-ignore
      const highlightMod = await import(/* @vite-ignore */ 'https://esm.sh/@lezer/highlight@1')
      if (langMod.StreamLanguage) {
        rubyLang = langMod.StreamLanguage.define(sonicPiStreamParser)
      }
      // HighlightStyle lives in @codemirror/language (not @lezer/highlight) on esm.sh
      const HighlightStyle = langMod.HighlightStyle ?? highlightMod.HighlightStyle
      const tags = highlightMod.tags
      if (langMod.syntaxHighlighting && HighlightStyle && tags) {
        const t = tags
        // Desktop Sonic Pi dark-theme palette (sonic-pi-net/sonic-pi
        // app/gui/model/sonicpitheme.cpp L437-451 + L509-591):
        //   dt_pink=deeppink(#FF1493) dt_gold=#FBDE2D dt_blue=#4c83ff
        //   dt_green=#61CE3C dt_grey=#5e5e5e dt_white=#FFFFFF
        highlightStyle = langMod.syntaxHighlighting(
          HighlightStyle.define([
            { tag: t.keyword, color: '#FBDE2D', fontWeight: '500' },
            { tag: t.atom, color: '#FF1493' },
            { tag: t.number, color: '#4c83ff' },
            { tag: t.string, color: '#61CE3C' },
            { tag: t.regexp, color: '#61CE3C' },
            { tag: t.comment, color: '#5e5e5e', fontStyle: 'italic' },
            { tag: t.variableName, color: '#FFFFFF' },
            { tag: t.function(t.variableName), color: '#FF1493' },
            { tag: t.propertyName, color: '#FF1493' },
            { tag: t.operator, color: '#FFFFFF' },
            { tag: t.bracket, color: '#FFFFFF' },
            { tag: t.paren, color: '#FFFFFF' },
            { tag: t.punctuation, color: '#FFFFFF' },
          ])
        )
      }
    } catch {
      // Language module unavailable — editor still works, just no colors
    }

    // Autocomplete — graceful degradation if CDN unavailable
    let autocompletionFn: ((config: Record<string, unknown>) => unknown) | null = null
    try {
      // @ts-ignore
      const acMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/autocomplete@6')
      if (acMod.autocompletion) {
        autocompletionFn = acMod.autocompletion
      }
    } catch {
      // Autocomplete CDN unavailable — editor works without it
    }

    const { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
            drawSelection, dropCursor, rectangularSelection, crosshairCursor,
            highlightSpecialChars } = viewMod
    const { EditorState } = stateMod
    // Build basicSetup manually — esm.sh's 'codemirror' package doesn't export it reliably.
    // This mirrors CodeMirror 6's basicSetup: line numbers, active line, history, bracket matching, etc.
    const basicSetup: unknown[] = []
    if (lineNumbers) basicSetup.push(lineNumbers())
    if (highlightActiveLineGutter) basicSetup.push(highlightActiveLineGutter())
    if (highlightSpecialChars) basicSetup.push(highlightSpecialChars())
    if (cmdMod.history) basicSetup.push(cmdMod.history())
    if (drawSelection) basicSetup.push(drawSelection())
    if (dropCursor) basicSetup.push(dropCursor())
    if (rectangularSelection) basicSetup.push(rectangularSelection())
    if (crosshairCursor) basicSetup.push(crosshairCursor())
    if (highlightActiveLine) basicSetup.push(highlightActiveLine())
    // Bracket matching from language module
    try {
      // @ts-ignore
      const langMod2 = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/language@6')
      if (langMod2.bracketMatching) basicSetup.push(langMod2.bracketMatching())
      if (langMod2.indentOnInput) basicSetup.push(langMod2.indentOnInput())
    } catch { /* optional */ }
    // Default keybindings (undo, redo, indent, etc.)
    if (cmdMod.defaultKeymap) basicSetup.push(keymap.of(cmdMod.defaultKeymap))
    if (cmdMod.historyKeymap) basicSetup.push(keymap.of(cmdMod.historyKeymap))

    return { EditorView, EditorState, basicSetup, keymap, rubyLang, highlightStyle, autocompletion: autocompletionFn } as unknown as CMModule
  }

  private createEditorView(cm: CMModule, initialCode: string): void {
    // Build extensions array — each one is optional, skip if it fails
    const extensions: unknown[] = []

    // Basic setup (line numbers, bracket matching, history, etc.)
    if (Array.isArray(cm.basicSetup)) {
      extensions.push(...cm.basicSetup)
    } else if (cm.basicSetup) {
      extensions.push(cm.basicSetup)
    }

    // Dark theme
    try {
      // Desktop Sonic Pi dark-theme syntax colors from sonicpitheme.cpp,
      // but container bg unified with Console/CueLog (theme.bgDarker)
      // so the editor and logs read as one continuous dark-blue surface.
      const editorTheme = cm.EditorView.theme({
        '&': { height: '100%', fontSize: `${this.currentFontSize}px`, background: theme.bgDarker },
        '.cm-scroller': {
          fontFamily: "'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
          lineHeight: '1.65',
        },
        '.cm-content': { color: '#FFFFFF', caretColor: '#FF1493', padding: '0.5rem 0' },
        '.cm-gutters': { background: theme.bgDarker, color: '#5e5e5e', border: 'none', paddingRight: '8px', minWidth: '3.5em' },
        '.cm-lineNumbers .cm-gutterElement': { minWidth: '3em', textAlign: 'right', paddingRight: '8px' },
        '.cm-activeLineGutter': { background: theme.bgHighlight, color: '#ededed' },
        '.cm-activeLine': { background: theme.bgHighlight },
        '&.cm-focused .cm-cursor': { borderLeftColor: '#FF1493', borderLeftWidth: '2px' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          background: 'rgba(255,20,147,0.35) !important',
        },
        '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
          color: '#FF1493',
          backgroundColor: '#ededed',
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
          background: '#1e1e1e',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul': {
          fontFamily: "'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
          fontSize: '0.75rem',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
          color: '#ededed',
          padding: '2px 8px',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          background: 'rgba(255,20,147,0.35)',
          color: '#FFFFFF',
        },
        '.cm-completionIcon': {
          opacity: '0.6',
        },
        '.cm-tooltip.cm-completionInfo': {
          background: '#1e1e1e',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          color: '#ededed',
          padding: '6px 10px',
          fontSize: '0.7rem',
          fontFamily: "'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        },
        '.cm-tooltip': {
          background: '#1e1e1e',
          border: '1px solid rgba(255,255,255,0.1)',
          color: '#ededed',
        },
      } as Record<string, unknown>)
      if (editorTheme) extensions.push(editorTheme)
    } catch { /* theme failed — use default */ }

    // Keybindings
    try {
      const runKeymap = cm.keymap.of([
        // Run is ALSO wired at the document level in App.ts (so focus on console/
        // scope still triggers Run). The editor-level binding here exists to
        // consume the event before CodeMirror's default Enter handler inserts
        // a newline into the buffer.
        { key: 'Mod-Enter', preventDefault: true, run: () => { this.onRunCallback?.(); return true } },
        { key: 'Escape', run: () => { this.onStopCallback?.(); return true } },
        { key: 'F11', run: () => { this.onZenCallback?.(); return true } },
        {
          key: 'Mod-/',
          run: (view: EditorView) => {
            // Toggle Ruby # comments — only change affected lines
            const doc = view.state.doc.toString()
            const sel = view.state.selection?.main ?? { from: 0, to: 0 }
            const lines = doc.split('\n')
            const fromLine = doc.substring(0, sel.from).split('\n').length
            const toLine = doc.substring(0, sel.to).split('\n').length

            const selectedLines = lines.slice(fromLine - 1, toLine)
            const allCommented = selectedLines.every(l => l.trimStart().startsWith('#') || l.trim() === '')

            // Compute char offset of the affected line range
            let rangeStart = 0
            for (let i = 0; i < fromLine - 1; i++) rangeStart += lines[i].length + 1
            let rangeEnd = rangeStart
            for (let i = fromLine - 1; i < toLine; i++) rangeEnd += lines[i].length + (i < toLine - 1 ? 1 : 0)

            // Build replacement for only the affected lines
            const newLines: string[] = []
            for (let i = fromLine - 1; i < toLine; i++) {
              if (allCommented) {
                newLines.push(lines[i].replace(/^(\s*)#\s?/, '$1'))
              } else {
                newLines.push(lines[i].trim() !== '' ? lines[i].replace(/^(\s*)/, '$1# ') : lines[i])
              }
            }

            view.dispatch({
              changes: { from: rangeStart, to: rangeEnd, insert: newLines.join('\n') },
            })
            return true
          },
        },
      ])
      if (runKeymap) extensions.push(runKeymap)
    } catch { /* keybindings failed */ }

    // Sonic Pi language support + syntax colors
    if (cm.rubyLang) extensions.push(cm.rubyLang)
    if (cm.highlightStyle) extensions.push(cm.highlightStyle)

    // Autocomplete — static word list with prefix matching
    if (cm.autocompletion) {
      try {
        const completionSource = (context: { pos: number; state: EditorState; matchBefore(re: RegExp): { from: number; text: string } | null; explicit: boolean }) => {
          const word = context.matchBefore(/\w+/)
          if (!word && !context.explicit) return null
          return {
            from: word ? word.from : context.pos,
            options: COMPLETIONS,
            validFor: /^\w*$/,
          }
        }
        const acExt = cm.autocompletion({
          override: [completionSource as unknown as never],
          activateOnTyping: true,
          maxRenderedOptions: 30,
        })
        if (acExt) extensions.push(acExt)
      } catch { /* autocomplete wiring failed — proceed without */ }
    }

    // Cursor change listener — notify HelpPanel of word under cursor
    try {
      const cursorListener = cm.EditorView.updateListener.of((update: unknown) => {
        const u = update as { selectionSet?: boolean; state: EditorState }
        if (!u.selectionSet || !this.onCursorWordChange) return
        const pos = u.state.selection?.main?.from ?? 0
        const doc = u.state.doc.toString()
        let start = pos, end = pos
        while (start > 0 && /\w/.test(doc[start - 1])) start--
        while (end < doc.length && /\w/.test(doc[end])) end++
        this.onCursorWordChange(start < end ? doc.slice(start, end) : '')
      })
      extensions.push(cursorListener)
    } catch { /* cursor listener failed — help panel won't update */ }

    const state = cm.EditorState.create({
      doc: initialCode,
      extensions: extensions.filter(Boolean),
    })

    this.view = new cm.EditorView({
      state,
      parent: this.container,
    })
  }

  private createFallback(initialCode: string): void {
    const textarea = document.createElement('textarea')
    textarea.value = initialCode
    textarea.spellcheck = false
    textarea.style.cssText = `
      width: 100%; height: 100%;
      background: #111921;
      color: #CDD3DE;
      border: none;
      padding: 1rem;
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', monospace;
      font-size: ${this.currentFontSize}px;
      line-height: 1.65;
      resize: none;
      outline: none;
      tab-size: 2;
    `
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        this.onRunCallback?.()
      }
      if (e.altKey && e.key === 'r') {
        e.preventDefault()
        this.onRunCallback?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.onStopCallback?.()
      }
      if (e.altKey && e.key === 's') {
        e.preventDefault()
        this.onStopCallback?.()
      }
      if (e.key === 'F11') {
        e.preventDefault()
        this.onZenCallback?.()
      }
      // Tab inserts 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = textarea.selectionStart
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(textarea.selectionEnd)
        textarea.selectionStart = textarea.selectionEnd = start + 2
      }
      // Ctrl+/ toggle Ruby # comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        const val = textarea.value
        const start = val.lastIndexOf('\n', textarea.selectionStart - 1) + 1
        const end = val.indexOf('\n', textarea.selectionEnd)
        const lineEnd = end === -1 ? val.length : end
        const line = val.substring(start, lineEnd)
        const toggled = line.trimStart().startsWith('#')
          ? line.replace(/^(\s*)#\s?/, '$1')
          : line.replace(/^(\s*)/, '$1# ')
        textarea.value = val.substring(0, start) + toggled + val.substring(lineEnd)
        textarea.selectionStart = start
        textarea.selectionEnd = start + toggled.length
      }
    })
    this.container.appendChild(textarea)
    this.fallbackTextarea = textarea
  }
}
