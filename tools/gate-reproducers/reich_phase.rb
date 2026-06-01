# Gate reproducer for reich_phase.rb (#377 / #428)
# WHY: the original runs two live_loops (:slow sleep 0.3, :faster sleep 0.295)
# ticking the SAME ring — Steve Reich's Piano Phase. The loops drift, so notes
# land near-simultaneously and which side "wins" each onset is timing-jitter
# dependent, not engine semantics. The engine is provably correct on the long
# prefix (first 12 notes identical desktop↔web) but the comparator marks the
# full piece INCONCL because the post-drift onset ordering isn't comparable.
# PROJECTION: ONE loop ticking the SAME ring, monophonic + staccato so every
# note has a clean onset. Grades the exact engine logic under test (ring
# iteration + tick + note-name resolution), free of the phase collision the
# comparator can't order.
# EXPECTED: 64,66,71,73,74,66,64,73,71,66,74,73
#           (E4,Fs4,B4,Cs5,D5,Fs4,E4,Cs5,B4,Fs4,D5,Cs5), repeated.
use_synth :beep
use_synth_defaults release: 0.05, amp: 1
notes = (ring :E4, :Fs4, :B4, :Cs5, :D5, :Fs4, :E4, :Cs5, :B4, :Fs4, :D5, :Cs5)
24.times do
  play notes.tick
  sleep 0.5
end
