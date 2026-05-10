/**
 * SampleBrowser — modal for browsing, searching, previewing, and inserting samples.
 *
 * Opens as a centered overlay. Left column: category list. Right column: sample list
 * filtered by selected category and search query. Each sample has preview (play) and
 * insert (paste into editor) buttons.
 */

import { getCategories, getSamplesByCategory, searchSamples, type SampleInfo } from '../engine/SampleCatalog'
import { theme } from './theme'

export interface SampleBrowserCallbacks {
  onPreviewSample: (name: string) => Promise<void> | void
  onStopPreview: () => void
  onInsertText: (text: string) => void
}

const PLAY_GLYPH = '▶'
const PAUSE_GLYPH = '⏸'
// Preview plays the sample 5 times in App.previewSample. Most one-shot
// samples are 0.05s–6s (5× = ≤30s); :loop_* and :ambi_* run 8–25s each
// (5× = ≤125s). We don't have per-sample durations on the JS side, so use
// a conservative cap that covers the long-tail. The timer is purely a UI
// revert; clicking Pause cuts the audio earlier and resets the button.
const PREVIEW_AUTO_REVERT_MS = 60000

export class SampleBrowser {
  private overlay: HTMLElement | null = null
  private callbacks: SampleBrowserCallbacks
  private selectedCategory = ''
  private searchQuery = ''
  private categoryListEl: HTMLElement | null = null
  private sampleListEl: HTMLElement | null = null
  private escHandler: ((e: KeyboardEvent) => void) | null = null
  /** Currently-playing preview row state. Only one preview at a time. */
  private currentPreview: { btn: HTMLButtonElement; name: string; timerId: number } | null = null

  constructor(callbacks: SampleBrowserCallbacks) {
    this.callbacks = callbacks
  }

  private resetPreview(): void {
    if (!this.currentPreview) return
    clearTimeout(this.currentPreview.timerId)
    const { btn } = this.currentPreview
    btn.textContent = PLAY_GLYPH
    btn.title = 'Preview sample'
    this.currentPreview = null
  }

