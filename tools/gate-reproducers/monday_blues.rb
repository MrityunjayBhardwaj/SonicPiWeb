# Gate reproducer for monday_blues.rb (#376 / #407)
# WHY: the original has 3 live_loops (kick drums + :synths melody + snare). The
# heavy_kick dominates web's onset tracker while desktop's locks onto the sustained
# mod_saw — method asymmetry (desktop onset pc {3,4,5} vs web contour pc {0,2,4,5,7}),
# non-comparable, no Tier-1 verdict (#376).
# PROJECTION: isolate the DETERMINISTIC :synths melody — note(n, octave: 2) over the
# fixed ring (:F,:C,:D,:D,:G,:C,:D,:D) — monophonic + staccato so the onset tracker
# (conf 1) follows it. Grades the exact engine logic under test (note-name + octave
# resolution + ring), free of the percussion that caused the asymmetry.
# Uses :beep (not the original's :mod_saw): the engine logic under test is pitch
# resolution, which is synth-independent, and mod_saw's frequency modulation
# confuses the onset pitch-tracker by ~1 semitone (verified: web /s_new emits the
# exact correct notes 41,36,38,38,43,36,38,38 regardless of synth).
use_synth :beep
use_synth_defaults release: 0.05, amp: 1
notes = (ring :F, :C, :D, :D, :G, :C, :D, :D)
3.times do
  notes.each do |n|
    play note(n, octave: 2)
    sleep 0.5
  end
end
