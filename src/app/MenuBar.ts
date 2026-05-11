/**
 * MenuBar — Desktop Sonic Pi-style menu bar with Visuals tab.
 *
 * Provides dropdown menus for scope mode toggles and preferences,
 * matching the Desktop SP Prefs → Visuals tab experience.
 */

import { type ScopeMode, ALL_SCOPE_MODES } from './Scope'
import { SampleUploader } from './SampleUploader'
import { APP_VERSION } from './version'
import { theme } from './theme'

function detectBrowser(ua: string): string {
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
  if (ua.includes('Chrome')) return 'Chrome'
  return 'Other'
}

function detectOS(ua: string): string {
  if (ua.includes('Mac OS')) return 'macOS'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Linux')) return 'Linux'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  return ua.substring(0, 50)
}

const SCOPE_LABELS: Record<ScopeMode, string> = {
  mono: 'Mono',
  stereo: 'Stereo',
  lissajous: 'Lissajous',
  mirror: 'Mirror',
  spectrum: 'Spectrum',
}

const SCOPE_COLORS: Record<ScopeMode, string> = {
  mono: theme.accent,
  stereo: theme.cyan,
  lissajous: theme.purple,
  mirror: theme.blue,
  spectrum: theme.magenta,
}

export interface PrefsCallbacks {
  onPrefsChange?: (key: string, value: number | boolean) => void
  getPrefs?: () => Record<string, number | boolean>
}

export class MenuBar {
  private container: HTMLElement
  private onToggleScope: (mode: ScopeMode) => void
  private getActiveModes: () => Set<ScopeMode>
  private onTogglePanel: (panel: string, visible: boolean) => void
  private getPanelVisibility: () => Record<string, boolean>
  private onToggleHelp: (() => void) | null
  private isHelpVisible: (() => boolean) | null
  private activeDropdown: HTMLElement | null = null
  readonly sampleUploader: SampleUploader
  private prefsCallbacks: PrefsCallbacks
  private getReportData: (() => { code: string; engineState: string }) | null
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null

