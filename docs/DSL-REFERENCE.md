# SonicPi.js -- DSL Reference

Complete reference for every Sonic Pi construct supported in the browser.
Write code using standard Sonic Pi (Ruby) syntax -- the parser transpiles it automatically.

> **Notation:** `:name` is a Ruby symbol. The parser converts it to a `"name"` string in JS.
> Optional parameters are shown as `opts` and use Ruby keyword syntax: `key: value`.

---

## 1. Playback

### `play note, opts`

Trigger a synth note.

```ruby
play 60                          # middle C
play :c4, amp: 0.5, release: 2  # named note with options
play chord(:e3, :minor)         # play a chord (all notes at once)
```

**Common options:** `amp`, `pan`, `attack`, `decay`, `sustain`, `release`, `cutoff`, `res`, `note_slide`, `amp_slide`, `pan_slide`, `cutoff_slide`

---

### `sample name, opts`

Trigger a sample.

```ruby
sample :bd_haus
sample :loop_amen, amp: 0.8, rate: 1.5
```

**Common options:** `amp`, `pan`, `rate`, `attack`, `release`

---

### `use_synth :name`

Set the default synth for subsequent `play` calls.

```ruby
use_synth :prophet
play 60   # uses prophet
```

---

### `use_bpm N`

Set beats per minute. Affects all `sleep` durations.

```ruby
use_bpm 120
sleep 1    # waits 0.5 seconds (60/120)
```

---

### `sleep N`

Wait N beats (scaled by current BPM).

```ruby
play 60
sleep 0.5
play 64
```

---

### `stop`

Stop the current live_loop iteration. The loop will restart from the top.

```ruby
live_loop :careful do
  stop if one_in(4)
  play 60
  sleep 1
end
```

---

### `live_audio :name`

Mic/line input (simplified -- browser `getUserMedia`).

```ruby
live_audio :mic
```

**Note:** Named audio buses are not supported. This provides basic mic input only.

---

## 2. Loops and Threads

### `live_loop :name do ... end`

A named loop that repeats forever. The fundamental building block.

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
```

---

### `live_loop :name, sync: :other do ... end`

A loop that waits for a cue from another loop before each iteration.

```ruby
live_loop :bass, sync: :drums do
  use_synth :tb303
  play :e2, release: 0.3
  sleep 0.5
end
```

---

### `in_thread do ... end`

Fire-and-forget thread. Runs concurrently, not repeating.

```ruby
in_thread do
  play 60
  sleep 1
  play 64
end
play 67  # plays immediately, concurrent with thread
```

---

### `loop do ... end`

Infinite loop (use inside a `live_loop` or `in_thread`).

```ruby
live_loop :forever do
  loop do
    play 60
    sleep 1
  end
end
```

---

### `N.times do |i| ... end`

Repeat a block N times. The block variable `i` counts from 0.

```ruby
live_loop :riff do
  4.times do |i|
    play 60 + i * 4
    sleep 0.25
  end
end
```

---

## 3. Timing and Coordination

### `sync :name`

Pause execution until another loop fires `cue :name`.

```ruby
live_loop :follower do
  sync :beat
  play 60
  sleep 1
end
```

---

### `cue :name`

Fire a named cue. Any loops waiting on `sync :name` will resume.

```ruby
live_loop :leader do
  cue :beat
  sample :bd_haus
  sleep 1
end
```

---

### `at [times] do ... end`

Spawn concurrent threads at specific beat offsets.

```ruby
at [0, 0.5, 1, 1.5] do
  sample :hat_snap
end
sleep 2
```

---

### `at [times], [values] do |v| ... end`

Spawn threads at offsets, passing a value to each.

```ruby
at [0, 1, 2], [:c4, :e4, :g4] do |n|
  play n
end
sleep 3
```

---

### `time_warp N do ... end`

Shift time within a block. Sugar for `at [N]`.

```ruby
time_warp 0.5 do
  sample :hat_snap
end
```

---

### `density N do ... end`

Compress time by factor N -- all `sleep` values inside the block are divided by N.

```ruby
density 2 do
  play 60
  sleep 1   # actually sleeps 0.5 beats
  play 64
  sleep 1   # actually sleeps 0.5 beats
