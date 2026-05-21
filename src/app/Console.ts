/**
 * Console / log pane — Sonic Pi-style log with run counters and timestamps.
 */

import { theme } from './theme'

export type LogLevel = 'info' | 'error' | 'event' | 'system' | 'cue' | 'warning'

interface LogEntry {
  level: LogLevel
  text: string
  time: number
  run?: number
  beat?: number
}

const MAX_ENTRIES = 500

export class Console {
  private el: HTMLElement
  private header: HTMLElement
  private body: HTMLElement
  private entries: LogEntry[] = []
  private autoScroll = true

  /** Set auto-scroll behavior. */
  setAutoScroll(on: boolean): void { this.autoScroll = on }

  private runCount = 0
  private startTime = 0
  /** Pending entries waiting for next animation frame flush (#73 — DOM throttling). */
  private pendingEntries: LogEntry[] = []
  private rafScheduled = false

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.style.cssText = `
      height: 100%; display: flex; flex-direction: column;
      background: ${theme.bgDarker}; overflow: hidden;
    `
    container.appendChild(this.el)

    // Header
    this.header = document.createElement('div')
    this.header.style.cssText = `
      padding: 0.35rem 0.6rem;
      font-size: 0.65rem;
      color: ${theme.comment};
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid ${theme.border};
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    `
    this.header.innerHTML = '<span>Log</span>'

