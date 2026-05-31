#!/usr/bin/env bash
# repro-mod303-loop.sh — gold-standard #424 reproducer: loop capture.ts (which
# RECORDS audio via the Rec button — the exact method that caught the original
# silent runs) and count Peak:0 silent runs. Unlike observe-fx-tree.ts this
# exercises the MediaRecorder path; if the residual only shows here, recording
# load is part of the trigger.
#
# Usage: tools/repro-mod303-loop.sh [N] [durationMs]
set -u
N="${1:-30}"
DUR="${2:-5000}"
FILE="/tmp/mod_303_phade.rb"
REPORT=".captures/mod_303_phade.md"
silent=0
echo "[repro] $N runs, duration=${DUR}ms, file=$FILE"
for i in $(seq 1 "$N"); do
  npx tsx tools/capture.ts --file "$FILE" --duration "$DUR" >/dev/null 2>&1
  peak=$(grep -m1 '\*\*Peak:\*\*' "$REPORT" 2>/dev/null | sed -E 's/.*Peak:\*\* *//')
  if [ -z "$peak" ]; then peak="NO-REPORT"; fi
  mark=""
  # bash float compare via awk
  is_silent=$(awk -v p="$peak" 'BEGIN{ if (p+0 < 0.01) print 1; else print 0 }' 2>/dev/null)
  if [ "$is_silent" = "1" ]; then silent=$((silent+1)); mark=" *** SILENT ***"; fi
  printf "[run %2d] peak=%s%s\n" "$i" "$peak" "$mark"
done
echo "[repro] SUMMARY: $silent/$N silent"