end
```

---

## 4. Effects

### `with_fx :name, opts do ... end`

Wrap a block of code in an audio effect. Effects can be nested.

```ruby
with_fx :reverb, room: 0.8 do
  with_fx :distortion, distort: 0.5 do
    play 50, release: 0.5
    sleep 0.5
  end
end
```

### Available FX

All FX share common parameters: `amp`, `amp_slide`, `mix`, `mix_slide`, `pre_amp`, `pre_amp_slide`

| FX | Key Parameters | Description |
|----|---------------|-------------|
| `:reverb` | `room`, `damp` | Room reverb |
| `:echo` | `phase`, `decay`, `max_phase` | Echo/delay with feedback |
| `:delay` | `phase`, `decay`, `max_phase` | Delay line |
| `:distortion` | `distort` | Waveshaping distortion |
| `:slicer` | `phase`, `wave`, `pulse_width`, `smooth`, `probability` | Amplitude slicer |
| `:wobble` | `phase`, `wave`, `cutoff_min`, `cutoff_max`, `res` | Wobble bass filter |
| `:ixi_techno` | `phase`, `cutoff_min`, `cutoff_max`, `res` | Techno filter sweep |
| `:compressor` | `threshold`, `clamp_time`, `slope_above`, `slope_below`, `relax_time` | Dynamics compressor |
| `:rlpf` | `cutoff`, `res` | Resonant low-pass filter |
| `:rhpf` | `cutoff`, `res` | Resonant high-pass filter |
| `:hpf` | `cutoff` | High-pass filter |
| `:lpf` | `cutoff` | Low-pass filter |
| `:normaliser` | `level` | Amplitude normaliser |
| `:pan` | `pan` | Stereo panning |
| `:band_eq` | `freq`, `res`, `db` | Band EQ |
| `:flanger` | `phase`, `wave`, `depth`, `decay`, `feedback`, `delay` | Flanger |
| `:krush` | `cutoff`, `res`, `gain` | Lo-fi crush |
| `:bitcrusher` | `sample_rate`, `bits`, `cutoff` | Bit reduction |
| `:ring_mod` | `freq`, `mod_amp` | Ring modulation |
| `:chorus` | `phase`, `decay`, `max_phase` | Chorus |
| `:octaver` | `super_amp`, `sub_amp`, `subsub_amp` | Octave doubler |
| `:vowel` | `vowel_sound`, `voice` | Vowel formant filter |
| `:tanh` | `krunch` | Hyperbolic tangent distortion |
| `:gverb` | `spread`, `damp`, `room`, `release`, `ref_level`, `tail_level` | Large-space reverb |
| `:pitch_shift` | `pitch`, `window_size`, `pitch_dis`, `time_dis` | Pitch shifting |
| `:whammy` | `transpose`, `max_delay_time`, `deltime`, `grainsize` | Whammy bar pitch bend |
| `:tremolo` | `phase`, `wave`, `depth` | Amplitude tremolo |
| `:record` | `buffer` | Record to buffer |
| `:sound_out` | `output` | Route to output |
| `:sound_out_stereo` | `output` | Stereo route to output |
| `:level` | _(common only)_ | Gain stage |
| `:mono` | _(common only)_ | Stereo to mono |
| `:autotuner` | `note` | Pitch correction |

All slide-able parameters also accept a `_slide` variant (e.g., `cutoff_slide: 0.5`).

---

## 5. Control and Slides

### Assign a node reference

```ruby
s = play 60, note_slide: 1, release: 4
```

The variable `s` captures a node reference for later use with `control`.

---

### `control ref, opts`

Slide parameters on a running synth node to new values.

```ruby
s = play 60, note_slide: 1, release: 4
sleep 1
control s, note: 65
sleep 1
control s, note: 72
```

**Slide parameters:** `note_slide`, `amp_slide`, `pan_slide`, `cutoff_slide` -- set the glide time in beats.

---

## 6. Synths

All synths share common parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `note` | 52 | MIDI note number |
| `amp` | 1 | Amplitude (0..1+) |
| `pan` | 0 | Stereo pan (-1..1) |
| `attack` | 0 | Attack time (s) |
| `decay` | 0 | Decay time (s) |
| `sustain` | 0 | Sustain time (s) |
| `release` | 1 | Release time (s) |
| `attack_level` | 1 | Peak level after attack |
| `decay_level` | sustain_level | Level after decay |
| `sustain_level` | 1 | Level during sustain |
| `note_slide` | 0 | Note glide time |
| `amp_slide` | 0 | Amp glide time |
| `pan_slide` | 0 | Pan glide time |
| `cutoff` | 0 | Filter cutoff (MIDI note) |
| `cutoff_slide` | 0 | Cutoff glide time |
| `res` | 0 | Filter resonance (0..1) |

### Synth List

| Synth | Extra Parameters | Description |
|-------|-----------------|-------------|
| `:beep` | -- | Simple sine beep (default) |
| `:saw` | -- | Sawtooth wave |
| `:sine` | -- | Pure sine wave |
| `:square` | -- | Square wave |
| `:tri` | -- | Triangle wave |
| `:pulse` | `pulse_width`, `pulse_width_slide` | Variable-width pulse |
| `:noise` | -- | White noise |
| `:pnoise` | -- | Pink noise |
| `:bnoise` | -- | Brown noise |
| `:gnoise` | -- | Grey noise |
| `:cnoise` | -- | Clip noise |
| `:prophet` | -- | Prophet-5 style pad |
| `:tb303` | `wave`, `pulse_width`, `pulse_width_slide` | Acid bass (303 emulation) |
| `:supersaw` | `detune`, `detune_slide` | Detuned supersaw |
| `:dsaw` | `detune`, `detune_slide` | Detuned saw |
| `:dpulse` | `detune`, `detune_slide`, `pulse_width`, `pulse_width_slide` | Detuned pulse |
| `:dtri` | `detune`, `detune_slide` | Detuned triangle |
| `:pluck` | `noise_amp`, `max_delay_time`, `pluck_decay` | Karplus-Strong pluck |
| `:pretty_bell` | -- | Pretty bell tone |
| `:piano` | `vel`, `hard`, `stereo_width` | Sampled piano |
| `:fm` | `divisor`, `depth`, `depth_slide`, `divisor_slide` | FM synthesis |
| `:mod_fm` | `divisor`, `depth`, `depth_slide`, `divisor_slide`, `mod_phase`, `mod_range`, `mod_phase_slide` | Modulated FM |
| `:mod_saw` | `mod_phase`, `mod_range`, `mod_phase_slide`, `mod_width` | Modulated saw |
| `:mod_pulse` | `mod_phase`, `mod_range`, `mod_phase_slide`, `mod_width`, `pulse_width`, `pulse_width_slide` | Modulated pulse |
| `:mod_tri` | `mod_phase`, `mod_range`, `mod_phase_slide`, `mod_width` | Modulated triangle |
| `:chipbass` | -- | 8-bit bass |
| `:chiplead` | `width` | 8-bit lead |
| `:chipnoise` | `freq_band` | 8-bit noise |
| `:dark_ambience` | `ring`, `room`, `reverb_time` | Dark ambient pad |
| `:hollow` | `noise`, `norm` | Hollow resonant pad |
| `:growl` | -- | Growling bass |
| `:zawa` | `wave`, `phase`, `phase_offset`, `invert_wave`, `range`, `disable_wave` | Zawa synth |
| `:blade` | `vibrato_rate`, `vibrato_depth`, `vibrato_delay`, `vibrato_onset` | Blade Runner-style pad |
| `:tech_saws` | -- | Tech house saws |
| `:sound_in` | `input` | Live audio input (mono) |
| `:sound_in_stereo` | `input` | Live audio input (stereo) |

---

## 7. Samples

### Kicks
| Sample | Description |
|--------|-------------|
| `:bd_haus` | House kick |
| `:bd_zum` | Zum kick |
| `:bd_808` | 808 kick |
| `:bd_boom` | Booming kick |
| `:bd_klub` | Club kick |
| `:bd_pure` | Pure kick |
| `:bd_tek` | Tek kick |

### Snares
| Sample | Description |
|--------|-------------|
| `:sn_dub` | Dub snare |
| `:sn_dolf` | Dolf snare |
| `:sn_zome` | Zome snare |
| `:sn_generic` | Generic snare |

### Hi-Hats
| Sample | Description |
|--------|-------------|
| `:hat_snap` | Snappy hat |
| `:hat_cab` | Cab hat |
| `:hat_raw` | Raw hat |

### Loops
| Sample | Description |
|--------|-------------|
| `:loop_amen` | Amen break |
| `:loop_breakbeat` | Breakbeat loop |
| `:loop_compus` | Compus loop |
| `:loop_garzul` | Garzul loop |
| `:loop_industrial` | Industrial loop |

### Ambient
| Sample | Description |
|--------|-------------|
| `:ambi_choir` | Choir pad |
| `:ambi_dark_woosh` | Dark whoosh |
| `:ambi_drone` | Drone |
| `:ambi_glass_hum` | Glass hum |
| `:ambi_lunar_land` | Lunar landing |

### Bass
| Sample | Description |
|--------|-------------|
| `:bass_dnb_f` | DnB bass (F) |
| `:bass_hit_c` | Bass hit (C) |
| `:bass_thick_c` | Thick bass (C) |
| `:bass_voxy_c` | Voxy bass (C) |

### Electronic
| Sample | Description |
|--------|-------------|
| `:elec_beep` | Electronic beep |
| `:elec_bell` | Electronic bell |
| `:elec_blip` | Electronic blip |
| `:elec_chime` | Electronic chime |
| `:elec_ping` | Electronic ping |

### Percussion
| Sample | Description |
|--------|-------------|
| `:perc_bell` | Percussion bell |
| `:perc_snap` | Percussion snap |
| `:perc_swoosh` | Percussion swoosh |

---

## 8. Control Flow

### `if` / `elsif` / `else` / `end`

```ruby
if one_in(3)
  play 72
