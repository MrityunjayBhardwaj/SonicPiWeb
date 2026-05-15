/**
 * Share-link (permalink) encoding for the editor buffer.
 *
 * Option B from issue #306: encode the track into the URL fragment so a
 * single link fully reconstructs it. No backend, no dependencies — the
 * code rides in the hash as UTF-8-safe base64url.
 *
 * The fragment key is versioned (`c=` → "code, v1"). Future formats
 * (compressed, multi-buffer) can claim a new key without breaking old
 * links: `decodeShareCode` simply returns null for keys it does not know.
 */

/** Fragment key: `#c=<base64url>`. `c` = code, version 1. */
const PREFIX = 'c='

function bytesToBase64Url(bytes: Uint8Array): string {
  // Chunked to keep String.fromCharCode under the argument-count / stack
  // limit for large buffers (a few KB of live-coding code is well within,
  // but a paste of a long track must not throw).
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Encode code into a URL fragment (including the leading `#`). */
export function encodeShareCode(code: string): string {
  const bytes = new TextEncoder().encode(code)
  return '#' + PREFIX + bytesToBase64Url(bytes)
}

/**
 * Build a full shareable URL. `base` defaults to the current
 * origin+pathname (query and old hash dropped — a share link is a clean
 * entry point, not the sharer's exact view).
 */
export function buildShareURL(code: string, base?: string): string {
  const origin =
    base ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '')
  return origin + encodeShareCode(code)
}

/**
 * Decode a share fragment back to code. Returns null when there is no
 * share payload or it is malformed — callers fall back to their normal
 * load path (localStorage / welcome).
 */
export function decodeShareCode(hash?: string): string | null {
  const h = (hash ?? (typeof location !== 'undefined' ? location.hash : '')) || ''
  const raw = h.startsWith('#') ? h.slice(1) : h
  // A missing `c=` key means "no share payload" (null → caller falls back).
  // A present-but-empty payload (`#c=`) is a legitimately shared empty
  // buffer and must round-trip to '' — do not collapse it to null.
  if (!raw.startsWith(PREFIX)) return null
  const payload = raw.slice(PREFIX.length)
  try {
    return new TextDecoder().decode(base64UrlToBytes(payload))
  } catch {
    return null
  }
}
