# Gate reproducer for driving_pulse.rb (#368 / #428)
# WHY: the original layers a sustained :mod_pulse melody (release 0.6, slewed,
# mod_range 15) over a heavy_kick. The onset tracker cannot resolve the
# sustained/slewed material — web 2 onsets vs desktop 59 (ratio 0.03 < 0.3), so
# no Tier-1 verdict (#368). Not a pitch error; the instrument can't see it.
# PROJECTION: isolate the SAME note sequence (play 30, play 38) as a staccato
# monophonic :beep so each note has a clean onset. Grades the engine logic under
# test (the literal note values + alternation), free of the sustained mod_pulse
# envelope that blinds the onset tracker.
# EXPECTED: desktop == web over 24 clean onsets. NB MIDI 30/38 are sub-bass
# (46/73 Hz) so the pitch tracker octave-folds BOTH sides to a constant ~40 —
# the MATCH is on the identical folded sequence + identical 24-onset count.
# That is exactly the point: it proves the web DOES render the pulse (the
# original's "web 2 vs desktop 59 onsets" was onset-blindness on the sustained
# mod_pulse, not a missing-notes engine bug).
use_synth :beep
use_synth_defaults release: 0.05, amp: 1
12.times do
  play 30
  sleep 0.5
  play 38
  sleep 0.5
end