    // Clear button
    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear'
    clearBtn.style.cssText = `
      background: none; border: none; color: ${theme.comment};
      font-family: inherit; font-size: 0.6rem; cursor: pointer;
      padding: 0.1rem 0.4rem; border-radius: 3px;
      transition: color 0.15s;
    `
    clearBtn.addEventListener('click', () => this.clear())
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.color = theme.accent })
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.color = theme.comment })
    this.header.appendChild(clearBtn)
    this.el.appendChild(this.header)

    // Body
    this.body = document.createElement('div')
    this.body.style.cssText = `
      flex: 1; overflow-y: auto; overflow-x: hidden;
      font-family: inherit; font-size: 0.72rem;
      line-height: 1.5; padding: 0.3rem 0;
      scrollbar-width: thin;
      scrollbar-color: ${theme.fgFaint} transparent;
    `
    this.el.appendChild(this.body)

    this.body.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.body
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 30
    })
  }

  /** Called when Run is pressed — increments the run counter. */
  newRun(): void {
    this.runCount++
    this.startTime = performance.now()
  }

  private elapsed(): string {
    const ms = performance.now() - this.startTime
    return (ms / 1000).toFixed(4)
  }

  log(text: string, level: LogLevel = 'info'): void {
    const entry: LogEntry = { level, text, time: Date.now(), run: this.runCount }
    this.entries.push(entry)
    this.trimIfNeeded()
    this.scheduleFlush(entry)
  }

  logEvent(type: string, detail: string, audioTime?: number): void {
    const entry: LogEntry = {
      level: 'event',
      text: detail,
      time: Date.now(),
      run: this.runCount,
      beat: audioTime,
    }
    this.entries.push(entry)
    this.trimIfNeeded()
    this.scheduleFlush(entry)
  }

  /**
   * Trim entries array and remove oldest DOM children — O(1) per call.
   * Previous approach called rebuild() which recreated ALL 500 DOM elements
   * on every entry after the buffer filled — 43,000 DOM ops/sec at 86 entries/sec.
   * This was the #75 main thread bottleneck. See issue #75.
   */
  private trimIfNeeded(): void {
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
      // Remove oldest DOM child to keep DOM in sync
      if (this.body.firstChild) {
        this.body.removeChild(this.body.firstChild)
      }
    }
  }

  /**
   * Batch DOM updates to requestAnimationFrame — prevents 250+ DOM mutations
   * per second from blocking the main thread. See issue #73.
   */
  private scheduleFlush(entry: LogEntry): void {
    this.pendingEntries.push(entry)
    if (!this.rafScheduled) {
      this.rafScheduled = true
      requestAnimationFrame(() => {
        this.rafScheduled = false
        // Use DocumentFragment to batch all appends into one reflow
        const fragment = document.createDocumentFragment()
        for (const e of this.pendingEntries) {
          fragment.appendChild(this.createLine(e))
        }
        this.body.appendChild(fragment)
        this.pendingEntries.length = 0
        // Auto-scroll after batch
        if (this.autoScroll) {
          this.body.scrollTop = this.body.scrollHeight
        }
      })
    }
  }

  logError(title: string, message: string): void {
    this.log(`${title}\n${message}`, 'error')
  }

  /**
   * Warning — non-fatal, audio still runs, but a v1 limitation or
   * latent issue was detected (e.g. SP95-loud cross-loop set/get,
   * cue payload via sync return-value). Same structured-block treatment
   * as logError but in the theme's warning hue so the user can see at a
   * glance that the run continues vs. logError where audio doesn't start.
   */
  logWarning(title: string, message: string): void {
    this.log(`${title}\n${message}`, 'warning')
  }

  logSystem(text: string): void {
    this.log(text, 'system')
  }

  logCue(name: string): void {
    this.log(`cue :${name}`, 'cue')
  }

  clear(): void {
    this.entries = []
    this.body.innerHTML = ''
  }

  private appendLine(entry: LogEntry): void {
    this.body.appendChild(this.createLine(entry))
    if (this.autoScroll) {
      this.body.scrollTop = this.body.scrollHeight
    }
  }

  private createLine(entry: LogEntry): HTMLDivElement {
    const line = document.createElement('div')
    line.style.cssText = `
      padding: 0.1rem 0.6rem;
      display: flex;
      gap: 0.5rem;
      border-left: 2px solid transparent;
    `

    // Run/time prefix (Sonic Pi style)
    if (entry.level !== 'system') {
      const prefix = document.createElement('span')
      prefix.style.cssText = `
        color: ${theme.fgFaint}; font-size: 0.65rem; min-width: 9ch;
        flex-shrink: 0;
      `
      const t = entry.beat != null ? entry.beat.toFixed(4) : this.elapsed()
      prefix.textContent = `{run:${entry.run}, t:${t}}`
      line.appendChild(prefix)
    }

    const content = document.createElement('span')
    content.style.cssText = 'white-space: pre-wrap; word-break: break-word;'

    switch (entry.level) {
      case 'event':
        content.style.color = theme.cyan
        line.style.borderLeftColor = `${theme.cyan}33`
        break
      case 'error': {
        // Structured error block — Desktop SP style
        line.style.background = theme.accentFaint
        line.style.borderLeftColor = theme.accent
        line.style.borderLeftWidth = '3px'
        line.style.padding = '0.4rem 0.6rem'
        line.style.margin = '0.2rem 0'
        line.style.borderRadius = '0 4px 4px 0'

        // Split title from message (first line is title)
        const parts = entry.text.split('\n')
        const titleText = parts[0] || 'Error'
        const bodyText = parts.slice(1).join('\n').trim()

        // Title line — bold, larger
        const titleEl = document.createElement('div')
        titleEl.style.cssText = `color: ${theme.accent}; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem;`
        titleEl.textContent = `⚠ ${titleText}`
        content.appendChild(titleEl)

        // Body — softer color, preserve formatting
        if (bodyText) {
          const bodyEl = document.createElement('div')
          bodyEl.style.cssText = `color: ${theme.red}; font-size: 0.68rem; white-space: pre-wrap; line-height: 1.5;`
          bodyEl.textContent = bodyText
          content.appendChild(bodyEl)
        }

        content.style.color = '' // Reset — children handle color
        break
      }
      case 'cue':
        content.style.color = theme.purple
        line.style.borderLeftColor = `${theme.purple}33`
        break
      case 'warning': {
        // Structured warning block — same shape as 'error' but in the
        // theme's warning hue (yellow/amber). Audio still runs; the block
        // says "v1 limitation / latent issue, here's what to use instead."
        line.style.background = `${theme.warning}14`
        line.style.borderLeftColor = theme.warning
        line.style.borderLeftWidth = '3px'
        line.style.padding = '0.4rem 0.6rem'
        line.style.margin = '0.2rem 0'
        line.style.borderRadius = '0 4px 4px 0'

        const parts = entry.text.split('\n')
        const titleText = parts[0] || 'Warning'
        const bodyText = parts.slice(1).join('\n').trim()

        const titleEl = document.createElement('div')
        titleEl.style.cssText = `color: ${theme.warning}; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem;`
        titleEl.textContent = `⚠ ${titleText}`
        content.appendChild(titleEl)

        if (bodyText) {
          const bodyEl = document.createElement('div')
          bodyEl.style.cssText = `color: ${theme.yellow}; font-size: 0.68rem; white-space: pre-wrap; line-height: 1.5;`
          bodyEl.textContent = bodyText
          content.appendChild(bodyEl)
        }

        content.style.color = '' // children handle color
        break
      }
      case 'system':
        content.style.color = theme.comment
        content.style.fontStyle = 'italic'
        content.style.padding = '0 0.6rem'
        break
      default:
        content.style.color = theme.fgMuted
        break
    }

    content.textContent = entry.text
    line.appendChild(content)
    return line
  }

  private rebuild(): void {
    this.body.innerHTML = ''
    for (const entry of this.entries) {
      this.appendLine(entry)
    }
  }

  dispose(): void {
    this.el.remove()
  }
}
