/**
 * App shell — SonicPi.js.
 * Matches Sonic Pi desktop layout with welcome experience.
 */

import { SonicPiEngine } from '../engine/SonicPiEngine'
import { friendlyError } from '../engine/FriendlyErrors'
import { Recorder } from '../engine/Recorder'
import { SessionLog } from '../engine/SessionLog'
import { examples as allExamples, type Example } from '../engine/examples'
import { Editor } from './Editor'
import { Scope } from './Scope'
import { Console } from './Console'
import { Toolbar, type MidiDeviceInfo } from './Toolbar'
import { MenuBar } from './MenuBar'
import { CueLog } from './CueLog'
import { SampleBrowser } from './SampleBrowser'
import { HelpPanel } from './HelpPanel'
import { APP_VERSION } from './version'
import { decodeShareCode, buildShareURL, pickInitialBuffer } from './ShareLink'
import { theme } from './theme'
import { track, EVENTS, errorClass, detectBrowserFamily } from './Analytics'

// Welcome buffer — "Solar Flare" (progressive trance) is the default piece
const WELCOME_CODE = `#
#  Press Run (Ctrl+Enter or Alt+R) to hear this piece.
#  Press Stop (Esc or Alt+S) to silence everything.
#  Edit the code while it plays — changes apply instantly!
#
#  github.com/MrityunjayBhardwaj/SonicPi.js
#  Also checkout Sonic Tau: https://sonic-pi.net/tau/
#
#  Standing on the shoulders of giants:
#    Sonic Pi & Sam Aaron  — sonic-pi.net
#    SuperCollider          — supercollider.github.io
#    Sonic Pi community     — in-thread.sonic-pi.net
#
# "Solar Flare" — Progressive Trance
# Inspired by the Sonic Pi community
# Technique: line() filter sweeps, building arpeggios, layered pads

use_bpm 138

live_loop :director do
  set :section, 0  # intro: kick + rising filter arp
  sleep 32
  set :section, 1  # build: pads enter, arp intensifies
  sleep 32
  set :section, 2  # drop: full euphoric chords + bass
  sleep 64
  set :section, 3  # breakdown: pad solo, no drums
  sleep 16
  set :section, 4  # climax: everything, peak energy
  sleep 48
  stop
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 1.5 if s == 0 or s == 1
  vol = 2.0 if s == 2 or s == 4
  sample :bd_haus, amp: vol
  sleep 1
end

live_loop :offbeat_hat do
  s = get[:section]
  vol = 0
  vol = 0.4 if s == 0 or s == 1
  vol = 0.6 if s == 2 or s == 4
  sleep 0.5
  sample :drum_cymbal_closed, amp: vol
  sleep 0.5
end

live_loop :clap do
  s = get[:section]
  vol = 0
  vol = 0.8 if s == 1
  vol = 1.2 if s == 2 or s == 4
  sleep 1
  sample :sn_dub, amp: vol
  sleep 1
end

live_loop :arp do
  s = get[:section]
  use_synth :saw
  vol = 0
  vol = 0.2 if s == 0
  vol = 0.3 if s == 1
  vol = 0.4 if s == 2 or s == 4
  vol = 0.15 if s == 3
  co = 70
  co = 90 if s == 1
  co = 110 if s >= 2
  notes = scale(:a3, :minor_pentatonic, num_octaves: 2)
  with_fx :echo, phase: 0.25, decay: 4, mix: 0.4 do
    play notes.tick, release: 0.15, amp: vol, cutoff: co
    sleep 0.125
  end
end

live_loop :pad do
  s = get[:section]
  use_synth :prophet
  vol = 0
  vol = 0.3 if s == 1
  vol = 0.5 if s == 2
  vol = 0.6 if s == 3
  vol = 0.5 if s == 4
  chords = [chord(:a3, :minor), chord(:f3, :major),
            chord(:c4, :major), chord(:g3, :major)]
  with_fx :reverb, room: 0.8, mix: 0.5 do
    play chords.tick, attack: 1, release: 6, amp: vol, cutoff: 90
    sleep 4
  end
end

live_loop :bass do
  s = get[:section]
  use_synth :sine
  vol = 0
  vol = 0.6 if s == 2
  vol = 0.8 if s == 4
  notes = ring(:a1, :a1, :f1, :f1, :c2, :c2, :g1, :g1)
  play notes.tick, release: 0.4, amp: vol
  sleep 0.5
end

live_loop :riser do
  s = get[:section]
  use_synth :cnoise
  vol = 0
  vol = 0.06 if s == 1
  vol = 0.08 if s == 3
  with_fx :hpf, cutoff: rrand(70, 100) do
    play :c4, release: 4, amp: vol
  end
  sleep 4
end`

// Welcome log — credits and shortcuts
const WELCOME_LOG = [
  '',
  `  Sonic Pi Web v${APP_VERSION}`,
  '',
  '  -------------------------------------------------------',
  '  Standing on the shoulders of giants:',
  '    Sonic Pi & Sam Aaron    sonic-pi.net',
  '    SuperCollider            supercollider.github.io',
  '    Sonic Pi community       in-thread.sonic-pi.net',
  '  -------------------------------------------------------',
  '',
  '  Shortcuts:',
  '    Ctrl+Enter / Alt+R    Run code',
  '    Escape / Alt+S        Stop all',
  '    Ctrl+/                Toggle comment',
  '    F11                   Fullscreen',
  '',
  '  Happy live coding!',
  '',
]

const BUFFER_COUNT = 10

