/**
 * Toolbar — Sonic Pi-style toolbar with Run/Stop, buffer tabs, volume.
 */

import { examples, getExamplesByDifficulty, type Example } from '../engine/examples'
import { theme } from './theme'
import { createLogo } from './Logo'
import { track, EVENTS } from './Analytics'

export interface MidiDeviceInfo {
  id: string
  name: string
  type: 'input' | 'output'
  selected: boolean
}

export interface ToolbarCallbacks {
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onExample: (example: Example) => void
  onBufferSelect: (index: number) => void
  onVolumeChange: (vol: number) => void
  onMidiDeviceToggle?: (deviceId: string, type: 'input' | 'output', selected: boolean) => void
  getMidiDevices?: () => Promise<MidiDeviceInfo[]> | MidiDeviceInfo[]
  onOpenSampleBrowser?: () => void
  onFontSizeChange?: (delta: number) => void
  onSave?: () => void
  onLoad?: () => void
  onZen?: () => void
}

const BUFFER_COUNT = 10

export class Toolbar {
  private el: HTMLElement
  private topRow!: HTMLElement
  private bufRow!: HTMLElement
  private playBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private recBtn: HTMLButtonElement
  private bufferBtns: HTMLButtonElement[] = []
  private activeBuffer = 0
  private playing = false
  private recording = false
  private midiDropdown: HTMLElement | null = null
  private midiOutsideClickHandler: ((e: MouseEvent) => void) | null = null