elsif one_in(2)
  play 60
else
  play 48
end
```

### `unless condition ... end`

```ruby
unless one_in(4)
  play 60
end
```

### Trailing conditionals

```ruby
play 60 if one_in(2)
sample :hat_snap unless one_in(3)
```

### `begin` / `rescue` / `ensure` / `end`

```ruby
begin
  play 60
rescue => e
  puts e
ensure
  sleep 1
end
```

### `define :name do |args| ... end`

Define a reusable function. The builder context `b` is injected automatically.

```ruby
define :bass_hit do |note|
  use_synth :tb303
  play note, release: 0.2, cutoff: 70
end

live_loop :bass do
  bass_hit :e2
  sleep 0.5
end
```

### `.each do |x| ... end`

Iterate over an array or ring.

```ruby
[60, 64, 67].each do |n|
  play n
  sleep 0.25
end
```

### `.map { |x| expr }`

Transform elements. Also available as `.collect`.

```ruby
notes = [60, 64, 67].map { |n| n + 12 }
```

### `.select { |x| expr }`

Filter elements.

```ruby
high_notes = scale(:c4, :major).select { |n| n > 65 }
```

### `.reject { |x| expr }`

Reject matching elements (inverse of select).

```ruby
low_notes = scale(:c4, :major).reject { |n| n > 65 }
```

---

## 9. Music Theory

### `chord(root, type)`

Build a chord. Returns a Ring of MIDI note numbers.

```ruby
play chord(:c4, :major)        # [60, 64, 67]
play chord(:e3, :minor7)       # [52, 55, 59, 62]
```

#### All Chord Types

| Type | Intervals | Notes |
|------|-----------|-------|
| `:major` | 0, 4, 7 | |
| `:minor` | 0, 3, 7 | |
| `:dim` / `:diminished` | 0, 3, 6 | |
| `:aug` / `:augmented` | 0, 4, 8 | |
| `:dom7` / `:7` | 0, 4, 7, 10 | Dominant 7th |
| `:major7` / `:M7` | 0, 4, 7, 11 | Major 7th |
| `:minor7` / `:m7` | 0, 3, 7, 10 | Minor 7th |
| `:dim7` | 0, 3, 6, 9 | Diminished 7th |
| `:aug7` | 0, 4, 8, 10 | Augmented 7th |
| `:halfdim` / `:m7-5` | 0, 3, 6, 10 | Half-diminished |
| `:m9` | 0, 3, 7, 10, 14 | Minor 9th |
| `:dom9` / `:9` | 0, 4, 7, 10, 14 | Dominant 9th |
| `:major9` / `:M9` | 0, 4, 7, 11, 14 | Major 9th |
| `:minor11` | 0, 3, 7, 10, 14, 17 | Minor 11th |
| `:dom11` / `:11` | 0, 4, 7, 10, 14, 17 | Dominant 11th |
| `:minor13` | 0, 3, 7, 10, 14, 17, 21 | Minor 13th |
| `:dom13` / `:13` | 0, 4, 7, 10, 14, 17, 21 | Dominant 13th |
| `:sus2` | 0, 2, 7 | Suspended 2nd |
| `:sus4` | 0, 5, 7 | Suspended 4th |
| `:power` / `:5` | 0, 7 | Power chord |
| `:1` | 0 | Unison |
| `:+5` / `:m_plus_5` | 0, 4, 8 / 0, 3, 8 | Augmented variants |
| `:sus2sus4` | 0, 2, 5, 7 | |
| `:add9` | 0, 4, 7, 14 | |
| `:add11` | 0, 4, 7, 17 | |
| `:add13` | 0, 4, 7, 21 | |
| `:madd9` | 0, 3, 7, 14 | Minor add 9 |
| `:madd11` | 0, 3, 7, 17 | Minor add 11 |
| `:madd13` | 0, 3, 7, 21 | Minor add 13 |
| `:6` | 0, 4, 7, 9 | Major 6th |
| `:m6` | 0, 3, 7, 9 | Minor 6th |
| `:6_9` | 0, 4, 7, 9, 14 | 6/9 |
| `:m6_9` | 0, 3, 7, 9, 14 | Minor 6/9 |

---

### `scale(root, type)`

Build a scale. Returns a Ring of MIDI note numbers (includes octave note at end).

```ruby
scale(:c4, :minor_pentatonic)  # [60, 63, 65, 67, 70, 72]
scale(:c4, :major)             # [60, 62, 64, 65, 67, 69, 71, 72]
```

#### All Scale Types

| Scale | Intervals |
|-------|-----------|
| `:major` | 0, 2, 4, 5, 7, 9, 11 |
| `:minor` / `:natural_minor` / `:aeolian` | 0, 2, 3, 5, 7, 8, 10 |
| `:harmonic_minor` | 0, 2, 3, 5, 7, 8, 11 |
| `:melodic_minor` | 0, 2, 3, 5, 7, 9, 11 |
| `:dorian` | 0, 2, 3, 5, 7, 9, 10 |
| `:phrygian` | 0, 1, 3, 5, 7, 8, 10 |
| `:lydian` | 0, 2, 4, 6, 7, 9, 11 |
| `:mixolydian` | 0, 2, 4, 5, 7, 9, 10 |
| `:locrian` | 0, 1, 3, 5, 6, 8, 10 |
| `:minor_pentatonic` | 0, 3, 5, 7, 10 |
| `:major_pentatonic` | 0, 2, 4, 7, 9 |
| `:blues` | 0, 3, 5, 6, 7, 10 |
| `:chromatic` | 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 |
| `:whole_tone` / `:whole` | 0, 2, 4, 6, 8, 10 |
| `:diminished` / `:octatonic` | 0, 2, 3, 5, 6, 8, 9, 11 |
| `:hex_major6` | 0, 2, 4, 5, 7, 9 |
| `:hex_dorian` | 0, 2, 3, 5, 7, 10 |
| `:hex_phrygian` | 0, 1, 3, 5, 8, 10 |
| `:hex_major7` | 0, 2, 4, 7, 9, 11 |
| `:hex_sus` | 0, 2, 5, 7, 9, 10 |
| `:hex_aeolian` | 0, 3, 5, 7, 8, 10 |
| `:hungarian_minor` / `:gypsy` | 0, 2, 3, 6, 7, 8, 11 |
| `:hirajoshi` | 0, 4, 6, 7, 11 |
| `:iwato` | 0, 1, 5, 6, 10 |
| `:kumoi` | 0, 2, 3, 7, 9 |
| `:in_sen` | 0, 1, 5, 7, 10 |
| `:yo` | 0, 3, 5, 7, 10 |
| `:pelog` | 0, 1, 3, 7, 8 |
| `:chinese` | 0, 4, 6, 7, 11 |
| `:egyptian` | 0, 2, 5, 7, 10 |
| `:prometheus` | 0, 2, 4, 6, 9, 10 |
| `:scriabin` | 0, 1, 4, 7, 9 |
| `:indian` | 0, 4, 5, 7, 8, 11 |
| `:enigmatic` | 0, 1, 4, 6, 8, 10, 11 |
| `:spanish` | 0, 1, 3, 4, 5, 7, 8, 10 |
| `:neapolitan_major` | 0, 1, 3, 5, 7, 9, 11 |
| `:neapolitan_minor` | 0, 1, 3, 5, 7, 8, 11 |
| `:bebop_major` | 0, 2, 4, 5, 7, 8, 9, 11 |
| `:bebop_minor` | 0, 2, 3, 5, 7, 8, 10, 11 |
| `:bebop_dominant` | 0, 2, 4, 5, 7, 9, 10, 11 |
| `:super_locrian` | 0, 1, 3, 4, 6, 8, 10 |
| `:persian` | 0, 1, 4, 5, 6, 8, 11 |
| `:arabic` | 0, 2, 4, 5, 6, 8, 10 |
| `:japanese` | 0, 1, 5, 7, 8 |
| `:lydian_minor` | 0, 2, 4, 6, 7, 8, 10 |

---

### `chord_invert(chord, N)`

Invert a chord by shifting the lowest N notes up an octave.

```ruby
play chord_invert(chord(:c4, :major), 1)  # first inversion: [64, 67, 72]
play chord_invert(chord(:c4, :major), 2)  # second inversion: [67, 72, 76]
```

---

### `note(:c4)`

Convert a note name to MIDI number.

```ruby
puts note(:c4)   # 60
puts note(:a3)   # 57
```

---

### `note_range(:c3, :c5)`

Generate a Ring of all MIDI notes between two endpoints (inclusive).

```ruby
notes = note_range(:c3, :c5)  # Ring([48, 49, 50, ..., 72])
```

---

## 10. Data Structures

### `ring(values...)`

Create a Ring -- a circular array that wraps indices so they never go out of bounds.

```ruby
r = ring(60, 64, 67, 72)
play r[0]    # 60
play r[4]    # 60 (wraps!)
play r[-1]   # 72
```

---

### `.tick` / `.look`

Auto-incrementing index into a ring. `.tick` advances, `.look` reads without advancing.

```ruby
live_loop :arp do
  notes = ring(60, 64, 67, 72)
  play notes.tick
  sleep 0.25