export class App {
  private engine: SonicPiEngine | null = null
  private editor!: Editor
  private scope!: Scope
  private console!: Console
  private cueLog!: CueLog
  private toolbar!: Toolbar
  private menuBar!: MenuBar
  private playing = false
  private root: HTMLElement
  private panelVisibility: Record<string, boolean> = {
    log: true, cueLog: true, scope: true, buttons: true, tabs: true,
  }

  // Buffer management — 10 buffers like Sonic Pi
  private buffers: string[] = Array(BUFFER_COUNT).fill('')
  private activeBuffer = 0
  /** True when buffer[0] came from a share link (incl. an intentionally
   *  empty `#c=` payload). Lets init() honor a shared blank buffer instead
   *  of falling through `|| WELCOME_CODE`. Contract: ShareLink round-trips
   *  '' → '' (#306/#308). */
  private loadedFromShare = false
  private eventStreamHandler: ((event: unknown) => void) | null = null
  private recorder: Recorder | null = null
  private isRecording = false
  private sessionLog = new SessionLog()
  private helpPanel!: HelpPanel
  private sampleBrowser: SampleBrowser | null = null
  private midiInitialized = false
  /** Set of selected MIDI input device IDs (tracked locally for UI state). */
  private selectedMidiInputs = new Set<string>()
  /** Set of selected MIDI output device IDs (tracked locally for UI state). */
  private selectedMidiOutputs = new Set<string>()
  /** User preferences persisted to localStorage. */
  private prefs: Record<string, number | boolean> = {}

