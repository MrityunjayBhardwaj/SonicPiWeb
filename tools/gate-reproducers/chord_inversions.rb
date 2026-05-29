# Gate reproducer for chord_inversions.rb (#374 / #407)
# WHY: the original plays play_chord arpeggios that change inversion every 0.25s.
# The contour pitch-tracker cannot order polyphonic chord material — both sides
# emit out-of-set noise (verified: desktop pc-set {0,4,5,6,7,8,9,10,11} vs web
# {0,1,4,5,8,9,10,11}, neither clean). No affirmative MATCH is extractable.
# PROJECTION: same chord_degree(d,:c,:major,3,invert:i) math, arpeggiated +
# staccato so the onset tracker (conf 1) catches every note. This grades the
# exact engine logic under test (chord_degree + inversion) on gradeable material.
# PROVEN: 15-note onset-mode PITCH-MATCH (48,52,55,52,55,60,55,60,64,60,64,67,64,67,72).
use_synth :beep
use_synth_defaults release: 0.05, amp: 1
[1, 3, 6, 4].each do |d|
  (range -3, 3).each do |i|
    (chord_degree d, :c, :major, 3, invert: i).each do |n|
      play n
      sleep 0.5
    end
  end
end