end
```

---

### `knit(value, count, ...)`

Build a Ring by repeating each value a specified number of times.

```ruby
knit(:c4, 2, :e4, 1, :g4, 1)  # Ring([:c4, :c4, :e4, :g4])
```

---

### `range(start, end, step)`

Generate a Ring of numbers. Excludes the end value.

```ruby
range(1, 5)      # Ring([1, 2, 3, 4])
range(0, 10, 2)  # Ring([0, 2, 4, 6, 8])
```

---

### `line(start, finish, steps)`

Linear interpolation between two values.

```ruby
line(60, 72, 5)  # Ring([60, 63, 66, 69, 72])
```

---

### `spread(hits, total, rotation)`

Euclidean rhythm -- distribute hits as evenly as possible across total steps. Returns a Ring of booleans.

```ruby
spread(3, 8)    # Ring([true, false, false, true, false, false, true, false])
spread(5, 8)    # Ring([true, false, true, true, false, true, true, false])
spread(3, 8, 1) # rotated by 1 step
```

```ruby
live_loop :euclidean do
  pattern = spread(5, 8)
  8.times do |i|
    sample :bd_tek if pattern[i]
    sleep 0.25
  end
end
```

---

### Ring Methods

| Method | Description | Example |
|--------|-------------|---------|
| `.reverse` | Reverse the ring | `ring(1,2,3).reverse` -> `[3,2,1]` |
| `.shuffle` | Randomly reorder | `ring(1,2,3).shuffle` |
| `.pick(n)` | Pick n random elements | `ring(1,2,3).pick(5)` |
| `.take(n)` | First n elements | `ring(1,2,3,4).take(2)` -> `[1,2]` |
| `.drop(n)` | Drop first n elements | `ring(1,2,3,4).drop(2)` -> `[3,4]` |
| `.stretch(n)` | Repeat each element n times | `ring(1,2).stretch(3)` -> `[1,1,1,2,2,2]` |
| `.mirror` | Palindrome | `ring(1,2,3).mirror` -> `[1,2,3,2,1]` |
| `.repeat(n)` | Repeat whole ring n times | `ring(1,2).repeat(2)` -> `[1,2,1,2]` |
| `.choose` | Random element | `ring(1,2,3).choose` |
| `.tick` | Next element (auto-increment) | `ring(1,2,3).tick` |
| `.look` | Current element (no advance) | `ring(1,2,3).look` |

---

## 11. Random

All random functions use a seeded Mersenne Twister (MT19937). They are **deterministic and seed-stable within SonicPi.js** — the same seed always produces the same sequence here. The values are **not** identical to desktop Sonic Pi, though: desktop replays a frozen random-number table rather than a live PRNG, so `choose` / `rrand_i` / etc. draw different elements cross-engine — a randomness-driven piece sounds different from desktop (same shape, different notes). Matching desktop's exact random stream is a deliberate v1 non-goal.

### `rrand(min, max)`

Random float between min and max (inclusive).

```ruby
play rrand(48, 72)
```

---

### `rrand_i(min, max)`

Random integer between min and max (inclusive).

```ruby
play rrand_i(48, 72)
```

---

### `rand(max)`

Random float between 0 and max (default 1).

```ruby
sleep rand(0.5)
```

---

### `rand_i(max)`

Random integer between 0 and max-1.

```ruby
play 60 + rand_i(12)
```

---

### `choose(array)`

Pick a random element from an array or ring.

```ruby
play choose(scale(:c4, :minor_pentatonic))
```

---

### `dice(sides)`

Roll a die: random integer from 1 to sides.

```ruby
play 60 if dice(6) > 4
```

---

### `one_in(N)`

Returns true with probability 1/N.

```ruby
sample :hat_snap if one_in(3)
```

---

### `use_random_seed N`

Reset the random seed for deterministic sequences. Same seed produces same sequence every time.

```ruby
use_random_seed 42
puts rrand_i(0, 100)  # always the same number
```

---

## 12. Output

### `puts` / `print`

Print to the log console. Both work identically.

```ruby
puts "hello world"
puts 42
puts chord(:c4, :major)
```

---

### String Interpolation

Ruby `#{}` interpolation is automatically converted to JS template literals.

