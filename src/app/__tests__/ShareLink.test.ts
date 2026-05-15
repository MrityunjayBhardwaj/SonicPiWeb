import { describe, it, expect } from 'vitest'
import { encodeShareCode, decodeShareCode, buildShareURL } from '../ShareLink'

describe('ShareLink', () => {
  const roundtrip = (code: string) => decodeShareCode(encodeShareCode(code))

  it('round-trips plain ASCII code', () => {
    const code = 'live_loop :drums do\n  sample :bd_haus\n  sleep 1\nend'
    expect(roundtrip(code)).toBe(code)
  })

  it('round-trips unicode and emoji', () => {
    const code = '# ♯ こんにちは 🎹🥁\nuse_synth :prophet'
    expect(roundtrip(code)).toBe(code)
  })

  it('round-trips empty string', () => {
    expect(roundtrip('')).toBe('')
  })

  it('round-trips a large buffer (~12KB)', () => {
    const code = 'play 60\nsleep 0.25\n'.repeat(700)
    expect(roundtrip(code)).toBe(code)
  })

  it('produces a url-safe fragment (no +, /, =, or spaces)', () => {
    const frag = encodeShareCode('a/b+c=d e\nf?g#h')
    expect(frag.startsWith('#c=')).toBe(true)
    // The base64url payload (after the `#c=` key) must be url-safe.
    expect(frag.slice(3)).not.toMatch(/[+/= ]/)
  })

  it('returns null when the c= key is absent', () => {
    expect(decodeShareCode('')).toBeNull()
    expect(decodeShareCode('#')).toBeNull()
    expect(decodeShareCode('#foo=bar')).toBeNull()
  })

  it('treats #c= (key present, empty payload) as a shared empty buffer', () => {
    expect(decodeShareCode('#c=')).toBe('')
    expect(decodeShareCode(encodeShareCode(''))).toBe('')
  })

  it('returns null for a malformed payload instead of throwing', () => {
    expect(decodeShareCode('#c=@@@not base64@@@')).toBeNull()
  })

  it('accepts the fragment with or without a leading #', () => {
    const frag = encodeShareCode('hi')
    expect(decodeShareCode(frag)).toBe('hi')
    expect(decodeShareCode(frag.slice(1))).toBe('hi')
  })

  it('buildShareURL appends the fragment to an explicit base', () => {
    const url = buildShareURL('play 72', 'https://sonicpi.cc/')
    expect(url).toBe('https://sonicpi.cc/' + encodeShareCode('play 72'))
    expect(decodeShareCode(new URL(url).hash)).toBe('play 72')
  })
})
