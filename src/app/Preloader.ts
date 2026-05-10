/**
 * Preloader — pulls forward the heavy CDN dependencies before the App
 * mounts so the first Run / first preview doesn't pay the full network
 * cost of fetching ~MB of WASM and JS.
 *
 * What we preload (Phase 1 — pre-user-gesture):
 *   - 6 CodeMirror ESM modules (Editor.ts will import the same URLs)
 *   - TreeSitter runtime + Ruby grammar WASM (TreeSitterTranspiler.ts paths)
 *   - SuperSonic JS module (App.ts will import the same URL on first Run)
 *
 * What we DON'T preload (Phase 2 — post-user-gesture):
 *   - scsynth WASM binary  → SuperSonic.init() fetches this; needs AudioContext
 *     which the autoplay policy gates on a user gesture.
 *   - Sample FLACs         → lazy on first `sample :name`; preloading 197
 *     samples = several MB wasted for samples the user never plays.
 *   - Per-synth synthdefs  → lazy via loadedSynthDefs cache.
 *   - MIDI device list     → user-gesture gated for the permission prompt.
 *
 * Cache strategy:
 *   - For ES modules (CodeMirror, SuperSonic), use real `import()` — the
 *     module record is parsed + compiled once; later import() calls hit the
 *     cached record instantly.
 *   - For WASM binaries (TreeSitter), use `fetch()` to warm the HTTP cache.
 *     The runtime can't instantiate them until app code calls TS.init() /
 *     Language.load() with the right loader callbacks; at least the bytes
 *     are local by then.
 *
 * Step labels are 4 words or less. The label updates BEFORE the network
 * call starts, so the user always sees "what is happening right now."
 */

import { theme } from './theme'
import { createLogo } from './Logo'
import { track, EVENTS } from './Analytics'

/** Bucket a duration into a small set of labels — keeps Plausible's prop
 *  cardinality low (raw `ms` would be a unique value per session). */
function bucketDurationMs(ms: number): string {
  if (ms < 500) return '<500ms'
  if (ms < 1000) return '500-1000ms'
  if (ms < 2000) return '1-2s'
  if (ms < 5000) return '2-5s'
  if (ms < 10000) return '5-10s'
  return '10s+'
}

interface PreloadStep {
  /** Visible label, 4 words or less. */
  label: string
  load: () => Promise<unknown>
}

export class Preloader {
  private overlay: HTMLElement
  private bar: HTMLElement
  private status: HTMLElement
  private percentLabel: HTMLElement