  constructor(root: HTMLElement) {
    this.root = root
    this.loadBuffers()
    try {
      const saved = localStorage.getItem('spw-panel-visibility')
      if (saved) this.panelVisibility = { ...this.panelVisibility, ...JSON.parse(saved) }
    } catch { /* ignore */ }
    this.loadPrefs()
    this.buildLayout()
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  private loadPrefs(): void {
    try {
      const saved = localStorage.getItem('spw-prefs')
      if (saved) this.prefs = JSON.parse(saved)
    } catch { /* ignore */ }
  }

  private savePrefs(): void {
    try { localStorage.setItem('spw-prefs', JSON.stringify(this.prefs)) } catch { /* ignore */ }
  }

  private applyPref(key: string, value: number | boolean): void {
    this.prefs[key] = value
    this.savePrefs()

    switch (key) {
      // Audio
      case 'masterVolume':
        if (this.engine) this.engine.setVolume((value as number) / 100)
        break
      case 'mixerPreAmp':
        if (this.engine) this.engine.setMixerPreAmp(value as number)
        break
      case 'mixerAmp':
        if (this.engine) this.engine.setMixerAmp(value as number)
        break

      // Visuals
      case 'scopeLineWidth':
        this.scope.setLineWidth(value as number)
        break
      case 'scopeGlow':
        this.scope.setGlow(value as number)
        break
      case 'scopeTrail':
        this.scope.setTrail((value as number) / 100)
        break
      case 'scopeHue':
        this.scope.setHueShift(value as number)
        break

      // Editor
      case 'autoScrollLog':
        this.console.setAutoScroll(value as boolean)
        break
      case 'showLineNumbers':
        this.editor.setLineNumbers(value as boolean)
        break
      case 'wordWrap':
        this.editor.setWordWrap(value as boolean)
        break

      // Performance
      case 'schedAheadTime':
        // Applied on next engine init
        break
    }
  }

  private getPrefs(): Record<string, number | boolean> {
    return {
      masterVolume: 80,
      mixerPreAmp: 0.3,
      mixerAmp: 0.8,
      scopeLineWidth: 2,
      scopeGlow: 4,
      scopeTrail: 25,
      scopeHue: 0,
      fontSize: this.editor?.getFontSize?.() ?? 14,
      autoScrollLog: true,
      showLineNumbers: true,
      wordWrap: false,
      schedAheadTime: 0.3,
      ...this.prefs,
    }
  }

  /** Apply all saved prefs on startup (after UI is built). */
  private applyAllPrefs(): void {
    const p = this.getPrefs()
    // Apply visual prefs immediately
    this.scope.setLineWidth(p.scopeLineWidth as number)
    this.scope.setGlow(p.scopeGlow as number)
    this.scope.setTrail((p.scopeTrail as number) / 100)
    this.scope.setHueShift(p.scopeHue as number)
    if (p.autoScrollLog === false) this.console.setAutoScroll(false)
    if (p.showLineNumbers === false) this.editor.setLineNumbers(false)
    if (p.wordWrap === true) this.editor.setWordWrap(true)
  }

  /** Load buffers from localStorage, falling back to welcome code. */
  private loadBuffers(): void {
    // A share link takes precedence over everything: you clicked someone's
    // permalink, you want their track — not your stale localStorage buffer.
    // Strip the hash afterwards so a refresh / unload-save behaves normally
    // (the shared code is now just the active buffer).
    const shared = decodeShareCode()
    if (shared !== null) {
      this.buffers[0] = shared
      this.loadedFromShare = true
      try {
        history.replaceState(null, '', location.pathname + location.search)
      } catch { /* history API unavailable — harmless, hash just lingers */ }
      return
    }
    try {
      const saved = localStorage.getItem('spw-buffers')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length === BUFFER_COUNT) {
          // Only use saved buffers if at least one has content
          const hasContent = parsed.some((b: string) => b.trim().length > 0)
          if (hasContent) {
            this.buffers = parsed
            return
          }
        }
      }
    } catch { /* ignore */ }
    this.buffers[0] = WELCOME_CODE
  }

  /** Save buffers to localStorage. */
  private saveBuffers(): void {
    // Don't save if editor hasn't initialized (would overwrite with empty)
    if (!this.editor) return
    const val = this.editor.getValue()
    if (val.trim().length === 0 && this.buffers[this.activeBuffer].trim().length > 0) {
      // Editor returned empty but buffer had content — editor not ready yet, skip save
      return
    }
    this.buffers[this.activeBuffer] = val
    try {
      localStorage.setItem('spw-buffers', JSON.stringify(this.buffers))
    } catch { /* storage full or unavailable */ }
  }

  async init(): Promise<void> {
    await this.editor.init(
      pickInitialBuffer(this.buffers[0], this.loadedFromShare, WELCOME_CODE),
    )
    this.editor.onRun(() => this.handlePlay())
    this.editor.onStop(() => this.handleStop())
    this.editor.onZen(() => this.toggleZen())
    this.editor.onCursorWord((word) => this.helpPanel.updateWord(word))
    this.helpPanel.getCurrentWord = () => this.editor.getCurrentWord()

    // Show buffer content indicators
    this.updateBufferIndicators()

    // Save buffers on page unload
    window.addEventListener('beforeunload', () => this.saveBuffers())

    // Stop the engine on tab close so pre-bundled `/s_new` messages with future
    // NTP timetags don't keep spawning synths in scsynth's WASM scheduler queue
    // during AudioContext wind-down. `pagehide` fires reliably on close,
    // navigation, and bfcache (more reliable than `beforeunload`).
    window.addEventListener('pagehide', () => {
      try { this.engine?.stop() } catch { /* tab is dying — best effort */ }
    })

    // Tab backgrounding: warn and resume AudioContext when tab returns (#7)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.playing) {
          this.console.logSystem('  [Warning] Tab hidden — audio may be suspended by the browser.')
        }
      } else {
        // Resume AudioContext if it was suspended by the browser
        const audio = this.engine?.components?.audio
        if (audio?.audioCtx?.state === 'suspended') {
          audio.audioCtx.resume().then(() => {
            this.console.logSystem('  Audio resumed.')
          }).catch(() => {})
        }
      }
    })

    // Apply saved preferences
    this.applyAllPrefs()

    // Show welcome log
    for (const line of WELCOME_LOG) {
      this.console.logSystem(line)
    }
  }

  private buildLayout(): void {
    this.root.innerHTML = ''
    this.root.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: ${theme.bgDark};
      color: ${theme.fg};
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
      overflow: hidden;
    `

    // Toolbar
    const toolbarContainer = document.createElement('div')
    toolbarContainer.style.cssText = `
      background: ${theme.bg};
      border-bottom: 1px solid ${theme.border};
      flex-shrink: 0;
    `
    this.root.appendChild(toolbarContainer)
    this.toolbar = new Toolbar(toolbarContainer, {
      onPlay: () => this.handlePlay(),
      onStop: () => this.handleStop(),
      onRecord: () => this.handleRecord(),
      onExample: (ex) => this.loadExample(ex),
      onBufferSelect: (i) => this.switchBuffer(i),
      onVolumeChange: (v) => { if (this.engine) this.engine.setVolume(v) },
      getMidiDevices: () => this.getMidiDevices(),
      onMidiDeviceToggle: (id, type, selected) => this.toggleMidiDevice(id, type, selected),
      onOpenSampleBrowser: () => this.openSampleBrowser(),
      onFontSizeChange: (delta) => this.editor.changeFontSize(delta),
      onSave: () => this.handleSave(),
      onLoad: () => this.handleLoad(),
      onShare: () => this.handleShare(),
      onZen: () => this.toggleZen(),
    })

    // Main area
    const main = document.createElement('div')
    main.className = 'spw-main'
    main.style.cssText = `
      flex: 1; display: flex;
      overflow: hidden; min-height: 0;
    `
    this.root.appendChild(main)

    // Editor panel (left)
    const editorPanel = document.createElement('div')
    editorPanel.className = 'spw-editor-panel'
    editorPanel.style.cssText = `
      flex: 1; min-width: 0; overflow: hidden;
      display: flex; flex-direction: column;
    `
    main.appendChild(editorPanel)

    // Editor header
    const editorHeader = document.createElement('div')
    editorHeader.style.cssText = `
      padding: 0.3rem 0.6rem;
      font-size: 0.65rem;
      color: ${theme.comment};
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid ${theme.border};
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
      background: ${theme.bgPanel};
    `
    const edTitle = document.createElement('span')
    edTitle.textContent = 'Buffer 0'
    edTitle.id = 'spw-buffer-title'
    editorHeader.appendChild(edTitle)

    const edHint = document.createElement('span')
    edHint.textContent = 'Ctrl+Enter to run'
    edHint.style.cssText = `margin-left: auto; color: ${theme.fgFaint};`
    editorHeader.appendChild(edHint)
    editorPanel.appendChild(editorHeader)

    const editorWrap = document.createElement('div')
    editorWrap.style.cssText = 'flex: 1; min-height: 0; overflow: hidden;'
    editorPanel.appendChild(editorWrap)
    this.editor = new Editor(editorWrap)

    // Help panel (below editor, hidden by default)
    this.helpPanel = new HelpPanel(editorPanel)

    // --- Reusable draggable splitter factory ---
    const self = this
    function createSplitter(
      direction: 'horizontal' | 'vertical',
      storageKey: string,
      onResize: (delta: number) => void,
    ): HTMLElement {
      const el = document.createElement('div')
      const isH = direction === 'horizontal'
      let dragging = false

      el.style.cssText = [
        isH ? 'height: 4px; cursor: row-resize;' : 'width: 4px; cursor: col-resize;',
        `background: ${theme.border};`,
        'flex-shrink: 0;',
        'transition: background 0.15s;',
        'position: relative;',
        'z-index: 5;',
      ].join(' ')

      const setIdle = () => {
        el.style.background = theme.border
        el.style[isH ? 'height' : 'width'] = '4px'
      }

      el.addEventListener('mouseenter', () => {
        el.style.background = theme.accentHover
        el.style[isH ? 'height' : 'width'] = '6px'
      })
      el.addEventListener('mouseleave', () => { if (!dragging) setIdle() })

      const startDrag = (startPos: number, getPos: (e: MouseEvent | Touch) => number) => {
        dragging = true
        el.style.background = theme.accentDrag
        let last = startPos

        const onMove = (e: MouseEvent) => {
          const pos = getPos(e)
          onResize(pos - last)
          last = pos
        }
        const onUp = () => {
          dragging = false
          setIdle()
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        startDrag(isH ? e.clientY : e.clientX, (ev) => isH ? ev.clientY : ev.clientX)
      })

      // Touch support
      el.addEventListener('touchstart', (e) => {
        e.preventDefault()
        const t = e.touches[0]
        dragging = true
        el.style.background = theme.accentDrag
        let last = isH ? t.clientY : t.clientX

        const onTouchMove = (ev: TouchEvent) => {
          const pos = isH ? ev.touches[0].clientY : ev.touches[0].clientX
          onResize(pos - last)
          last = pos
        }
        const onTouchEnd = () => {
          dragging = false
          setIdle()
          document.removeEventListener('touchmove', onTouchMove)
          document.removeEventListener('touchend', onTouchEnd)
        }
        document.addEventListener('touchmove', onTouchMove, { passive: false })
        document.addEventListener('touchend', onTouchEnd)
      }, { passive: false })

      return el
    }

    // --- Vertical splitter (editor <-> right panel) ---
    const mainSplitter = createSplitter('vertical', 'spw-split-main', (delta) => {
      const edW = editorPanel.getBoundingClientRect().width + delta
      const rpW = rightPanel.getBoundingClientRect().width - delta
      if (edW >= 200 && rpW >= 200) {
        editorPanel.style.flex = 'none'
        editorPanel.style.width = `${edW}px`
        rightPanel.style.width = `${rpW}px`
        rightPanel.style.maxWidth = 'none'
        try { localStorage.setItem('spw-split-main', JSON.stringify({ ed: edW, rp: rpW })) } catch {}
        self.scope?.rebuildCanvases?.()
      }
    })
    main.appendChild(mainSplitter)

    // Right panel
    const rightPanel = document.createElement('div')
    rightPanel.className = 'spw-right'
    rightPanel.style.cssText = `
      width: 40%; min-width: 280px; max-width: 520px;
      display: flex; flex-direction: column;
      overflow: hidden; background: ${theme.bgDark};
    `
    main.appendChild(rightPanel)

    // Load saved main split
    try {
      const saved = localStorage.getItem('spw-split-main')
      if (saved) {
        const { ed, rp } = JSON.parse(saved)
        editorPanel.style.flex = 'none'
        editorPanel.style.width = `${ed}px`
        rightPanel.style.width = `${rp}px`
        rightPanel.style.maxWidth = 'none'
      }
    } catch {}

    // Scope
    const scopeContainer = document.createElement('div')
    scopeContainer.className = 'spw-scope'
    scopeContainer.style.cssText = `
      height: 140px; min-height: 80px;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgDark};
      flex-shrink: 0;
      overflow: hidden;
    `
    rightPanel.appendChild(scopeContainer)
    this.scope = new Scope(scopeContainer)

    // Load saved scope height
    try {
      const savedH = localStorage.getItem('spw-split-right')
      if (savedH) scopeContainer.style.height = `${parseInt(savedH)}px`
    } catch {}

    // --- Horizontal splitter (scope <-> console) ---
    const rightSplitter = createSplitter('horizontal', 'spw-split-right', (delta) => {
      const h = scopeContainer.getBoundingClientRect().height + delta
      if (h >= 60 && h <= rightPanel.getBoundingClientRect().height - 80) {
        scopeContainer.style.height = `${h}px`
        try { localStorage.setItem('spw-split-right', String(Math.round(h))) } catch {}
        self.scope?.rebuildCanvases?.()
      }
    })
    rightSplitter.className = 'spw-scope-splitter'
    rightPanel.appendChild(rightSplitter)

    // Menu bar — topmost element, above toolbar.
    // Must be created after Scope so toggleMode/getActiveModes are available.
    this.menuBar = new MenuBar(this.root, {
      onToggleScope: (mode) => this.scope.toggleMode(mode),
      getActiveModes: () => this.scope.getActiveModes(),
      onTogglePanel: (panel, visible) => this.togglePanel(panel, visible),
      getPanelVisibility: () => this.panelVisibility,
      onLog: (msg) => this.console.logSystem(msg),
      onToggleHelp: () => this.helpPanel.toggle(),
      isHelpVisible: () => this.helpPanel.isVisible,
      prefs: {
        onPrefsChange: (key, value) => this.applyPref(key, value),
        getPrefs: () => this.getPrefs(),
      },
      getReportData: () => ({
        code: this.editor.getValue(),
        engineState: this.engine ? (this.playing ? 'playing' : 'stopped') : 'not initialized',
      }),
    })
    // Move menu bar to the very top (before toolbar)
    const menuEl = this.root.lastElementChild!
    this.root.insertBefore(menuEl, this.root.firstElementChild!)

    // Console
    const consoleContainer = document.createElement('div')
    consoleContainer.className = 'spw-console'
    consoleContainer.style.cssText = `
      flex: 1; min-height: 0; overflow: hidden;
    `
    rightPanel.appendChild(consoleContainer)
    this.console = new Console(consoleContainer)

    // Cue Log
    const cueLogContainer = document.createElement('div')
    cueLogContainer.className = 'spw-cuelog'
    cueLogContainer.style.cssText = `
      height: 120px; min-height: 60px;
      border-top: 1px solid ${theme.border};
      flex-shrink: 0;
    `
    // Load saved cue log height
    try {
      const savedH = localStorage.getItem('spw-split-cuelog')
      if (savedH) cueLogContainer.style.height = `${parseInt(savedH)}px`
    } catch {}

    // --- Horizontal splitter (console <-> cue log) ---
    const cueLogSplitter = createSplitter('horizontal', 'spw-split-cuelog', (delta) => {
      const h = cueLogContainer.getBoundingClientRect().height - delta
      if (h >= 60 && h <= rightPanel.getBoundingClientRect().height - 80) {
        cueLogContainer.style.height = `${h}px`
        try { localStorage.setItem('spw-split-cuelog', String(Math.round(h))) } catch {}
      }
    })
    cueLogSplitter.className = 'spw-cuelog-splitter'
    rightPanel.appendChild(cueLogSplitter)

    rightPanel.appendChild(cueLogContainer)
    this.cueLog = new CueLog(cueLogContainer)

    // Responsive
    const mq = window.matchMedia('(max-width: 700px)')
    const apply = (mobile: boolean) => {
      main.style.flexDirection = mobile ? 'column' : 'row'
      mainSplitter.style.display = mobile ? 'none' : ''
      if (mobile) {
        editorPanel.style.flex = 'none'
        editorPanel.style.height = '50%'
        editorPanel.style.width = ''
        rightPanel.style.width = '100%'
        rightPanel.style.maxWidth = 'none'
      } else {
        // Restore saved split or defaults
        try {
          const saved = localStorage.getItem('spw-split-main')
          if (saved) {
            const { ed, rp } = JSON.parse(saved)
            editorPanel.style.flex = 'none'
            editorPanel.style.width = `${ed}px`
            editorPanel.style.height = ''
            rightPanel.style.width = `${rp}px`
            rightPanel.style.maxWidth = 'none'
          } else {
            editorPanel.style.flex = '1'
            editorPanel.style.width = ''
            editorPanel.style.height = ''
            rightPanel.style.width = '40%'
            rightPanel.style.maxWidth = '520px'
          }
        } catch {
          editorPanel.style.flex = '1'
          editorPanel.style.width = ''
          editorPanel.style.height = ''
          rightPanel.style.width = '40%'
          rightPanel.style.maxWidth = '520px'
        }
      }
      self.scope?.rebuildCanvases?.()
    }
    apply(mq.matches)
    mq.addEventListener('change', (e) => apply(e.matches))

    // Apply saved panel visibility
    this.applyPanelVisibility()

    // Window resize — keep panels within bounds
    window.addEventListener('resize', () => {
      const mainW = main.getBoundingClientRect().width
      const edW = editorPanel.getBoundingClientRect().width
      const rpW = rightPanel.getBoundingClientRect().width
      if (edW + rpW + 4 > mainW && rpW > 200) {
        rightPanel.style.width = `${Math.max(200, mainW - edW - 8)}px`
      }
      self.scope?.rebuildCanvases?.()
    })

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.handleStop()
      }
      if (e.key === 'F11') {
        e.preventDefault()
        this.toggleZen()
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault()
        this.exportSession()
      }
      // Run on Ctrl/Cmd+Enter — document-level so it fires regardless of which
      // panel has focus (CodeMirror's own keymap only fires when the editor is
      // focused, which breaks when the user clicks into the console / scope).
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        this.handlePlay()
      }
    })
  }

  private updateBufferIndicators(): void {
    for (let i = 0; i < BUFFER_COUNT; i++) {
      this.toolbar.setBufferHasContent(i, this.buffers[i]?.trim().length > 0)
    }
  }

  private switchBuffer(index: number): void {
    this.buffers[this.activeBuffer] = this.editor.getValue()
    this.activeBuffer = index
    this.editor.setValue(this.buffers[index])
    this.saveBuffers()
    this.updateBufferIndicators()

    const title = document.getElementById('spw-buffer-title')
    if (title) title.textContent = `Buffer ${index}`
  }

  /**
   * Initialise the audio engine if not already initialised. Idempotent.
   * Used both by handlePlay (which then evaluates the editor buffer) and by
   * the sample-browser preview, which wants engine without disturbing the
   * editor buffer's run state.
   */
  private async ensureEngineInitialised(): Promise<boolean> {
    if (this.engine) return true
    try {
      this.toolbar.setLoading(true)
      const t0 = performance.now()
      this.console.logSystem('  Initialising audio engine...')

      let SuperSonicClass: unknown = undefined
      try {
        this.console.logSystem('  Loading SuperSonic WASM runtime...')
        // CDN dependency. dynamic import() does not support SRI.
        // See src/engine/cdn-manifest.ts for the full dependency manifest.
        // @ts-ignore — CDN URL
        const mod = await import(/* @vite-ignore */ 'https://unpkg.com/supersonic-scsynth@0.57.0')
        SuperSonicClass = mod.SuperSonic ?? mod.default
        this.console.logSystem('  WASM runtime loaded.')
      } catch {
        this.console.logSystem('  SuperSonic CDN unavailable.')
        this.console.logSystem('  Running without audio (events will still log).')
      }

      const savedPrefs = this.getPrefs()
      this.engine = new SonicPiEngine({
        bridge: SuperSonicClass ? { SuperSonicClass: SuperSonicClass as never } : {},
        schedAheadTime: typeof savedPrefs.schedAheadTime === 'number' ? savedPrefs.schedAheadTime as number : undefined,
      })

      this.engine.setRuntimeErrorHandler((err) => {
        const fe = friendlyError(err)
        this.console.logError(fe.title, fe.message)
        if (fe.line) this.editor.highlightErrorLine(fe.line)
        // Privacy: only the error class + browser. No message, no code.
        track(EVENTS.RuntimeError, { error: errorClass(err), browser: detectBrowserFamily() })
      })

      this.engine.setPrintHandler((msg) => {
        this.console.log(msg, 'info')
      })

      this.engine.setCueHandler((name, time) => {
        this.cueLog.logCue(name, this.cueLog.currentRun, time * 1000)
      })

      this.engine.setLoadExampleHandler((example) => {
        // Forward `load_example :name` calls in user code to the editor's
        // existing load-example flow (#236). Replaces buffer + auto-runs
        // when already playing — same shape as the dropdown selection.
        void this.loadExample(example)
      })

      this.console.logSystem('  Loading synthdefs + initialising scsynth...')
      try {
        await this.engine.init()
      } catch (initErr) {
        this.console.logError('Engine init failed', String(initErr))
        this.toolbar.setLoading(false)
        this.engine = null
        track(EVENTS.EngineInitFailed, { browser: detectBrowserFamily(), error: errorClass(initErr) })
        return false
      }
      // Apply saved volume from prefs
      if (typeof savedPrefs.masterVolume === 'number') {
        this.engine.setVolume((savedPrefs.masterVolume as number) / 100)
      }
      // Apply saved mixer params (calls /n_set on the live mixer node).
      // Order matters: pre_amp first so its baseline is in place before
      // setVolume's pre_amp recompute reads it (setVolume above already
      // ran but the bridge's own field default matched, so no-op).
      if (typeof savedPrefs.mixerPreAmp === 'number') {
        this.engine.setMixerPreAmp(savedPrefs.mixerPreAmp as number)
      }
      if (typeof savedPrefs.mixerAmp === 'number') {
        this.engine.setMixerAmp(savedPrefs.mixerAmp as number)
      }
      await this.sessionLog.initSigning()
      // Expose engine for diagnostics (thread monitor, metrics)
      ;(globalThis as Record<string, unknown>).__spw_engine = this.engine

      // Log audio latency info (#6)
      const audioInfo = this.engine.components.audio
      if (audioInfo?.audioCtx) {
        const ctx = audioInfo.audioCtx as AudioContext & { baseLatency?: number; outputLatency?: number }
        const base = (ctx.baseLatency ?? 0) * 1000
        const output = (ctx.outputLatency ?? 0) * 1000
        this.console.logSystem(`  Audio latency: ${base.toFixed(1)}ms base + ${output.toFixed(1)}ms output = ${(base + output).toFixed(1)}ms`)
      }

      // Wire custom sample uploader to the engine and load samples from IndexedDB
      if (this.menuBar) {
        this.menuBar.sampleUploader.setEngine(this.engine)
      }
      const customCount = await this.engine.loadCustomSamplesFromDB()
      if (customCount > 0) {
        this.console.logSystem(`  Loaded ${customCount} custom sample${customCount > 1 ? 's' : ''} from storage.`)
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
      this.toolbar.setLoading(false)
      this.console.logSystem(`  Audio engine ready. (${elapsed}s)`)
      this.console.logSystem('  Session logging active. Ctrl+Shift+S to export.')
      this.console.logSystem('')
      return true
    } catch (err) {
      this.toolbar.setLoading(false)
      const error = err instanceof Error ? err : new Error(String(err))
      const fe = friendlyError(error)
      this.console.logError(fe.title, fe.message)
      return false
    }
  }

  private async handlePlay(): Promise<void> {
    try {
      const ready = await this.ensureEngineInitialised()
      if (!ready || !this.engine) return

      const code = this.editor.getValue()
      this.console.newRun()
      this.cueLog.newRun()
      this.editor.highlightErrorLine(null) // clear previous errors

      const result = await this.engine.evaluate(code)
      if (result.error) {
        const fe = friendlyError(result.error)
        this.console.logError(fe.title, fe.message)
        if (fe.line) this.editor.highlightErrorLine(fe.line)
        return
      }

      this.engine.play()
      this.playing = true
      this.toolbar.setPlaying(true)
      track(EVENTS.RunCode, { browser: detectBrowserFamily() })
      await this.sessionLog.logRun(code)

      // Connect scope
      const audio = this.engine.components.audio
      if (audio) {
        this.scope.connect(audio.analyser, audio.analyserL, audio.analyserR)
      }

      // Wire event stream for console logging
      const streaming = this.engine.components.streaming
      if (streaming && !this.eventStreamHandler) {
        this.eventStreamHandler = ((event: { s: string | null; midiNote: number | null; audioTime?: number }) => {
          const s = event.s ?? '?'
          const note = event.midiNote != null ? ` note:${event.midiNote}` : ''
          this.console.logEvent('synth', `${s}${note}`, event.audioTime)
        }) as (event: unknown) => void
        streaming.eventStream.on(this.eventStreamHandler as never)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const fe = friendlyError(error)
      this.console.logError(fe.title, fe.message)
    }
  }

  private handleStop(): void {
    if (!this.engine || !this.playing) return
    this.engine.stop()
    this.playing = false
    this.toolbar.setPlaying(false)
    this.scope.disconnect()
    this.sessionLog.logStop()
    this.console.logSystem('')
    this.console.logSystem('  Stopping all runs...')
    this.console.logSystem('')
  }

  private async handleRecord(): Promise<void> {
    if (this.isRecording) {
      // Stop recording and download
      if (this.recorder) {
        this.console.logSystem('  Saving recording...')
        try {
          await this.recorder.stopAndDownload()
          this.console.logSystem('  Recording saved!')
          track(EVENTS.RecordingSaved)
        } catch (err) {
          this.console.logError('Recording failed', String(err))
        }
      }
      this.isRecording = false
      this.toolbar.setRecording(false)
      return
    }

    // Start recording
    const audio = this.engine?.components.audio
    if (!audio) {
      this.console.logError('Cannot record', 'No audio engine available. Press Run first.')
      return
    }

    this.recorder = new Recorder(audio.audioCtx, audio.analyser)
    this.recorder.start()
    this.isRecording = true
    this.toolbar.setRecording(true)
    this.console.logSystem('  Recording... Press Rec again to save.')
  }

  private async loadExample(example: Example): Promise<void> {
    this.editor.setValue(example.ruby)
    this.buffers[this.activeBuffer] = example.ruby
    this.saveBuffers()
    this.sessionLog.logLoadExample(example.name, example.ruby)
    this.console.logSystem(`  Loaded: ${example.name} — ${example.description}`)
    // Built-in example names are bounded (~18) — safe / useful as a prop:
    // tells us which examples actually get tried.
    track(EVENTS.ExampleLoaded, { name: example.name })
    // Always replay so the DSL `load_example "..."` works on first run.
    // The previous `if (this.playing)` guard raced with handlePlay setting
    // playing=true AFTER `await evaluate` returned — meaning the DSL handler
    // (fire-and-forget from inside evaluate) saw playing=false and skipped.
    //
    // The setTimeout yield is mandatory: when triggered from the DSL, we are
    // synchronously inside the outer evaluate. engine.evaluate is not
    // reentrant — we must let the outer call finish before recursing into
    // handlePlay. The drain delay also lets pre-scheduled audio in the
    // lookahead buffer flush so scsynth doesn't play the tail of the old run.
    if (this.engine && this.playing) {
      const drainMs = this.engine.schedAhead * 1000 + 50
      this.engine.stop()
      await new Promise(r => setTimeout(r, drainMs))
    } else {
      await new Promise(r => setTimeout(r, 0))
    }
    await this.handlePlay()
  }

  private async handleSave(): Promise<void> {
    const code = this.editor.getValue()
    const name = `buffer_${this.activeBuffer}.rb`

    // Modern File System Access API
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Sonic Pi', accept: { 'text/x-ruby': ['.rb'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(code)
        await writable.close()
        this.console.logSystem('  File saved.')
        return
      } catch { /* user cancelled or API unavailable */ }
    }

    // Fallback: download link
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
    this.console.logSystem('  File downloaded.')
  }

  private handleLoad(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.rb,.txt,.spi'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      this.editor.setValue(text)
      this.saveBuffers()
      this.console.logSystem(`  Loaded: ${file.name}`)
    }
    input.click()
  }

  private async handleShare(): Promise<void> {
    const url = buildShareURL(this.editor.getValue())
    let copied = false
    try {
      await navigator.clipboard.writeText(url)
      copied = true
    } catch {
      // Clipboard blocked (insecure context / permission). Fall back to a
      // prompt so the link is still recoverable — never silently fail.
      try { window.prompt('Copy this share link:', url) } catch { /* headless */ }
    }
    this.console.logSystem(copied ? '  Share link copied to clipboard.' : '  Share link ready.')
    this.flashToast(copied ? 'Share link copied' : 'Share link ready')
  }

  /** Transient bottom-center toast — feedback when the Console panel is hidden. */
  private flashToast(msg: string): void {
    const el = document.createElement('div')
    el.textContent = msg
    el.style.cssText = `
      position: fixed; left: 50%; bottom: 2.5rem; transform: translateX(-50%);
      background: ${theme.bgDark}; color: ${theme.fg};
      border: 1px solid ${theme.comment}; border-radius: 6px;
      padding: 0.5rem 1rem; font-size: 0.8rem; font-family: inherit;
      z-index: 99999; pointer-events: none; opacity: 0;
      transition: opacity 0.15s;
    `
    this.root.appendChild(el)
    requestAnimationFrame(() => { el.style.opacity = '1' })
    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 200)
    }, 1800)
  }

  private toggleZen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      this.root.requestFullscreen().catch(() => {
        // Fullscreen not supported or denied
      })
    }
  }

  private async exportSession(): Promise<void> {
    if (this.sessionLog.length === 0) {
      this.console.logSystem('  No session to export.')
      return
    }
    await this.sessionLog.exportAndDownload()
    this.console.logSystem('  Session log exported.')
  }

  private togglePanel(panel: string, visible: boolean): void {
    this.panelVisibility[panel] = visible
    try { localStorage.setItem('spw-panel-visibility', JSON.stringify(this.panelVisibility)) } catch { /* ignore */ }
    this.applyPanelVisibility()
  }

  private applyPanelVisibility(): void {
    const scope = this.root.querySelector('.spw-scope') as HTMLElement
    const splitter = this.root.querySelector('.spw-scope-splitter') as HTMLElement
    const consoleEl = this.root.querySelector('.spw-console') as HTMLElement
    const cueLogEl = this.root.querySelector('.spw-cuelog') as HTMLElement
    const cueLogSplitter = this.root.querySelector('.spw-cuelog-splitter') as HTMLElement

    const scopeVisible = this.panelVisibility.scope !== false
    if (scope) scope.style.display = scopeVisible ? 'flex' : 'none'
    if (splitter) splitter.style.display = scopeVisible ? '' : 'none'
    if (consoleEl) consoleEl.style.display = this.panelVisibility.log !== false ? '' : 'none'
    const cueLogVisible = this.panelVisibility.cueLog !== false
    if (cueLogEl) cueLogEl.style.display = cueLogVisible ? '' : 'none'
    if (cueLogSplitter) cueLogSplitter.style.display = cueLogVisible ? '' : 'none'

    // Toolbar rows
    this.toolbar.setButtonsVisible(this.panelVisibility.buttons !== false)
    this.toolbar.setTabsVisible(this.panelVisibility.tabs !== false)

    // Rebuild scope canvases after layout change
    if (scopeVisible) {
      requestAnimationFrame(() => this.scope?.rebuildCanvases?.())
    }
  }

  // ---------------------------------------------------------------------------
  // MIDI device management
  // ---------------------------------------------------------------------------

  private async getMidiDevices(): Promise<MidiDeviceInfo[]> {
    // The MidiBridge is owned by the engine, so the engine must exist first.
    // Auto-init matches the sample-preview UX — the user shouldn't have to
    // hit Run before being allowed to enumerate MIDI devices.
    const ready = await this.ensureEngineInitialised()
    if (!ready || !this.engine) return []
    // Lazy-init on first dropdown open. Await the init() promise so the
    // caller (Toolbar) sees a fully-enumerated list on the first call —
    // not an empty array that requires a second open to populate.
    // Firefox especially: requestMIDIAccess() shows a permission prompt
    // here; awaiting means we render only after the user has decided.
    if (!this.midiInitialized) {
      const ok = await this.engine.midiBridge.init()
      this.midiInitialized = ok
      if (!ok) return []
    }
    const devices = this.engine.midiBridge.getDevices()
    return devices.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      selected: d.type === 'input'
        ? this.selectedMidiInputs.has(d.id)
        : this.selectedMidiOutputs.has(d.id),
    }))
  }

  private toggleMidiDevice(deviceId: string, type: 'input' | 'output', selected: boolean): void {
    if (!this.engine) return
    const bridge = this.engine.midiBridge
    if (type === 'input') {
      if (selected) {
        bridge.selectInput(deviceId)
        this.selectedMidiInputs.add(deviceId)
      } else {
        bridge.deselectInput(deviceId)
        this.selectedMidiInputs.delete(deviceId)
      }
    } else {
      if (selected) {
        bridge.selectOutput(deviceId)
        this.selectedMidiOutputs.add(deviceId)
      } else {
        bridge.deselectOutput(deviceId)
        this.selectedMidiOutputs.delete(deviceId)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sample browser
  // ---------------------------------------------------------------------------

  private openSampleBrowser(): void {
    if (this.sampleBrowser?.isOpen) {
      this.sampleBrowser.close()
      return
    }
    this.sampleBrowser = new SampleBrowser({
      onPreviewSample: (name) => this.previewSample(name),
      onStopPreview: () => this.stopPreview(),
      onInsertText: (text) => {
        this.editor.insertAtCursor(text)
      },
    })
    this.sampleBrowser.open()
  }

  private async previewSample(name: string): Promise<void> {
    try {
      const ready = await this.ensureEngineInitialised()
      if (!ready || !this.engine) return

      // SP80 (commit 57241c6) short-circuits evaluate() when the source code
      // is byte-identical to the prior run — designed for "no-op Update" but
      // it also turns the second click of the same preview button into a
      // silent no-op. The unique marker comment makes every preview a fresh
      // distinct string.
      // The 5x repeat is a UX choice — users want to audition the loop /
      // groove of a sample, not just hear it once. sample_duration falls back
      // to 1s if scsynth hasn't reported the buffer length yet (cold-start).
      const code = [
        `# preview_${Date.now()}`,
        `5.times do`,
        `  sample :${name}`,
        `  d = sample_duration(:${name})`,
        `  sleep (d > 0 ? d : 1)`,
        `end`,
      ].join('\n')
      const result = await this.engine.evaluate(code)
      if (result.error) {
        this.console.logError('Preview failed', result.error.message)
        return
      }
      this.engine.play()
      // Mark as playing so subsequent Stop is wired correctly.
      if (!this.playing) {
        this.playing = true
        this.toolbar.setPlaying(true)
      }
      track(EVENTS.SamplePreview)
    } catch (err) {
      this.console.logError('Preview failed', String(err))
    }
  }

  private stopPreview(): void {
    // Sample-browser pause click. Reuse handleStop so the toolbar/scope state
    // stays in sync with engine state.
    if (this.engine && this.playing) this.handleStop()
  }

  dispose(): void {
    this.handleStop()
    this.sampleBrowser?.dispose()
    this.engine?.dispose()
    this.editor.dispose()
    this.helpPanel.dispose()
    this.scope.dispose()
    this.console.dispose()
    this.cueLog.dispose()
    this.toolbar.dispose()
    this.menuBar?.dispose()
  }
}
