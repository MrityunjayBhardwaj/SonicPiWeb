#!/bin/bash
# Run all community + in-thread-forum fixtures through the desktop ↔ web
# comparator. Writes per-fixture sidecar JSON + spectrogram into
# .captures/community-sweep/.
#
# Sister to tools/e2e-sweep.sh — same SP60 restart-every-N mitigation,
# different fixture pools, longer default duration (community pieces tend
# to evolve over more bars before showing their character).
#
# Usage:
#   bash tools/community-sweep.sh                          # default 30s/fixture
#   COMMUNITY_DURATION_MS=20000 bash tools/community-sweep.sh
#   COMMUNITY_RESTART_INTERVAL=3 bash tools/community-sweep.sh
#   COMMUNITY_DIRS="community" bash tools/community-sweep.sh   # subset
set -e

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
OUT_DIR="$REPO/.captures/community-sweep"
DURATION_MS="${COMMUNITY_DURATION_MS:-30000}"
RESTART_INTERVAL="${COMMUNITY_RESTART_INTERVAL:-5}"
# Comma-separated list of subdirs under tests/book-examples/.
DIRS="${COMMUNITY_DIRS:-community,in-thread-forum}"

mkdir -p "$OUT_DIR"
cd "$REPO"

restart_sonic_pi() {
  echo "  ↻ restarting Sonic Pi.app (SP60 mitigation)..."
  pkill -f "Sonic Pi.app" 2>/dev/null || true
  sleep 1.5
  open -a "Sonic Pi"
  for i in {1..30}; do
    sleep 0.5
    if pgrep -f "scsynth -u" >/dev/null 2>&1; then
      sleep 2.5
      echo "  ↻ ready"
      return 0
    fi
  done
  echo "  ✗ Sonic Pi.app failed to relaunch"
  return 1
}

# Collect fixtures across all configured dirs, sorted by full path.
FIXTURES=""
for dir in $(echo "$DIRS" | tr ',' ' '); do
  d="$REPO/tests/book-examples/$dir"
  if [ -d "$d" ]; then
    FIXTURES+=$'\n'$(find "$d" -maxdepth 1 -name "[0-9][0-9]_*.rb" | sort)
  fi
done
FIXTURES=$(echo "$FIXTURES" | grep -v "^$")
n_total=$(echo "$FIXTURES" | wc -l | tr -d ' ')

echo "▶ Community sweep: $n_total fixtures across [$DIRS], ${DURATION_MS}ms each"
echo "  Sonic Pi restart every $RESTART_INTERVAL fixtures (SP60 mitigation)"
echo ""

idx=0
ok=0
fail=0
for fp in $FIXTURES; do
  idx=$((idx + 1))
  if [ $idx -gt 1 ] && [ $((idx % RESTART_INTERVAL)) -eq 1 ]; then
    restart_sonic_pi
  fi
  base=$(basename "$fp" .rb)
  parent=$(basename "$(dirname "$fp")")
  # Prefix the basename with parent dir to keep names unique across pools.
  name="${parent}__${base}"
  json_out="$OUT_DIR/${name}.json"
  echo ""
  echo "[$idx/$n_total] $name"

  npx tsx tools/compare-desktop-vs-web.ts \
    --file "$fp" \
    --duration "$DURATION_MS" \
    --name "comm-${name}" \
    --json-out "$json_out" 2>&1 | tail -8 || true

  if [ -f "$json_out" ]; then
    echo "  ✓ sidecar written"
    ok=$((ok + 1))
  else
    echo "  ✗ no sidecar — capture failed"
    fail=$((fail + 1))
  fi
done

echo ""
echo "=== summary ==="
echo "  ok:   $ok"
echo "  fail: $fail"
echo "  $(ls "$OUT_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ') sidecars in $OUT_DIR"