  constructor() {
    this.overlay = document.createElement('div')
    this.overlay.id = 'spw-preloader'
    this.overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: ${theme.bgDark};
      color: ${theme.fg};
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.4rem;
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
      transition: opacity 0.25s ease-out;
    `

    // Shared logo block — same DOM Toolbar uses, so the wordmark stays
    // visually consistent between preloader and the live app chrome.
    // Bumped slightly larger here for the splash context.
    const logo = createLogo()
    const logoIcon = logo.firstChild as HTMLElement
    const logoText = logo.lastChild as HTMLElement
    if (logoIcon) logoIcon.style.fontSize = '1.8rem'
    if (logoText) logoText.style.fontSize = '1.15rem'
    this.overlay.appendChild(logo)

    const tagline = document.createElement('div')
    tagline.textContent = 'Live coding music in the browser'
    tagline.style.cssText = `
      font-size: 0.7rem;
      color: ${theme.fgFaint};
    `
    this.overlay.appendChild(tagline)

    // Progress track + bar
    const track = document.createElement('div')
    track.style.cssText = `
      width: 280px;
      height: 4px;
      background: ${theme.border};
      border-radius: 2px;
      overflow: hidden;
      margin-top: 0.6rem;
    `
    this.bar = document.createElement('div')
    this.bar.style.cssText = `
      height: 100%;
      width: 0%;
      background: ${theme.accent};
      transition: width 0.25s ease-out;
    `
    track.appendChild(this.bar)
    this.overlay.appendChild(track)

    // Status row: label on the left, percent on the right.
    const statusRow = document.createElement('div')
    statusRow.style.cssText = `
      width: 280px;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 0.7rem;
      color: ${theme.fgMuted};
    `
    this.status = document.createElement('span')
    this.status.textContent = 'Starting…'
    this.percentLabel = document.createElement('span')
    this.percentLabel.textContent = '0%'
    this.percentLabel.style.color = theme.fgFaint
    statusRow.append(this.status, this.percentLabel)
    this.overlay.appendChild(statusRow)

    document.body.appendChild(this.overlay)
  }

  async run(steps: PreloadStep[]): Promise<void> {
    const t0 = performance.now()
    let failures = 0
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      this.status.textContent = step.label
      try {
        await step.load()
      } catch (err) {
        // Preload failures are non-fatal — the app's normal lazy paths
        // will retry the same URL on first real use. Log and continue.
        // eslint-disable-next-line no-console
        console.warn(`[preloader] "${step.label}" failed to preload:`, err)
        failures++
      }
      const pct = Math.round(((i + 1) / steps.length) * 100)
      this.bar.style.width = `${pct}%`
      this.percentLabel.textContent = `${pct}%`
    }
    this.status.textContent = 'Ready'
    const elapsedMs = Math.round(performance.now() - t0)
    // Real-world cold-start telemetry: how long the preloader actually
    // took, and whether any CDN steps failed. Buckets the duration so
    // the dashboard isn't a high-cardinality sea of unique numbers.
    track(EVENTS.PreloaderComplete, {
      ms: elapsedMs,
      bucket: bucketDurationMs(elapsedMs),
      failures,
    })
    await new Promise((r) => setTimeout(r, 180))
    await this.fadeOut()
  }

  private async fadeOut(): Promise<void> {
    this.overlay.style.opacity = '0'
    await new Promise((r) => setTimeout(r, 260))
    this.overlay.remove()
  }
}

/**
 * The preload set. Order matters for the user-visible label sequence:
 * lighter / faster items first so the bar visibly moves while the
 * heaviest item (SuperSonic) downloads in the background.
 *
 * Each step's `load` returns a promise that resolves once the asset is
 * usable from the browser cache. Failures are swallowed by the runner.
 */
export function defaultPreloadSteps(): PreloadStep[] {
  return [
    {
      label: 'Code editor',
      // Editor.ts will `import()` these exact URLs at construction. Pulling
      // them now means the editor renders without a blank-then-styled flash.
      load: () => Promise.all([
        // @ts-ignore CDN URL
        import(/* @vite-ignore */ 'https://esm.sh/@codemirror/view@6'),
        // @ts-ignore
        import(/* @vite-ignore */ 'https://esm.sh/@codemirror/state@6'),
        // @ts-ignore
        import(/* @vite-ignore */ 'https://esm.sh/@codemirror/commands@6'),
        // @ts-ignore
        import(/* @vite-ignore */ 'https://esm.sh/@codemirror/language@6'),
        // @ts-ignore
        import(/* @vite-ignore */ 'https://esm.sh/@lezer/highlight@1'),
        // @ts-ignore
        import(/* @vite-ignore */ 'https://esm.sh/@codemirror/autocomplete@6'),
      ]),
    },
    {
      label: 'Ruby parser',
      // TreeSitter WASMs are Vite-served from /public. Only fetch — the
      // runtime instantiates them later via TS.init / Language.load with
      // their own loader callbacks. Bytes will be in HTTP cache by then.
      load: () => Promise.all([
        fetch('/tree-sitter.wasm', { cache: 'force-cache' }),
        fetch('/tree-sitter-ruby.wasm', { cache: 'force-cache' }),
      ]),
    },
    {
      label: 'Audio runtime',
      // SuperSonic JS module — App.handlePlay / ensureEngineInitialised
      // imports the same URL on first Run. Importing here parses + compiles
      // the JS so first Run only pays for scsynth WASM + AudioContext
      // (~300 ms) instead of the full ~1-2 s cold start.
      // @ts-ignore CDN URL
      load: () => import(/* @vite-ignore */ 'https://unpkg.com/supersonic-scsynth@0.57.0'),
    },
  ]
}
