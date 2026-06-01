#!/bin/bash
# Run all community + in-thread-forum fixtures through the desktop ↔ web
# comparator. Writes per-fixture sidecar JSON + spectrogram into
# .captures/community-sweep/.
#
# RESUMABLE / IDEMPOTENT (see tools/official-book-sweep.sh): skips fixtures
# already SETTLED this run, re-launched by full-sweep-run.sh until all settle.
# Settled = fresh sidecar (mtime > RUN_EPOCH) OR attempts exhausted. Hard
# per-fixture timeout kills a hung compare subtree.
#
# Env: COMMUNITY_RUN_EPOCH · COMMUNITY_MAX_ATTEMPTS (3)
#      COMMUNITY_DURATION_MS (30000) · COMMUNITY_TIMEOUT_SEC (140)
#      COMMUNITY_RESTART_INTERVAL (5) · COMMUNITY_DIRS (community,in-thread-forum)

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
OUT_DIR="$REPO/.captures/community-sweep"
DURATION_MS="${COMMUNITY_DURATION_MS:-30000}"
RESTART_INTERVAL="${COMMUNITY_RESTART_INTERVAL:-5}"
TIMEOUT_SEC="${COMMUNITY_TIMEOUT_SEC:-140}"
MAX_ATTEMPTS="${COMMUNITY_MAX_ATTEMPTS:-3}"
RUN_EPOCH="${COMMUNITY_RUN_EPOCH:-$(date +%s)}"
BATCH="${COMMUNITY_BATCH:-8}"   # at most N unsettled fixtures per invocation (see official-book-sweep.sh)
DIRS="${COMMUNITY_DIRS:-community,in-thread-forum}"
STATE_DIR="$REPO/.captures/.sweep_state/community"
mkdir -p "$OUT_DIR" "$STATE_DIR"
cd "$REPO"

restart_sonic_pi() {
  echo "  ↻ restarting Sonic Pi.app (SP60 mitigation)..."
  pkill -f "Sonic Pi.app" 2>/dev/null || true
  sleep 1.5
  open -a "Sonic Pi"
  for i in {1..30}; do
    sleep 0.5
    if pgrep -f "scsynth -u" >/dev/null 2>&1; then sleep 2.5; echo "  ↻ ready"; return 0; fi
  done
  echo "  ✗ Sonic Pi.app failed to relaunch"; return 1
}
cleanup_capture_orphans() {
  pkill -f "ms-playwright" 2>/dev/null || true
  pkill -f "node .*tsx.*tools/capture.ts" 2>/dev/null || true
  pkill -f "node .*tsx.*tools/capture-desktop.ts" 2>/dev/null || true
}
guarded_compare() {
  local fp="$1" name="$2" json_out="$3"
  npx tsx tools/compare-desktop-vs-web.ts \
    --file "$fp" --duration "$DURATION_MS" --name "$name" --json-out "$json_out" > /tmp/comm_compare.log 2>&1 &
  local cpid=$! waited=0
  while kill -0 "$cpid" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$TIMEOUT_SEC" ]; then
      echo "  ⏱ TIMEOUT ${TIMEOUT_SEC}s — killing compare subtree"
      pkill -P "$cpid" 2>/dev/null || true; kill -9 "$cpid" 2>/dev/null || true; break
    fi
  done
  wait "$cpid" 2>/dev/null || true
  tail -6 /tmp/comm_compare.log 2>/dev/null
  cleanup_capture_orphans
}
sidecar_epoch() { [ -f "$1" ] && stat -f '%m' "$1" 2>/dev/null || echo 0; }
attempts_of() { local f="$STATE_DIR/$1.attempts"; [ -f "$f" ] && cat "$f" || echo 0; }
bump_attempts() { echo $(( $(attempts_of "$1") + 1 )) > "$STATE_DIR/$1.attempts"; }
is_settled() {
  local key="$1" json_out="$OUT_DIR/$1.json"
  [ "$(sidecar_epoch "$json_out")" -gt "$RUN_EPOCH" ] && return 0
  [ "$(attempts_of "$key")" -ge "$MAX_ATTEMPTS" ] && return 0
  return 1
}

# Collect fixtures across all configured dirs, sorted by full path.
FIXTURES=""
for dir in $(echo "$DIRS" | tr ',' ' '); do
  d="$REPO/tests/book-examples/$dir"
  [ -d "$d" ] && FIXTURES+=$'\n'$(find "$d" -maxdepth 1 -name "[0-9][0-9]_*.rb" | sort)
done
FIXTURES=$(echo "$FIXTURES" | grep -v "^$")
n_total=$(echo "$FIXTURES" | wc -l | tr -d ' ')
echo "▶ Community sweep (resumable): $n_total fixtures [$DIRS], ${DURATION_MS}ms, ${TIMEOUT_SEC}s timeout, max ${MAX_ATTEMPTS}, RUN_EPOCH=$RUN_EPOCH"

idx=0; processed=0
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  idx=$((idx + 1))
  base=$(basename "$fp" .rb)
  parent=$(basename "$(dirname "$fp")")
  key="${parent}__${base}"
  is_settled "$key" && continue
  if [ "$processed" -ge "$BATCH" ]; then echo "  ⏸ batch limit ($BATCH) — exit; supervisor re-launches"; break; fi
  processed=$((processed + 1))
  if [ $idx -gt 1 ] && [ $((idx % RESTART_INTERVAL)) -eq 1 ]; then restart_sonic_pi; fi
  att=$(( $(attempts_of "$key") + 1 ))
  echo ""; echo "[$idx/$n_total] $key (attempt $att/$MAX_ATTEMPTS)"
  bump_attempts "$key"
  guarded_compare "$fp" "comm-${key}" "$OUT_DIR/${key}.json"
  if [ "$(sidecar_epoch "$OUT_DIR/${key}.json")" -gt "$RUN_EPOCH" ]; then
    echo "  ✓ fresh sidecar for $key"
  else
    echo "  ✗ no fresh sidecar — failed/crashed for $key (attempt $att)"
    restart_sonic_pi || true
  fi
done <<< "$FIXTURES"

n_settled=0
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  base=$(basename "$fp" .rb); parent=$(basename "$(dirname "$fp")")
  is_settled "${parent}__${base}" && n_settled=$((n_settled + 1))
done <<< "$FIXTURES"
echo ""; echo "=== community pass complete ==="
echo "POOL-SETTLED community $n_settled $n_total"
