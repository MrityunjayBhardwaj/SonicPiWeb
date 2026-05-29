# Getting Started with SonicPi.js

SonicPi.js lets you make music by writing code in your browser. No downloads, no installs -- just open the page and start playing.

Based on [Sonic Pi](https://sonic-pi.net) by Sam Aaron.

---

## Launch

**Option A:** Run locally with Node.js:

```
npx sonicpijs
```

**Option B:** Visit [sonicpi.cc](https://sonicpi.cc) (hosted, zero install).

Once it loads, you will see a code editor with a welcome program already written.
Press **Run** (or **Ctrl+Enter**) to hear it. Press **Stop** (or **Escape**) to silence everything.

---

## Your First Beat

### Step 1: Play a single note

Type this into the editor and press Run:

```ruby
play 60
```

You should hear a beep. That is MIDI note 60 -- middle C.

### Step 2: Add timing

```ruby
play 60
sleep 0.5
play 64
sleep 0.5
play 67
```

`sleep 0.5` waits half a beat before playing the next note. Without sleep, all notes would fire at the same instant.

### Step 3: Add drums

```ruby
sample :bd_haus
sleep 0.5
sample :sn_dub
sleep 0.5
```

Samples are pre-recorded sounds. `:bd_haus` is a bass drum, `:sn_dub` is a snare.

### Step 4: Make it loop

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
```

`live_loop` repeats the code inside it forever. Give each loop a unique name (`:drums` here).

### Step 5: Live code!

While the loop is playing, change `0.5` to `0.25` and press Run again. The beat speeds up -- instantly. That is live coding. Change code while the music plays.

---

## Keybindings

| Shortcut | Action |
|----------|--------|
| **Ctrl+Enter** | Run code |
| **Escape** | Stop all sound |
| **Ctrl+/** | Toggle comment (add/remove `#`) |
| **Ctrl+Shift+S** | Export session log |

On macOS, **Cmd** works in place of **Ctrl**.

---

## Synths

Change the sound of `play` with `use_synth`. The default synth is `:beep`.

```ruby
use_synth :prophet
play 60
```

### Available Synths

| Synth | Description |
|-------|-------------|
| `:beep` | Simple sine wave (default) |
| `:saw` | Sawtooth wave, bright and buzzy |
| `:prophet` | Warm analog-style pad |
| `:tb303` | Acid bass synth with resonant filter |
| `:supersaw` | Thick detuned saw wave |
| `:pluck` | Plucked string, decays naturally |
| `:pretty_bell` | Clean bell tone |
| `:piano` | Acoustic piano model |
| `:dsaw` | Detuned saw pair |
| `:dpulse` | Detuned pulse pair |
| `:dtri` | Detuned triangle pair |
| `:fm` | FM synthesis, metallic tones |
| `:mod_fm` | Modulated FM synthesis |
| `:mod_saw` | Modulated sawtooth |
| `:mod_pulse` | Modulated pulse wave |
| `:mod_tri` | Modulated triangle wave |
| `:sine` | Pure sine wave |
| `:square` | Square wave, hollow sound |
| `:tri` | Triangle wave, soft and mellow |
| `:pulse` | Pulse wave with variable width |
| `:noise` | White noise |
| `:pnoise` | Pink noise (softer high end) |
| `:bnoise` | Brown noise (deep rumble) |
| `:gnoise` | Grey noise |
| `:cnoise` | Clip noise |
| `:chipbass` | 8-bit style bass |
| `:chiplead` | 8-bit style lead |
| `:chipnoise` | 8-bit style noise |
| `:dark_ambience` | Dark atmospheric texture |
| `:hollow` | Hollow, breathy tone |
| `:growl` | Growling bass |
| `:zawa` | Buzzy, evolving tone |
| `:blade` | Blade Runner-inspired pad |
| `:tech_saws` | Layered techno sawtooth |
| `:sound_in` | Live audio input (mono) |
| `:sound_in_stereo` | Live audio input (stereo) |

---

## Samples

Play pre-recorded sounds with `sample`. Each sample has a short name starting with a category prefix.

```ruby
sample :bd_haus
```

### Available Samples

**Bass Drums**

| Sample | Description |
|--------|-------------|
| `:bd_haus` | House kick drum |
| `:bd_zum` | Deep kick |
| `:bd_808` | Classic 808 kick |
| `:bd_boom` | Boomy kick |
| `:bd_klub` | Club kick |
| `:bd_pure` | Clean kick |
| `:bd_tek` | Tek kick |

**Snares**

| Sample | Description |
|--------|-------------|
| `:sn_dub` | Dubby snare |
| `:sn_dolf` | Dolph snare |
| `:sn_zome` | Zome snare |
| `:sn_generic` | Standard snare |

**Hi-Hats**

| Sample | Description |
|--------|-------------|
| `:hat_snap` | Snappy hi-hat |
| `:hat_cab` | Cab hi-hat |
| `:hat_raw` | Raw hi-hat |

**Loops**

| Sample | Description |
|--------|-------------|
| `:loop_amen` | The Amen break |
| `:loop_breakbeat` | Breakbeat loop |
| `:loop_compus` | Compus loop |
| `:loop_garzul` | Garzul loop |
| `:loop_industrial` | Industrial loop |

**Ambient**

| Sample | Description |
|--------|-------------|
| `:ambi_choir` | Choir pad |
| `:ambi_dark_woosh` | Dark whoosh |
| `:ambi_drone` | Drone tone |
| `:ambi_glass_hum` | Glass hum |
| `:ambi_lunar_land` | Lunar landing |

**Bass**

| Sample | Description |
|--------|-------------|
| `:bass_dnb_f` | Drum and bass hit (F) |
| `:bass_hit_c` | Bass hit (C) |
| `:bass_thick_c` | Thick bass (C) |
| `:bass_voxy_c` | Voxy bass (C) |

**Electronic**

| Sample | Description |
|--------|-------------|
| `:elec_beep` | Electronic beep |
| `:elec_bell` | Electronic bell |
| `:elec_blip` | Electronic blip |
| `:elec_chime` | Electronic chime |
| `:elec_ping` | Electronic ping |

**Percussion**

| Sample | Description |
|--------|-------------|
| `:perc_bell` | Percussion bell |
| `:perc_snap` | Finger snap |
| `:perc_swoosh` | Swoosh |

---

## Notes and Chords

### Playing Notes

There are three ways to specify a note:

```ruby
# MIDI number (60 = middle C)
play 60

# Note name
play :c4
play :fs3    # F sharp, octave 3
play :eb5    # E flat, octave 5

# Note with options
play :c4, amp: 0.5, release: 2
```

### Common Note Options

| Option | What it does | Example |
|--------|-------------|---------|
| `amp:` | Volume (0.0 to 1.0+) | `amp: 0.5` |
| `release:` | Fade-out time in beats | `release: 2` |
| `attack:` | Fade-in time in beats | `attack: 0.1` |
| `sustain:` | Hold time in beats | `sustain: 1` |
| `cutoff:` | Low-pass filter (0-130) | `cutoff: 80` |
| `res:` | Filter resonance (0-1) | `res: 0.5` |
| `pan:` | Stereo position (-1 to 1) | `pan: -0.5` |

### Chords

Play multiple notes at once:

```ruby
play chord(:c4, :major)
play chord(:a3, :minor7)
```

**Common chord types:** `major`, `minor`, `dim`, `aug`, `dom7`, `major7`, `minor7`, `dim7`, `sus2`, `sus4`, `power`

**All chord types:** `major`, `minor`, `dim`, `diminished`, `aug`, `augmented`, `dom7`, `7`, `major7`, `M7`, `minor7`, `m7`, `dim7`, `aug7`, `halfdim`, `m7-5`, `m9`, `dom9`, `9`, `major9`, `M9`, `minor11`, `dom11`, `11`, `minor13`, `dom13`, `13`, `sus2`, `sus4`, `power`, `1`, `5`, `+5`, `m_plus_5`, `sus2sus4`, `add9`, `add11`, `add13`, `madd9`, `madd11`, `madd13`, `6`, `m6`, `6_9`, `m6_9`

### Scales

Get a list of notes from a scale:

```ruby
play scale(:c4, :minor_pentatonic).choose
```

**Common scales:** `major`, `minor`, `minor_pentatonic`, `major_pentatonic`, `blues`, `dorian`, `mixolydian`

**All scales:** `major`, `minor`, `natural_minor`, `harmonic_minor`, `melodic_minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `aeolian`, `locrian`, `minor_pentatonic`, `major_pentatonic`, `blues`, `chromatic`, `whole_tone`, `whole`, `diminished`, `octatonic`, `hex_major6`, `hex_dorian`, `hex_phrygian`, `hex_major7`, `hex_sus`, `hex_aeolian`, `hungarian_minor`, `gypsy`, `hirajoshi`, `iwato`, `kumoi`, `in_sen`, `yo`, `pelog`, `chinese`, `egyptian`, `prometheus`, `scriabin`, `indian`, `enigmatic`, `spanish`, `neapolitan_major`, `neapolitan_minor`, `bebop_major`, `bebop_minor`, `bebop_dominant`, `super_locrian`, `persian`, `arabic`, `japanese`, `lydian_minor`

---

## FX (Effects)

Wrap code in `with_fx` to add effects:

```ruby
with_fx :reverb do
  play 60
  sleep 0.5
  play 64
end
```

Nest effects for chains:

```ruby
with_fx :reverb, room: 0.8 do
  with_fx :distortion, distort: 0.5 do
    play 50
  end
end
```

### Available FX

| Effect | Description |
|--------|-------------|
| `:reverb` | Room reverb (options: `room:`, `damp:`) |
| `:echo` | Repeating echo (options: `phase:`, `decay:`) |
| `:delay` | Delay line |
| `:distortion` | Overdrive distortion (options: `distort:`) |
| `:slicer` | Rhythmic volume gating (options: `phase:`) |
| `:wobble` | Wobble bass filter (options: `phase:`) |
| `:ixi_techno` | Techno resonant filter |
| `:compressor` | Dynamic range compressor |
| `:rlpf` | Resonant low-pass filter (options: `cutoff:`, `res:`) |
| `:rhpf` | Resonant high-pass filter (options: `cutoff:`, `res:`) |
| `:hpf` | High-pass filter (options: `cutoff:`) |
| `:lpf` | Low-pass filter (options: `cutoff:`) |
| `:normaliser` | Volume normalizer |
| `:pan` | Stereo panning (options: `pan:`) |
| `:band_eq` | Band EQ (options: `freq:`, `db:`) |
| `:flanger` | Flanger effect (options: `phase:`, `depth:`) |
| `:krush` | Bit crusher / lo-fi (options: `cutoff:`, `res:`) |
| `:bitcrusher` | Bit depth reduction (options: `bits:`, `sample_rate:`) |
| `:ring_mod` | Ring modulation (options: `freq:`) |
| `:chorus` | Chorus effect |
| `:octaver` | Octave doubler |
| `:vowel` | Vowel formant filter (options: `vowel_sound:`) |
| `:tanh` | Hyperbolic tangent distortion |
| `:gverb` | Large-space reverb (options: `roomsize:`, `revtime:`) |
| `:pitch_shift` | Pitch shifter (options: `pitch:`) |
| `:whammy` | Pitch bend effect (options: `pitch:`) |
| `:tremolo` | Volume tremolo (options: `phase:`, `depth:`) |
| `:record` | Record to buffer |
| `:sound_out` | Route audio out (mono) |
| `:sound_out_stereo` | Route audio out (stereo) |
| `:level` | Volume control (options: `amp:`) |
| `:mono` | Stereo to mono |
| `:autotuner` | Automatic pitch correction |

---

## Control Flow

### Conditional play

```ruby
live_loop :maybe do
  if one_in(3)
    sample :bd_haus
  else
    sample :hat_snap
  end
  sleep 0.25
end
```

### Repetition

```ruby
3.times do
  play 60
  sleep 0.25
end
```

### Iterating

```ruby
[:c4, :e4, :g4, :c5].each do |note|
  play note
  sleep 0.25
end
```

### Reusable functions

```ruby
define :bass_hit do |note|
  use_synth :tb303
  play note, release: 0.2, cutoff: 70
end

bass_hit :e2
sleep 0.5
bass_hit :g2
```

### Time compression

```ruby
density 2 do
  # Everything inside plays twice as fast
  play 60
  sleep 0.5
  play 64
  sleep 0.5
end
```

### Parallel voices

```ruby
in_thread do
  # This runs at the same time as the code below
  play 60
  sleep 1
end

play 72
sleep 1
```

### Time offsets

```ruby
at [0, 0.5, 1, 1.5] do |t|
  play 60
end
```

### Coordinating loops

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  cue :tick
  sample :sn_dub
  sleep 0.5
end

live_loop :bass do
  sync :tick
  use_synth :tb303
  play :e2, release: 0.3
  sleep 0.5
end
```

`cue` sends a signal. `sync` waits for it. This keeps loops locked together.

---

## Random and Variation

Randomness makes patterns feel alive:

```ruby
# Random float between 60 and 72
play rrand(60, 72)

# Random integer between 60 and 72
play rrand_i(60, 72)

# Pick one from a list
play choose([:c4, :e4, :g4])

# True with 1-in-3 chance
sample :hat_snap if one_in(3)

# Reproducible randomness (same "random" sequence every run)
use_random_seed 42
```

### List operations

```ruby
notes = [:c4, :e4, :g4, :b4]

notes.shuffle    # Random order
notes.reverse    # Backwards
notes.pick(3)    # Pick 3 random elements
```

---

## Recording

1. Click the **Rec** button in the toolbar (it will turn red).
2. Press **Run** and play your music.
3. Click **Rec** again to stop recording.
4. A WAV file will be saved to your downloads folder.

---

## 10 Buffers

The tab bar at the top shows 10 numbered buffers (0-9). Each buffer holds different code, like having 10 separate scratch pads.

- Click a buffer tab to switch to it.
- Each buffer remembers its code between switches.
- Use different buffers for different experiments, or combine them in a performance.

---

## Examples

The Examples menu contains 10 built-in programs organized by difficulty. Load one to learn a technique, then modify it.

### Beginner

| Example | What it teaches |
|---------|----------------|
| **Hello Beep** | The simplest program -- three notes in sequence |
| **Basic Beat** | A four-on-the-floor drum pattern with kick and snare |
| **Ambient Pad** | Slow chord washes with reverb using `:prophet` synth |

### Intermediate

| Example | What it teaches |
|---------|----------------|
| **Arpeggio** | Rising notes using `ring` and `tick` -- a signature Sonic Pi pattern |
| **Euclidean Rhythm** | Spreading hits evenly across steps with `spread` |
| **Random Melody** | Seeded randomness for deterministic but surprising melodies |
| **Multi-Layer** | Three simultaneous loops -- drums, bass, and lead together |

### Advanced

| Example | What it teaches |
|---------|----------------|
| **Sync/Cue** | Two loops synchronized -- the bass waits for the drums |
| **FX Chain** | Nested effects -- reverb wrapping distortion |
| **Minimal Techno** | A full techno track with Euclidean hi-hats and acid bass |

---

## Differences from Desktop Sonic Pi

SonicPi.js aims to be compatible with the desktop version's Ruby DSL. Here is what to know:

**Works the same:**
- `play`, `sleep`, `sample`, `live_loop`, `in_thread`
- `use_synth`, `with_fx`, `use_bpm`
- `chord`, `scale`, `ring`, `tick`
- `sync`, `cue`, `at`, `density`
- `spread` (Euclidean rhythms)
- Ruby-style syntax (`:symbols`, `do...end` blocks, `.times`, `.each`)

**Different:**
- Runs in the browser using WebAudio + SuperSonic (scsynth compiled to WebAssembly), not a native SuperCollider server.
- Synth and sample sets are limited to those listed above. Desktop Sonic Pi has a larger library.
- **Random values differ from desktop.** `rrand`, `choose`, `one_in`, `use_random_seed` etc. are fully deterministic and seed-stable *within* SonicPi.js — the same seed always produces the same sequence here. But the actual values are **not** identical to desktop Sonic Pi: desktop replays a frozen random-number table, while SonicPi.js computes a live Mersenne Twister (MT19937). So a randomness-driven piece (e.g. `play scale(:c, :minor).choose`) sounds *different* from desktop — same shape, different notes. Matching desktop's exact random stream is a deliberate non-goal for v1.
- Audio latency depends on your browser. Chrome typically performs best.
- MIDI and OSC output are not yet supported.
- `run_file` and `load_sample` from disk are not available in the browser.

---

## Troubleshooting

**No sound?**
- Click Run (or press Ctrl+Enter). Browsers require a user gesture before playing audio.
- Check that your system volume is up and the correct audio output is selected.

**Error message in the console?**
- Read it! Error messages are written in plain language and usually tell you exactly what is wrong.
- "Unknown synth" or "Unknown sample" means you used a name that is not in the lists above. Check your spelling.

**Code runs but sounds wrong?**
- Make sure every `play` or `sample` is followed by a `sleep`. Without sleep, everything plays at once.
- Check your `live_loop` has a `sleep` inside it. A loop with no sleep will freeze the browser.

**Audio glitches or dropouts?**
- Close other tabs and applications to free up CPU.
- Try a longer `sleep` value to reduce the number of simultaneous sounds.
- Chrome generally has the best WebAudio performance.