  constructor(container: HTMLElement, private callbacks: ToolbarCallbacks) {
    this.el = document.createElement('div')
    this.el.className = 'spw-toolbar'
    container.appendChild(this.el)

    // Top row: main controls
    this.topRow = this.createRow()
    const topRow = this.topRow
    topRow.style.borderBottom = `1px solid ${theme.border}`

    // Logo \u2014 shared with Preloader via createLogo() so both stay in sync.
    const logo = createLogo()
    logo.style.marginRight = '1rem'
    topRow.appendChild(logo)

    // Separator
    topRow.appendChild(this.separator())

    // Run button
    this.playBtn = this.iconButton(
      '\u25B6', 'Run',
      () => this.callbacks.onPlay(),
      { bg: '#FF1493', hover: '#FF47A8' }
    )
    this.playBtn.title = 'Run (Ctrl+Enter)'
    topRow.appendChild(this.playBtn)

    // Stop button
    this.stopBtn = this.iconButton(
      '\u25A0', 'Stop',
      () => this.callbacks.onStop(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    this.stopBtn.title = 'Stop (Esc)'
    this.stopBtn.style.opacity = '0.4'
    topRow.appendChild(this.stopBtn)

    // Record button
    this.recBtn = this.iconButton(
      '\u23FA', 'Rec',
      () => this.callbacks.onRecord(),
      { bg: '#4c83ff', hover: '#6b9bff' }
    )
    this.recBtn.title = 'Record to WAV'
    topRow.appendChild(this.recBtn)

    topRow.appendChild(this.separator())

    // Save button
    const saveBtn = this.iconButton(
      '\u{1F4BE}', 'Save',
      () => this.callbacks.onSave?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    saveBtn.title = 'Save buffer to file'
    saveBtn.style.opacity = '0.7'
    topRow.appendChild(saveBtn)

    // Load button
    const loadBtn = this.iconButton(
      '\u{1F4C2}', 'Load',
      () => this.callbacks.onLoad?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    loadBtn.title = 'Load file into buffer'
    loadBtn.style.opacity = '0.7'
    topRow.appendChild(loadBtn)

    topRow.appendChild(this.separator())

    // Volume
    const volWrap = document.createElement('div')
    volWrap.style.cssText = 'display: flex; align-items: center; gap: 0.3rem;'
    const volIcon = document.createElement('span')
    volIcon.textContent = '\u{1F50A}'
    volIcon.style.cssText = 'font-size: 0.7rem; color: ${theme.fgMuted};'
    const volSlider = document.createElement('input')
    volSlider.type = 'range'
    volSlider.min = '0'
    volSlider.max = '100'
    volSlider.value = '80'
    volSlider.style.cssText = `
      width: 70px; height: 3px; accent-color: ${theme.accent};
      cursor: pointer;
    `
    volSlider.addEventListener('input', () => {
      this.callbacks.onVolumeChange(parseInt(volSlider.value) / 100)
    })
    volWrap.append(volIcon, volSlider)
    topRow.appendChild(volWrap)

    topRow.appendChild(this.separator())

    // Font size buttons
    const fontWrap = document.createElement('div')
    fontWrap.style.cssText = 'display: flex; align-items: center; gap: 0.15rem;'
    const fontDown = document.createElement('button')
    fontDown.textContent = 'A\u2212'
    fontDown.title = 'Decrease font size'
    fontDown.style.cssText = `
      padding: 0.2rem 0.4rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-family: inherit; font-size: 0.65rem; cursor: pointer;
      transition: background 0.15s;
    `
    fontDown.addEventListener('mouseenter', () => { fontDown.style.background = theme.borderHover })
    fontDown.addEventListener('mouseleave', () => { fontDown.style.background = theme.border })
    fontDown.addEventListener('click', () => this.callbacks.onFontSizeChange?.(-1))
    const fontUp = document.createElement('button')
    fontUp.textContent = 'A+'
    fontUp.title = 'Increase font size'
    fontUp.style.cssText = `
      padding: 0.2rem 0.4rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-family: inherit; font-size: 0.65rem; cursor: pointer;
      transition: background 0.15s;
    `
    fontUp.addEventListener('mouseenter', () => { fontUp.style.background = theme.borderHover })
    fontUp.addEventListener('mouseleave', () => { fontUp.style.background = theme.border })
    fontUp.addEventListener('click', () => this.callbacks.onFontSizeChange?.(1))
    fontWrap.append(fontDown, fontUp)
    topRow.appendChild(fontWrap)

    topRow.appendChild(this.separator())

    // MIDI button — Chromium-family browsers only. Firefox / Safari either
    // lack Web MIDI entirely or enumerate zero devices in practice (their
    // requestMIDIAccess implementation differs from Chrome's). Disabling at
    // the button level avoids the confusing "No MIDI devices found"
    // dropdown and points the user at a browser that works.
    const ua = navigator.userAgent
    const isChromiumFamily = /Chrome\//.test(ua) && !/Firefox\//.test(ua)
    const midiBtn = this.iconButton(
      '\u{1F3B9}', 'MIDI',
      () => {
        // Track every click — including the disabled-state click on
        // non-Chromium so we can size how many users hit the limitation.
        track(EVENTS.MidiOpened, { supported: isChromiumFamily ? 'chromium' : 'unsupported' })
        if (isChromiumFamily) this.toggleMidiDropdown(midiBtn)
      },
      { bg: theme.comment, hover: theme.fgMuted }
    )
    if (isChromiumFamily) {
      midiBtn.title = 'MIDI Devices'
      midiBtn.style.opacity = '0.7'
    } else {
      midiBtn.title = 'MIDI is unsupported in this browser. Try Chrome, Edge, Brave, or Opera.'
      midiBtn.style.opacity = '0.35'
      midiBtn.style.cursor = 'not-allowed'
      // Intentionally NOT setting `disabled = true` — a disabled button
      // doesn't fire click events, and we want analytics on the
      // unsupported-state click so we can size how often users hit it.
      // The click handler short-circuits the dropdown when unsupported;
      // visual cues (cursor, opacity) communicate the disabled state.
    }
    // MIDI button hidden until Tier D ships (midi_pc, midi_raw, midi_sysex,
    // current_midi_*, device picker UI). Construction kept above so analytics
    // wiring and dropdown method survive; re-enable by uncommenting below.
    // topRow.appendChild(midiBtn)
    void midiBtn

    // Samples button
    const samplesBtn = this.iconButton(
      '\u{1F3B5}', 'Samples',
      () => this.callbacks.onOpenSampleBrowser?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    samplesBtn.title = 'Browse Samples'
    samplesBtn.style.opacity = '0.7'
    topRow.appendChild(samplesBtn)

    topRow.appendChild(this.separator())

    // Spacer
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    topRow.appendChild(spacer)

    // Example selector
    const select = document.createElement('select')
    select.style.cssText = `
      background: ${theme.border};
      color: ${theme.fgDark};
      border: 1px solid ${theme.borderHover};
      border-radius: 4px;
      padding: 0.25rem 0.5rem;
      font-family: inherit;
      font-size: 0.7rem;
      cursor: pointer;
      outline: none;
    `
    const defaultOpt = document.createElement('option')
    defaultOpt.textContent = 'Load Example...'
    defaultOpt.value = ''
    select.appendChild(defaultOpt)

    const grouped = getExamplesByDifficulty()
    for (const [level, exs] of Object.entries(grouped)) {
      if (exs.length === 0) continue
      const group = document.createElement('optgroup')
      group.label = level.charAt(0).toUpperCase() + level.slice(1)
      for (const ex of exs) {
        const opt = document.createElement('option')
        opt.value = ex.name
        opt.textContent = ex.name
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    select.addEventListener('change', () => {
      const ex = examples.find(e => e.name === select.value)
      if (ex) {
        this.callbacks.onExample(ex)
        select.value = ''
      }
    })
    topRow.appendChild(select)

    // Zen / fullscreen button
    const zenBtn = document.createElement('button')
    zenBtn.textContent = '\u26F6'
    zenBtn.title = 'Fullscreen / Zen mode (F11)'
    zenBtn.style.cssText = `
      padding: 0.2rem 0.5rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-size: 0.85rem; cursor: pointer;
      transition: background 0.15s;
      margin-left: 0.3rem;
    `
    zenBtn.addEventListener('mouseenter', () => { zenBtn.style.background = theme.borderHover })
    zenBtn.addEventListener('mouseleave', () => { zenBtn.style.background = theme.border })
    zenBtn.addEventListener('click', () => this.callbacks.onZen?.())
    topRow.appendChild(zenBtn)

    // Bottom row: buffer tabs
    this.bufRow = this.createRow()
    const bufRow = this.bufRow
    bufRow.style.padding = '0 0.75rem'
    bufRow.style.gap = '0'

    for (let i = 0; i < BUFFER_COUNT; i++) {
      const btn = document.createElement('button')
      btn.textContent = `${i}`
      btn.title = `Buffer ${i}`
      btn.style.cssText = `
        padding: 0.3rem 0.65rem;
        min-height: 2rem;
        border: none;
        background: transparent;
        color: ${i === 0 ? theme.accent : theme.comment};
        font-family: inherit;
        font-size: 0.7rem;
        font-weight: ${i === 0 ? '700' : '400'};
        cursor: pointer;
        border-bottom: 2px solid ${i === 0 ? theme.accent : 'transparent'};
        transition: color 0.15s, border-color 0.15s;
      `
      btn.addEventListener('click', () => this.selectBuffer(i))
      btn.addEventListener('mouseenter', () => {
        if (i !== this.activeBuffer) btn.style.color = theme.fgDark
      })
      btn.addEventListener('mouseleave', () => {
        if (i !== this.activeBuffer) btn.style.color = theme.comment
      })
      bufRow.appendChild(btn)
      this.bufferBtns.push(btn)
    }

    // Shortcut hints (right side of buffer row)
    const hintSpacer = document.createElement('span')
    hintSpacer.style.flex = '1'
    bufRow.appendChild(hintSpacer)
    const hints = document.createElement('span')
    hints.style.cssText = `color: ${theme.fgFaint}; font-size: 0.6rem; white-space: nowrap;`
    hints.textContent = 'Ctrl+Enter Run  |  Esc Stop  |  Ctrl+/ Comment'
    bufRow.appendChild(hints)
  }

  setPlaying(playing: boolean): void {
    this.playing = playing
    this.playBtn.style.background = '#FF1493'
    // Label stays "Run" always — matches Desktop Sonic Pi. Re-clicking Run
    // while playing hot-swaps live_loops (engine.evaluate handles it).
    const label = this.playBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = 'Run'
    this.stopBtn.style.opacity = playing ? '1' : '0.4'
    if (!playing) this.setRecording(false)
  }

  setLoading(loading: boolean): void {
    const label = this.playBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = loading ? 'Loading...' : 'Run'
    this.playBtn.style.opacity = loading ? '0.6' : '1'
  }

  /** Show a dot indicator on buffers that have content. */
  setBufferHasContent(index: number, hasContent: boolean): void {
    const btn = this.bufferBtns[index]
    if (!btn) return
    const dot = hasContent ? '\u00B7' : ''  // middle dot
    const num = `${index}`
    btn.textContent = hasContent ? `${num}${dot}` : num
  }

  setRecording(recording: boolean): void {
    this.recording = recording
    // Recording-state uses pure red (Desktop SP dt_warning convention)
    // so it reads unambiguously as "recording" rather than salmon/orange.
    this.recBtn.style.background = recording ? '#FF0000' : '#4c83ff'
    const label = this.recBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = recording ? 'Save' : 'Rec'
  }

  private selectBuffer(index: number): void {
    this.bufferBtns[this.activeBuffer].style.color = theme.comment
    this.bufferBtns[this.activeBuffer].style.fontWeight = '400'
    this.bufferBtns[this.activeBuffer].style.borderBottomColor = 'transparent'

    this.activeBuffer = index
    this.bufferBtns[index].style.color = theme.accent
    this.bufferBtns[index].style.fontWeight = '700'
    this.bufferBtns[index].style.borderBottomColor = theme.accent

    this.callbacks.onBufferSelect(index)
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.75rem;
    `
    this.el.appendChild(row)
    return row
  }

  private separator(): HTMLElement {
    const sep = document.createElement('div')
    sep.style.cssText = `
      width: 1px; height: 20px;
      background: ${theme.border};
      margin: 0 0.25rem;
    `
    return sep
  }

  private iconButton(
    icon: string,
    label: string,
    onClick: () => void,
    colors: { bg: string; hover: string }
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.style.cssText = `
      display: flex; align-items: center; gap: 0.35rem;
      padding: 0.3rem 0.75rem;
      min-height: 2.2rem;
      border: none;
      border-radius: 5px;
      background: ${colors.bg};
      color: ${theme.fg};
      font-family: inherit;
      font-size: 0.75rem;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      user-select: none;
    `
    const iconEl = document.createElement('span')
    iconEl.textContent = icon
    iconEl.style.fontSize = '0.6rem'
    const labelEl = document.createElement('span')
    labelEl.className = 'spw-btn-label'
    labelEl.textContent = label
    btn.append(iconEl, labelEl)

    btn.addEventListener('mouseenter', () => { btn.style.background = colors.hover })
    btn.addEventListener('mouseleave', () => { btn.style.background = colors.bg })
    btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.96)' })
    btn.addEventListener('mouseup', () => { btn.style.transform = '' })
    btn.addEventListener('click', onClick)
    return btn
  }

  private toggleMidiDropdown(anchor: HTMLElement): void {
    if (this.midiDropdown) {
      this.closeMidiDropdown()
      return
    }

    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 220px;
      max-height: 320px;
      overflow-y: auto;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    const rect = anchor.getBoundingClientRect()
    dropdown.style.left = `${rect.left}px`
    dropdown.style.top = `${rect.bottom + 4}px`

    document.body.appendChild(dropdown)
    this.midiDropdown = dropdown
    // Async — populates with "Loading…" then real devices once permission
    // is granted. Must run AFTER setting this.midiDropdown so the staleness
    // guard inside buildMidiDropdownContent sees the right reference.
    void this.buildMidiDropdownContent(dropdown)

    // Close on outside click
    this.midiOutsideClickHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeMidiDropdown()
      }
    }
    setTimeout(() => {
      document.addEventListener('click', this.midiOutsideClickHandler!)
    }, 0)
  }

  private closeMidiDropdown(): void {
    if (this.midiOutsideClickHandler) {
      document.removeEventListener('click', this.midiOutsideClickHandler)
      this.midiOutsideClickHandler = null
    }
    if (this.midiDropdown) {
      this.midiDropdown.remove()
      this.midiDropdown = null
    }
  }

  private async buildMidiDropdownContent(dropdown: HTMLElement): Promise<void> {
    dropdown.innerHTML = ''

    // Check for Web MIDI support BEFORE asking the host. In Firefox stock the
    // pref is enabled but the implementation may not enumerate devices that
    // Chrome would — we still want to show the more accurate "not supported"
    // message when the API isn't there at all.
    if (!navigator.requestMIDIAccess) {
      this.addMidiMessage(dropdown, 'MIDI not supported in this browser')
      return
    }

    const getMidiDevices = this.callbacks.getMidiDevices
    if (!getMidiDevices) {
      this.addMidiMessage(dropdown, 'MIDI not available')
      return
    }

    // Render a loading state while requestMIDIAccess prompts for permission
    // (the FIRST call awaits the user's grant). Without this we'd show the
    // stale "no devices" text and the user would never know permission was
    // pending or that init was async. Firefox especially: the prompt is the
    // sole signal that anything happened.
    this.addMidiMessage(dropdown, 'Loading MIDI devices…')

    let devices: MidiDeviceInfo[] = []
    try {
      const result = getMidiDevices()
      devices = result instanceof Promise ? await result : result
    } catch {
      devices = []
    }

    // The dropdown may have been closed during the await (user clicked away,
    // pressed Esc, or opened a different one). Bail out — the next open will
    // re-render fresh.
    if (this.midiDropdown !== dropdown || !dropdown.isConnected) return

    dropdown.innerHTML = ''

    if (devices.length === 0) {
      this.addMidiMessage(dropdown, 'No MIDI devices found')
      return
    }

    const inputs = devices.filter(d => d.type === 'input')
    const outputs = devices.filter(d => d.type === 'output')

    if (inputs.length > 0) {
      this.addMidiSectionHeader(dropdown, 'Inputs')
      for (const dev of inputs) {
        this.addMidiDeviceRow(dropdown, dev)
      }
    }

    if (outputs.length > 0) {
      if (inputs.length > 0) {
        const sep = document.createElement('div')
        sep.style.cssText = `height: 1px; background: ${theme.border}; margin: 0.3rem 0;`
        dropdown.appendChild(sep)
      }
      this.addMidiSectionHeader(dropdown, 'Outputs')
      for (const dev of outputs) {
        this.addMidiDeviceRow(dropdown, dev)
      }
    }
  }

  private addMidiMessage(container: HTMLElement, text: string): void {
    const msg = document.createElement('div')
    msg.textContent = text
    msg.style.cssText = `
      padding: 0.8rem;
      text-align: center;
      color: ${theme.fgFaint};
      font-size: 0.7rem;
    `
    container.appendChild(msg)
  }

  private addMidiSectionHeader(container: HTMLElement, text: string): void {
    const header = document.createElement('div')
    header.textContent = text
    header.style.cssText = `
      padding: 0.3rem 0.8rem 0.2rem;
      font-size: 0.55rem;
      color: ${theme.fgFaint};
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    container.appendChild(header)
  }

  private addMidiDeviceRow(container: HTMLElement, device: MidiDeviceInfo): void {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      padding: 0.3rem 0.8rem;
      cursor: pointer;
      font-size: 0.7rem;
      color: ${theme.fg};
      gap: 0.5rem;
      transition: background 0.1s;
      user-select: none;
    `
    row.addEventListener('mouseenter', () => {
      row.style.background = theme.border
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = 'none'
    })

    // Checkbox
    const check = document.createElement('span')
    check.style.cssText = `
      width: 14px; height: 14px;
      border: 1px solid ${device.selected ? theme.accent : theme.borderStrong};
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.6rem;
      flex-shrink: 0;
      background: ${device.selected ? theme.accent : 'none'};
      color: ${device.selected ? theme.fg : 'transparent'};
      transition: all 0.15s;
    `
    check.textContent = device.selected ? '\u2713' : ''

    const label = document.createElement('span')
    label.textContent = device.name
    label.style.cssText = `
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `

    row.append(check, label)
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const newSelected = !device.selected
      this.callbacks.onMidiDeviceToggle?.(device.id, device.type, newSelected)
      // Rebuild content in place
      if (this.midiDropdown) {
        this.buildMidiDropdownContent(this.midiDropdown)
      }
    })

    container.appendChild(row)
  }

  setButtonsVisible(visible: boolean): void {
    this.topRow.style.display = visible ? 'flex' : 'none'
  }

  setTabsVisible(visible: boolean): void {
    this.bufRow.style.display = visible ? 'flex' : 'none'
  }

  dispose(): void {
    this.closeMidiDropdown()
    this.el.remove()
  }
}