```ruby
n = 60
puts "Playing note #{n}"   # "Playing note 60"
```

---

## 13. What's NOT Supported (vs Desktop Sonic Pi)

These features exist in desktop Sonic Pi but are **not available** in SonicPi.js:

| Feature | Reason |
|---------|--------|
| `osc "/path", value` | No OSC output. Use the JS API for external communication. |
| `midi note, channel: N` | No MIDI DSL. Use the MidiBridge API instead. |
| `run_file "path"` | No filesystem access in browser. |
| `load_buffer "path"` | No filesystem access in browser. |
| `live_audio :name, input: N` | Named audio buses not supported. Basic mic input only. |
| `beat_stretch:` / `pitch_stretch:` | Approximate only -- no granular time-stretching in WebAudio. |
| `with_fx :record` / audio buffer routing | Limited -- no named audio buses. |
| Multiple audio outputs | Single stereo output only. |
| `run_code` / `eval` | Security restricted in browser sandbox. |
| Custom SynthDefs | Cannot load arbitrary SuperCollider SynthDefs. Uses the built-in set. |

---

## Examples

### Minimal Techno

```ruby
use_bpm 130

live_loop :kick do
  sample :bd_haus, amp: 1.5
  sleep 1
end

live_loop :hats do
  pattern = spread(7, 16)
  16.times do |i|
    sample :hat_snap, amp: 0.4 if pattern[i]
    sleep 0.25
  end
end

live_loop :acid do
  use_synth :tb303
  notes = ring(:e2, :e2, :e3, :e2, :g2, :e2, :a2, :e2)
  play notes.tick, release: 0.2, cutoff: rrand(40, 120), res: 0.3
  sleep 0.25
end
```

### Ambient Pad with FX

```ruby
live_loop :pad do
  with_fx :reverb, room: 0.8 do
    use_synth :prophet
    play chord(:e3, :minor), release: 4, amp: 0.6
    sleep 4
  end
end
```

### Synchronized Loops

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  cue :tick
  sample :sn_dub
  sleep 0.5
end

live_loop :bass, sync: :tick do
  use_synth :tb303
  play :e2, release: 0.3, cutoff: 70
  sleep 0.5
end
```