  open(): void {
    if (this.overlay) return
    this.selectedCategory = ''
    this.searchQuery = ''

    // Overlay backdrop
    this.overlay = document.createElement('div')
    this.overlay.style.cssText = `
      position: fixed; inset: 0;
      background: ${theme.shadowStrong};
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    `
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })

    // Modal container
    const modal = document.createElement('div')
    modal.style.cssText = `
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 8px;
      width: 640px;
      max-width: 90vw;
      height: 480px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 16px 48px ${theme.shadowStrong};
      overflow: hidden;
    `
    this.overlay.appendChild(modal)

    // Header row: title + search + close
    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.8rem;
      border-bottom: 1px solid ${theme.border};
      flex-shrink: 0;
    `

    const title = document.createElement('span')
    title.textContent = 'Samples'
    title.style.cssText = `
      font-size: 0.8rem;
      font-weight: 700;
      color: ${theme.fg};
      white-space: nowrap;
    `
    header.appendChild(title)

    // Search input
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = 'Search samples...'
    searchInput.style.cssText = `
      flex: 1;
      background: ${theme.border};
      border: 1px solid ${theme.borderHover};
      border-radius: 4px;
      padding: 0.3rem 0.5rem;
      color: ${theme.fg};
      font-family: inherit;
      font-size: 0.7rem;
      outline: none;
      margin-left: 0.5rem;
    `
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim()
      this.renderSamples()
    })
    searchInput.addEventListener('focus', () => {
      searchInput.style.borderColor = theme.accent
    })
    searchInput.addEventListener('blur', () => {
      searchInput.style.borderColor = theme.borderHover
    })
    header.appendChild(searchInput)

    // Close button
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '\u2715'
    closeBtn.style.cssText = `
      background: none;
      border: none;
      color: ${theme.fgMuted};
      font-size: 0.9rem;
      cursor: pointer;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      transition: background 0.1s, color 0.1s;
      line-height: 1;
    `
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = theme.border
      closeBtn.style.color = theme.fg
    })
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'none'
      closeBtn.style.color = theme.fgMuted
    })
    closeBtn.addEventListener('click', () => this.close())
    header.appendChild(closeBtn)
    modal.appendChild(header)

    // Body: categories (left) + samples (right)
    const body = document.createElement('div')
    body.style.cssText = `
      flex: 1;
      display: flex;
      min-height: 0;
      overflow: hidden;
    `
    modal.appendChild(body)

    // Category list
    this.categoryListEl = document.createElement('div')
    this.categoryListEl.style.cssText = `
      width: 140px;
      min-width: 120px;
      border-right: 1px solid ${theme.border};
      overflow-y: auto;
      padding: 0.3rem 0;
      flex-shrink: 0;
    `
    body.appendChild(this.categoryListEl)

    // Sample list
    this.sampleListEl = document.createElement('div')
    this.sampleListEl.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 0.3rem 0;
    `
    body.appendChild(this.sampleListEl)

    this.renderCategories()
    this.renderSamples()

    document.body.appendChild(this.overlay)

    // Focus search
    searchInput.focus()

    // Escape to close
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    document.addEventListener('keydown', this.escHandler, true)
  }

  close(): void {
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler, true)
      this.escHandler = null
    }
    if (this.overlay) {
      this.overlay.remove()
      this.overlay = null
    }
    this.categoryListEl = null
    this.sampleListEl = null
    if (this.currentPreview) {
      this.callbacks.onStopPreview()
      this.resetPreview()
    }
  }

  get isOpen(): boolean {
    return this.overlay !== null
  }

  private renderCategories(): void {
    const el = this.categoryListEl
    if (!el) return
    el.innerHTML = ''

    // "All" option
    const allItem = this.createCategoryItem('All', '')
    el.appendChild(allItem)

    for (const cat of getCategories()) {
      const count = getSamplesByCategory(cat).length
      el.appendChild(this.createCategoryItem(`${cat} (${count})`, cat))
    }
  }

  private createCategoryItem(label: string, category: string): HTMLElement {
    const item = document.createElement('div')
    const isActive = this.selectedCategory === category
    item.style.cssText = `
      padding: 0.25rem 0.6rem;
      font-size: 0.65rem;
      color: ${isActive ? theme.fg : theme.fgMuted};
      background: ${isActive ? theme.accentMuted : 'transparent'};
      border-left: 2px solid ${isActive ? theme.accent : 'transparent'};
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `
    item.textContent = label
    item.addEventListener('mouseenter', () => {
      if (this.selectedCategory !== category) {
        item.style.background = theme.border
        item.style.color = theme.fg
      }
    })
    item.addEventListener('mouseleave', () => {
      if (this.selectedCategory !== category) {
        item.style.background = 'transparent'
        item.style.color = theme.fgMuted
      }
    })
    item.addEventListener('click', () => {
      this.selectedCategory = category
      this.renderCategories()
      this.renderSamples()
    })
    return item
  }

  private renderSamples(): void {
    const el = this.sampleListEl
    if (!el) return
    el.innerHTML = ''

    let samples: SampleInfo[]
    if (this.searchQuery) {
      samples = searchSamples(this.searchQuery)
      if (this.selectedCategory) {
        samples = samples.filter(s => s.category === this.selectedCategory)
      }
    } else if (this.selectedCategory) {
      samples = getSamplesByCategory(this.selectedCategory)
    } else {
      // Show all, grouped by category
      samples = []
      for (const cat of getCategories()) {
        samples.push(...getSamplesByCategory(cat))
      }
    }

    if (samples.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No samples found'
      empty.style.cssText = `
        padding: 1.5rem;
        text-align: center;
        color: ${theme.fgFaint};
        font-size: 0.7rem;
      `
      el.appendChild(empty)
      return
    }

    for (const sample of samples) {
      el.appendChild(this.createSampleRow(sample))
    }
  }

  private createSampleRow(sample: SampleInfo): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      padding: 0.2rem 0.6rem;
      gap: 0.4rem;
      transition: background 0.1s;
    `
    row.addEventListener('mouseenter', () => {
      row.style.background = theme.border
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent'
    })

    // Preview button \u2014 toggles between play (\u25B6) and pause (\u23F8).
    const previewBtn = document.createElement('button')
    previewBtn.textContent = PLAY_GLYPH
    previewBtn.title = 'Preview sample'
    previewBtn.style.cssText = `
      background: none;
      border: 1px solid ${theme.borderHover};
      color: ${theme.fgMuted};
      border-radius: 3px;
      width: 22px; height: 22px;
      font-size: 0.5rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    `
    previewBtn.addEventListener('mouseenter', () => {
      previewBtn.style.borderColor = theme.accent
      previewBtn.style.color = theme.accent
    })
    previewBtn.addEventListener('mouseleave', () => {
      previewBtn.style.borderColor = theme.borderHover
      previewBtn.style.color = theme.fgMuted
    })
    previewBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      // Click on the currently-playing button \u2192 pause + revert.
      if (this.currentPreview && this.currentPreview.btn === previewBtn) {
        this.callbacks.onStopPreview()
        this.resetPreview()
        return
      }
      // Click on a different row \u2192 stop the previous preview and reset its
      // button before starting the new one. Engine state is replaced anyway
      // by the next evaluate(); explicit stop keeps the UI honest.
      if (this.currentPreview) {
        this.callbacks.onStopPreview()
        this.resetPreview()
      }
      // Mark this row as playing optimistically; the await may take a beat
      // for the engine cold-start path.
      previewBtn.textContent = PAUSE_GLYPH
      previewBtn.title = 'Stop preview'
      const timerId = window.setTimeout(() => {
        // Auto-revert after the conservative cap. If the user stopped sooner,
        // currentPreview is already null and resetPreview is a no-op.
        if (this.currentPreview && this.currentPreview.btn === previewBtn) {
          this.resetPreview()
        }
      }, PREVIEW_AUTO_REVERT_MS)
      this.currentPreview = { btn: previewBtn, name: sample.name, timerId }
      try {
        await this.callbacks.onPreviewSample(sample.name)
      } catch {
        // Preview failed (e.g. engine init error). Revert the button.
        if (this.currentPreview && this.currentPreview.btn === previewBtn) {
          this.resetPreview()
        }
      }
    })
    row.appendChild(previewBtn)

    // Sample name
    const name = document.createElement('span')
    name.textContent = `:${sample.name}`
    name.style.cssText = `
      flex: 1;
      font-size: 0.7rem;
      color: ${theme.fg};
      font-family: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `
    row.appendChild(name)

    // Category badge (when showing all)
    if (!this.selectedCategory) {
      const badge = document.createElement('span')
      badge.textContent = sample.category
      badge.style.cssText = `
        font-size: 0.55rem;
        color: ${theme.fgFaint};
        white-space: nowrap;
        flex-shrink: 0;
      `
      row.appendChild(badge)
    }

    // Insert button
    const insertBtn = document.createElement('button')
    insertBtn.textContent = 'Insert'
    insertBtn.title = 'Insert at cursor'
    insertBtn.style.cssText = `
      background: ${theme.border};
      border: 1px solid ${theme.borderHover};
      color: ${theme.fgMuted};
      border-radius: 3px;
      padding: 0.15rem 0.4rem;
      font-family: inherit;
      font-size: 0.55rem;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s;
    `
    insertBtn.addEventListener('mouseenter', () => {
      insertBtn.style.borderColor = theme.cyan
      insertBtn.style.color = theme.cyan
    })
    insertBtn.addEventListener('mouseleave', () => {
      insertBtn.style.borderColor = theme.borderHover
      insertBtn.style.color = theme.fgMuted
    })
    insertBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.callbacks.onInsertText(`sample :${sample.name}`)
    })
    row.appendChild(insertBtn)

    return row
  }

  dispose(): void {
    this.close()
  }
}
