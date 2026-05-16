import { describe, it, expect } from 'vitest'
import { scanComponentNames } from '../ComponentScan'

const s = (code: string) => {
  const m = scanComponentNames(code)
  return {
    samples: [...m.samples].sort(),
    fx: [...m.fx].sort(),
    synths: [...m.synths].sort(),
  }
}

describe('scanComponentNames (#318.3 / #323 static extractor)', () => {
  it('finds symbol, string, and paren literal forms', () => {
    expect(s('sample :bd_haus')).toMatchObject({ samples: ['bd_haus'] })
    expect(s('sample "bd_haus"')).toMatchObject({ samples: ['bd_haus'] })
    expect(s("sample('bd_haus', amp: 2)")).toMatchObject({ samples: ['bd_haus'] })
  })

  it('separates use_synth / synth / with_fx into the right buckets', () => {
    const r = s('use_synth :prophet\nsynth :saw, note: 60\nwith_fx :reverb do\nend')
    expect(r.synths).toEqual(['prophet', 'saw'])
    expect(r.fx).toEqual(['reverb'])
  })

  it('does NOT mistake the synth inside use_synth for a separate synth ref', () => {
    // \b before `synth` cannot match mid-word in `use_synth` (_ is a word char).
    expect(s('use_synth :tb303')).toEqual({ samples: [], fx: [], synths: ['tb303'] })
  })

  it('deduplicates repeated references', () => {
    expect(s('sample :bd_haus\nsleep 1\nsample :bd_haus').samples).toEqual(['bd_haus'])
  })

  it('a commented-out reference must NOT be collected (no false-block)', () => {
    expect(s('# sample :typo_should_not_block\nsample :bd_haus').samples).toEqual([
      'bd_haus',
    ])
    expect(s('sample :bd_haus  # with_fx :ghost').fx).toEqual([])
  })

  it('strips =begin/=end block comments', () => {
    const code = '=begin\nsample :commented_out\n=end\nsample :real'
    expect(s(code).samples).toEqual(['real'])
  })

  it('preserves #{} interpolation (only # not followed by { is a comment)', () => {
    // The `#{i}` must not truncate the line; the literal name is still found.
    expect(s('with_fx :echo do\n  play "#{note}"\nend').fx).toEqual(['echo'])
  })

  it('does NOT collect runtime-computed names (bounded by design)', () => {
    const r = s('use_synth SYNTHS.tick\nsample samps.choose\nwith_fx fx_name')
    expect(r).toEqual({ samples: [], fx: [], synths: [] })
  })

  it('collects user_ custom sample names (resolver applies the exemption, not the scanner)', () => {
    expect(s('sample :user_mykick').samples).toEqual(['user_mykick'])
  })

  it('handles a realistic multi-component snippet', () => {
    const code = `
      use_synth :tb303
      live_loop :bass do
        with_fx :reverb do
          synth :saw, note: 40
          sample :bd_haus
        end
        sleep 1
      end
    `
    expect(s(code)).toEqual({
      samples: ['bd_haus'],
      fx: ['reverb'],
      synths: ['saw', 'tb303'],
    })
  })

  it('empty / component-free code yields empty sets', () => {
    expect(s('play 60\nsleep 1')).toEqual({ samples: [], fx: [], synths: [] })
    expect(s('')).toEqual({ samples: [], fx: [], synths: [] })
  })
})
