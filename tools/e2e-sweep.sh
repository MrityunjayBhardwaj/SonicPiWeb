#!/bin/bash
# Run all e2e_test_suite fixtures through the desktop↔web comparator.
# Writes per-fixture sidecar JSON + spectrogram into .captures/e2e-sweep/.
#
# SP60 mitigation: Sonic Pi.app's daemon gets stuck after ~6 consecutive
# recording_save captures (no WAV produced). Restart the app every
# E2E_RESTART_INTERVAL fixtures to keep the daemon healthy.
#
# Usage:
#   bash tools/e2e-sweep.sh                          # default 20s per fixture
#   E2E_DURATION_MS=15000 bash tools/e2e-sweep.sh    # override duration
#   E2E_RESTART_INTERVAL=3 bash tools/e2e-sweep.sh   # tighter restart cadence
set -e

SUITE_DIR="/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/tools/audio_comparison/e2e_test_suite"
OUT_DIR="/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/e2e-sweep"
DURATION_MS="${E2E_DURATION_MS:-20000}"
RESTART_INTERVAL="${E2E_RESTART_INTERVAL:-5}"
mkdir -p "$OUT_DIR"

cd /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb

restart_sonic_pi() {
  echo "  ↻ restarting Sonic Pi.app (SP60 mitigation)..."
  pkill -f "Sonic Pi.app" 2>/dev/null || true
  sleep 1.5
  open -a "Sonic Pi"
  # Poll for scsynth boot
  for i in {1..30}; do
    sleep 0.5
    if pgrep -f "scsynth -u" >/dev/null 2>&1; then
      sleep 2.5  # let scsynth settle past first /s_new race
      echo "  ↻ ready"
      return 0
    fi
  done
  echo "  ✗ Sonic Pi.app failed to relaunch"
  return 1
}

FIXTURES=$(find "$SUITE_DIR" -maxdepth 1 -name "[0-9][0-9]_*.rb" | sort)
n_total=$(echo "$FIXTURES" | wc -l | tr -d ' ')
echo "▶ E2E sweep: $n_total fixtures, ${DURATION_MS}ms each (Sonic Pi restart every $RESTART_INTERVAL)"

idx=0
for fp in $FIXTURES; do
  idx=$((idx + 1))
  if [ $idx -gt 1 ] && [ $((idx % RESTART_INTERVAL)) -eq 1 ]; then
    restart_sonic_pi
  fi
  base=$(basename "$fp" .rb)
  json_out="$OUT_DIR/${base}.json"
  echo ""
  echo "[$idx/$n_total] $base"

  npx tsx tools/compare-desktop-vs-web.ts \
    --file "$fp" \
    --duration "$DURATION_MS" \
    --name "e2e-${base}" \
    --json-out "$json_out" 2>&1 | tail -8 || true

  if [ -f "$json_out" ]; then
    echo "  ✓ sidecar written: $json_out"
  else
    echo "  ✗ no sidecar — capture failed"
  fi
done

echo ""
echo "=== summary ==="
echo "  $(ls "$OUT_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ') sidecars in $OUT_DIR"