  constructor(
    parent: HTMLElement,
    options: {
      onToggleScope: (mode: ScopeMode) => void
      getActiveModes: () => Set<ScopeMode>
      onTogglePanel: (panel: string, visible: boolean) => void
      getPanelVisibility: () => Record<string, boolean>
      onLog?: (msg: string) => void
      onToggleHelp?: () => void
      isHelpVisible?: () => boolean
      prefs?: PrefsCallbacks
      getReportData?: () => { code: string; engineState: string }
    }
  ) {
    this.onToggleScope = options.onToggleScope
    this.getActiveModes = options.getActiveModes
    this.onTogglePanel = options.onTogglePanel
    this.getPanelVisibility = options.getPanelVisibility
    this.onToggleHelp = options.onToggleHelp ?? null
    this.isHelpVisible = options.isHelpVisible ?? null
    this.prefsCallbacks = options.prefs ?? {}
    this.getReportData = options.getReportData ?? null

    this.container = document.createElement('div')
    this.container.style.cssText = `
      display: flex;
      align-items: stretch;
      padding: 0;
      height: 32px;
      background: ${theme.bgDark};
      border-bottom: 2px solid ${theme.border};
      font-size: 0.72rem;
      color: ${theme.fgMuted};
      gap: 0;
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    `

    // Tab bar — prominent tabs above everything (Desktop SP style)
    this.addMenu('View', () => this.buildViewMenu())
    this.addMenu('Visuals', () => this.buildVisualsMenu())

    // Samples menu (custom sample upload)
    this.sampleUploader = new SampleUploader(
      document.createElement('div'), // placeholder parent — real parent is the dropdown
      { onLog: options.onLog },
    )
    this.addMenu('Samples', () => this.buildSamplesMenu())
    this.addMenu('Prefs', () => this.buildPrefsMenu())

    // Spacer pushes GitHub + Report Bug to the right
    const spacer = document.createElement('div')
    spacer.style.flex = '1'
    this.container.appendChild(spacer)

    // GitHub source link — takes the slot the version label used to occupy
    const githubBtn = document.createElement('a')
    githubBtn.href = 'https://github.com/MrityunjayBhardwaj/SonicPi.js'
    githubBtn.target = '_blank'
    githubBtn.rel = 'noopener noreferrer'
    githubBtn.title = 'View source on GitHub'
    githubBtn.setAttribute('aria-label', 'View source on GitHub')
    githubBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'
    githubBtn.style.cssText = `
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      color: ${theme.fgMuted};
      text-decoration: none;
      border-radius: 4px;
      margin-right: 0.5rem;
      align-self: center;
      transition: color 0.15s, background 0.15s;
      background: transparent;
    `
    githubBtn.addEventListener('mouseenter', () => {
      githubBtn.style.color = theme.fg
      githubBtn.style.background = theme.border
    })
    githubBtn.addEventListener('mouseleave', () => {
      githubBtn.style.color = theme.fgMuted
      githubBtn.style.background = 'transparent'
    })
    this.container.appendChild(githubBtn)

    // Report Bug button
    const bugBtn = document.createElement('button')
    bugBtn.type = 'button'
    bugBtn.textContent = 'Report Bug'
    bugBtn.style.cssText = `
      background: none; border: 1px solid ${theme.accentHover};
      color: ${theme.accent}; font-family: inherit; font-size: 0.65rem;
      padding: 0.15rem 0.6rem; cursor: pointer; border-radius: 4px;
      height: 22px; letter-spacing: 0.5px; transition: all 0.15s;
      margin-right: 0.5rem; align-self: center;
    `
    bugBtn.addEventListener('mouseenter', () => {
      bugBtn.style.background = theme.accentFaint
      bugBtn.style.borderColor = theme.accent
    })
    bugBtn.addEventListener('mouseleave', () => {
      bugBtn.style.background = 'none'
      bugBtn.style.borderColor = theme.accentHover
    })
    bugBtn.addEventListener('click', () => this.openBugReport())
    this.container.appendChild(bugBtn)

    // Close dropdown on outside click. Store the handler so dispose()
    // can remove it — otherwise the MenuBar leaks a document-level
    // listener every time it's reconstructed (hot-swap, test teardown).
    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.activeDropdown &&
          !this.container.contains(e.target as Node) &&
          !this.activeDropdown.contains(e.target as Node)) {
        this.closeDropdown()
      }
    }
    document.addEventListener('click', this.outsideClickHandler)

    parent.appendChild(this.container)
  }

  private addMenu(label: string, buildContent: () => HTMLElement): void {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = `
      background: none; border: none; color: ${theme.fgMuted};
      font-family: inherit; font-size: 0.72rem;
      padding: 0 1rem; cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
      height: 100%;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      font-weight: 500;
    `
    btn.addEventListener('mouseenter', () => {
      btn.style.color = theme.fg
      if (this.activeDropdown?.dataset.menu !== label) {
        btn.style.borderBottomColor = theme.accentHover
      }
    })
    btn.addEventListener('mouseleave', () => {
      if (this.activeDropdown?.dataset.menu !== label) {
        btn.style.borderBottomColor = 'transparent'
        btn.style.color = theme.fgMuted
      }
    })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.activeDropdown?.dataset.menu === label) {
        this.closeDropdown()
        return
      }
      this.closeDropdown()
      const dropdown = buildContent()
      dropdown.dataset.menu = label
      const rect = btn.getBoundingClientRect()
      dropdown.style.left = `${rect.left}px`
      dropdown.style.top = `${rect.bottom + 2}px`
      document.body.appendChild(dropdown)
      this.activeDropdown = dropdown
      btn.style.borderBottomColor = theme.accent
      btn.style.color = theme.fg
    })
    this.container.appendChild(btn)
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove()
      this.activeDropdown = null
      // Reset all tab button styles
      for (const btn of this.container.querySelectorAll('button')) {
        (btn as HTMLElement).style.borderBottomColor = 'transparent';
        (btn as HTMLElement).style.color = theme.fgMuted
      }
    }
  }

  private buildViewMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 180px;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    const panelItems: Array<{ key: string; label: string }> = [
      { key: 'log', label: 'Show Log' },
      { key: 'cueLog', label: 'Show Cue Log' },
      { key: 'scope', label: 'Show Scope' },
    ]

    const uiItems: Array<{ key: string; label: string }> = [
      { key: 'buttons', label: 'Show Buttons' },
      { key: 'tabs', label: 'Show Tabs' },
    ]

    const checkboxes = new Map<string, HTMLSpanElement>()

    const updateCheckboxes = () => {
      const vis = this.getPanelVisibility()
      for (const [key, check] of checkboxes) {
        const isOn = vis[key] !== false
        check.textContent = isOn ? '✓' : ''
        check.style.color = isOn ? theme.fg : 'transparent'
        check.style.background = isOn ? theme.cyan : 'none'
        check.style.borderColor = isOn ? theme.cyan : theme.borderStrong
      }
    }

    const addItem = (key: string, label: string) => {
      const vis = this.getPanelVisibility()
      const isOn = vis[key] !== false
      const item = document.createElement('div')
      item.style.cssText = `
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
      item.addEventListener('mouseenter', () => {
        item.style.background = theme.border
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? theme.cyan : theme.borderStrong};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? theme.cyan : 'none'};
        color: ${isOn ? theme.fg : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '✓' : ''
      checkboxes.set(key, check)

      const labelEl = document.createElement('span')
      labelEl.textContent = label

      item.appendChild(check)
      item.appendChild(labelEl)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        const currentVis = this.getPanelVisibility()
        const newState = !(currentVis[key] !== false)
        this.onTogglePanel(key, newState)
        updateCheckboxes()
      })

      dropdown.appendChild(item)
    }

    for (const { key, label } of panelItems) addItem(key, label)

    // Separator
    const sep = document.createElement('div')
    sep.style.cssText = `
      height: 1px;
      background: ${theme.border};
      margin: 0.3rem 0.6rem;
    `
    dropdown.appendChild(sep)

    for (const { key, label } of uiItems) addItem(key, label)

    // Separator before Help
    const sep2 = document.createElement('div')
    sep2.style.cssText = `
      height: 1px;
      background: ${theme.border};
      margin: 0.3rem 0.6rem;
    `
    dropdown.appendChild(sep2)

    // Help panel toggle
    {
      const isOn = this.isHelpVisible?.() ?? false
      const item = document.createElement('div')
      item.style.cssText = `
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
      item.addEventListener('mouseenter', () => {
        item.style.background = theme.border
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? theme.blue : theme.borderStrong};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? theme.blue : 'none'};
        color: ${isOn ? theme.fg : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '\u2713' : ''

      const labelEl = document.createElement('span')
      labelEl.textContent = 'Show Help'

      item.appendChild(check)
      item.appendChild(labelEl)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onToggleHelp?.()
        const nowOn = this.isHelpVisible?.() ?? false
        check.textContent = nowOn ? '\u2713' : ''
        check.style.color = nowOn ? theme.fg : 'transparent'
        check.style.background = nowOn ? theme.blue : 'none'
        check.style.borderColor = nowOn ? theme.blue : theme.borderStrong
      })

      dropdown.appendChild(item)
    }

    return dropdown
  }

  private buildVisualsMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 180px;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    // Section header
    const header = document.createElement('div')
    header.textContent = 'Scope Modes'
    header.style.cssText = `
      padding: 0.3rem 0.8rem 0.2rem;
      font-size: 0.55rem;
      color: ${theme.fgFaint};
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    dropdown.appendChild(header)

    // Store checkbox refs for in-place updates (no rebuild flicker)
    const checkboxes = new Map<ScopeMode, HTMLSpanElement>()

    const updateCheckboxes = () => {
      const active = this.getActiveModes()
      for (const [mode, check] of checkboxes) {
        const isOn = active.has(mode)
        check.textContent = isOn ? '✓' : ''
        check.style.color = isOn ? theme.fg : 'transparent'
        check.style.background = isOn ? SCOPE_COLORS[mode] : 'none'
        check.style.borderColor = isOn ? SCOPE_COLORS[mode] : theme.borderStrong
      }
    }

    for (const mode of ALL_SCOPE_MODES) {
      const item = document.createElement('div')
      item.style.cssText = `
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
      item.addEventListener('mouseenter', () => {
        item.style.background = theme.border
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      // Checkbox
      const check = document.createElement('span')
      const active = this.getActiveModes()
      const isOn = active.has(mode)
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? SCOPE_COLORS[mode] : theme.borderStrong};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? SCOPE_COLORS[mode] : 'none'};
        color: ${isOn ? theme.fg : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '✓' : ''
      checkboxes.set(mode, check)

      // Color dot + label
      const dot = document.createElement('span')
      dot.style.cssText = `
        width: 6px; height: 6px;
        border-radius: 50%;
        background: ${SCOPE_COLORS[mode]};
        flex-shrink: 0;
      `

      const label = document.createElement('span')
      label.textContent = SCOPE_LABELS[mode]

      item.appendChild(check)
      item.appendChild(dot)
      item.appendChild(label)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onToggleScope(mode)
        updateCheckboxes()
      })

      dropdown.appendChild(item)
    }

    return dropdown
  }

  private buildSamplesMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0.6rem;
      min-width: 220px;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    // Section header
    const header = document.createElement('div')
    header.textContent = 'Custom Samples'
    header.style.cssText = `
      padding: 0.2rem 0.2rem 0.3rem;
      font-size: 0.55rem;
      color: ${theme.fgFaint};
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    dropdown.appendChild(header)

    // Hint
    const hint = document.createElement('div')
    hint.textContent = 'Upload audio files to use as sample :user_<name>'
    hint.style.cssText = `
      font-size: 0.6rem;
      color: ${theme.fgFaint};
      padding: 0 0.2rem 0.3rem;
    `
    dropdown.appendChild(hint)

    // Re-parent the SampleUploader into this dropdown
    const uploaderContainer = this.sampleUploader['container'] as HTMLElement
    dropdown.appendChild(uploaderContainer)

    return dropdown
  }

  private buildPrefsMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0;
      width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    const prefs = this.prefsCallbacks.getPrefs?.() ?? {}
    const onChange = (key: string, value: number | boolean) => {
      this.prefsCallbacks.onPrefsChange?.(key, value)
    }

    const addSection = (title: string) => {
      const header = document.createElement('div')
      header.textContent = title
      header.style.cssText = `
        padding: 0.4rem 0.8rem 0.2rem;
        font-size: 0.55rem;
        color: ${theme.fgFaint};
        text-transform: uppercase;
        letter-spacing: 1px;
      `
      dropdown.appendChild(header)
    }

    const addSlider = (label: string, key: string, min: number, max: number, step: number, defaultVal: number, unit?: string) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        font-size: 0.68rem;
        color: ${theme.fg};
        gap: 0.4rem;
      `
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'flex: 1; white-space: nowrap;'

      const valLabel = document.createElement('span')
      const currentVal = typeof prefs[key] === 'number' ? prefs[key] as number : defaultVal
      valLabel.textContent = `${currentVal}${unit ?? ''}`
      valLabel.style.cssText = 'font-size: 0.6rem; color: ${theme.fgMuted}; min-width: 32px; text-align: right;'

      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(currentVal)
      input.style.cssText = 'width: 120px; height: 3px; accent-color: ${theme.accent}; cursor: pointer;'

      input.addEventListener('input', () => {
        const v = parseFloat(input.value)
        valLabel.textContent = `${v}${unit ?? ''}`
        onChange(key, v)
      })

      row.appendChild(lbl)
      row.appendChild(valLabel)
      row.appendChild(input)
      dropdown.appendChild(row)
    }

    const addCheckbox = (label: string, key: string, defaultVal: boolean) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        cursor: pointer;
        font-size: 0.68rem;
        color: ${theme.fg};
        gap: 0.5rem;
        transition: background 0.1s;
        user-select: none;
      `
      row.addEventListener('mouseenter', () => { row.style.background = theme.border })
      row.addEventListener('mouseleave', () => { row.style.background = 'none' })

      const isOn = typeof prefs[key] === 'boolean' ? prefs[key] as boolean : defaultVal

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? theme.accent : theme.borderStrong};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? theme.accent : 'none'};
        color: ${isOn ? theme.fg : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '\u2713' : ''

      const lbl = document.createElement('span')
      lbl.textContent = label

      row.addEventListener('click', (e) => {
        e.stopPropagation()
        const nowOn = check.textContent !== '\u2713'
        check.textContent = nowOn ? '\u2713' : ''
        check.style.color = nowOn ? theme.fg : 'transparent'
        check.style.background = nowOn ? theme.accent : 'none'
        check.style.borderColor = nowOn ? theme.accent : theme.borderStrong
        onChange(key, nowOn)
      })

      row.appendChild(check)
      row.appendChild(lbl)
      dropdown.appendChild(row)
    }

    const addReadonly = (label: string, value: string) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        font-size: 0.68rem;
        color: ${theme.fgMuted};
        gap: 0.4rem;
      `
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'flex: 1;'
      const val = document.createElement('span')
      val.textContent = value
      val.style.cssText = 'font-size: 0.6rem; color: ${theme.fgFaint};'
      row.appendChild(lbl)
      row.appendChild(val)
      dropdown.appendChild(row)
    }

    // --- Audio ---
    addSection('Audio')
    addSlider('Master Volume', 'masterVolume', 0, 100, 1, 80, '%')
    addSlider('Mixer Pre-Amp', 'mixerPreAmp', 0.1, 1.0, 0.01, 0.3)
    addSlider('Mixer Amp', 'mixerAmp', 0.5, 3.0, 0.1, 0.8)

    // --- Visuals ---
    addSection('Visuals')
    addSlider('Scope Line Width', 'scopeLineWidth', 1, 6, 0.5, 2, 'px')
    addSlider('Scope Glow', 'scopeGlow', 0, 20, 1, 4, 'px')
    addSlider('Scope Trail', 'scopeTrail', 0, 95, 5, 25, '%')
    addSlider('Scope Hue Shift', 'scopeHue', 0, 360, 5, 0, '\u00B0')

    // --- Editor ---
    addSection('Editor')
    addReadonly('Font Size', `${typeof prefs['fontSize'] === 'number' ? prefs['fontSize'] : 14}px (use A\u2212/A+ buttons)`)
    addCheckbox('Auto-scroll log', 'autoScrollLog', true)
    addCheckbox('Show line numbers', 'showLineNumbers', true)
    addCheckbox('Word wrap', 'wordWrap', false)

    // --- Performance ---
    addSection('Performance')
    addSlider('Schedule Ahead', 'schedAheadTime', 0.05, 0.5, 0.05, 0.3, 's')
    addReadonly('Max Loop Budget', '100,000 iterations')

    return dropdown
  }

  private openBugReport(): void {
    const data = this.getReportData?.()
    const browser = navigator.userAgent
    const url = new URL('https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/new')
    url.searchParams.set('template', 'bug_report.yml')
    url.searchParams.set('labels', 'bug,reported-via-app,needs-triage')

    // Pre-fill fields via URL params (GitHub issue forms support this)
    url.searchParams.set('version', APP_VERSION)
    if (data?.code) {
      url.searchParams.set('sonic-pi-code', data.code.substring(0, 2000))
    }
    url.searchParams.set('browser', detectBrowser(browser))
    url.searchParams.set('os', detectOS(browser))

    window.open(url.toString(), '_blank')
  }

  dispose(): void {
    this.closeDropdown()
    if (this.outsideClickHandler !== null) {
      document.removeEventListener('click', this.outsideClickHandler)
      this.outsideClickHandler = null
    }
    this.sampleUploader.dispose()
    this.container.remove()
  }
}
