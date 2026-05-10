/**
 * Analytics — thin wrapper around the Plausible custom-events API.
 *
 * Why a wrapper:
 *   - One place to swap providers if we ever leave Plausible.
 *   - One place to toggle off via localStorage (`spw-disable-analytics`).
 *   - Forces every call site to use a typed event name from EVENTS so we
 *     don't accumulate typo'd / inconsistent event labels in the dashboard.
 *
 * Privacy contract — what we do NOT send:
 *   - No user source code, ever. Error events carry the error CLASS NAME
 *     only (e.g. 'NoMethodError'), never the message or stack.
 *   - No IP / user-agent (Plausible already strips these on its end).
 *   - No identifiers that could correlate sessions to a person.
 *
 * Plausible's queue stub is set up in index.html before this file loads,
 * so calls placed during preload are buffered and flushed once the async
 * script lands.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type PlausibleFn = (eventName: string, opts?: { props?: Record<string, string | number> }) => void

declare global {
  interface Window {
    plausible?: PlausibleFn
  }
}

/** Canonical event names — keep in sync with the Plausible dashboard. */
export const EVENTS = {
  RunCode: 'Run Code',
  EngineInitFailed: 'Engine Init Failed',
  RuntimeError: 'Runtime Error',
  SamplePreview: 'Sample Preview',
  MidiOpened: 'MIDI Opened',
  RecordingSaved: 'Recording Saved',
  ExampleLoaded: 'Example Loaded',
  PreloaderComplete: 'Preloader Complete',
} as const

export type EventName = typeof EVENTS[keyof typeof EVENTS]

/** Detect Chromium-family vs other. Used as a `browser` prop on most events. */
export function detectBrowserFamily(): 'chromium' | 'firefox' | 'safari' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chromium'
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'safari'
  return 'other'
}

/**
 * Extract the error CLASS NAME (e.g. 'NoMethodError') from a thrown value.
 * Never returns the message or stack — those can leak user code.
 */
export function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor.name || 'Error'
  if (err && typeof err === 'object' && 'name' in err && typeof (err as any).name === 'string') {
    return (err as any).name
  }
  return 'UnknownError'
}

/** Quietly swallow if the user opted out or Plausible isn't loaded yet. */
function userOptedOut(): boolean {
  try {
    return localStorage.getItem('spw-disable-analytics') === '1'
  } catch {
    return false
  }
}

/**
 * Fire a tracked event. Safe to call from anywhere — failures are
 * swallowed so analytics issues never affect the user-facing app.
 */
export function track(name: EventName, props?: Record<string, string | number>): void {
  if (userOptedOut()) return
  try {
    const fn = window.plausible
    if (typeof fn !== 'function') return
    fn(name, props ? { props } : undefined)
  } catch {
    // Never let analytics break the app.
  }
}
