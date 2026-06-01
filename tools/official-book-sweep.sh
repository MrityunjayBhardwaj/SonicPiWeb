#!/bin/bash
# Capture the official (34 bundled Sonic Pi.app) + book-examples top-level (18)
# rosters through the desktop ↔ web comparator. Writes the canonical
# .captures/compare_<ts>_<basename>.md reports that build-examples-sweep.ts
# (roster=official and roster=book-examples) picks up by --name = bare basename.
#
# RESUMABLE / IDEMPOTENT. The long-lived capture loop is signal-killed after
# ~12-17 fixtures (headed-Chromium + SP60 daemon churn; root signal source
# unidentified). Instead of fighting that, this script is RESUMABLE: it skips
# fixtures already SETTLED in the current run and is re-launched by a
# supervisor (full-sweep-run.sh) until every fixture settles.
#
# A fixture is SETTLED when EITHER:
#   - it has a fresh successful report (compare_*_<base>.md newer than RUN_EPOCH), OR
#   - it has been attempted MAX_ATTEMPTS times (flaky captures get retries;
#     a reliable killer like `crushed` gives up after the cap instead of looping).
#
# Robustness per fixture: hard timeout + compare-subtree kill + Chromium/orphan
# cleanup + desktop-state reset on failure. NO `set -e`.
#
# Env: OB_RUN_EPOCH (supervisor sets; default now) · OB_MAX_ATTEMPTS (3)
#      OB_DURATION_MS (15000) · OB_TIMEOUT_SEC (110) · OB_RESTART_INTERVAL (5)
#      OB_POOLS (official,book)

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
OFFICIAL_DIR="/Applications/Sonic Pi.app/Contents/Resources/etc/examples"
BOOK_DIR="$REPO/tests/book-examples"
DURATION_MS="${OB_DURATION_MS:-15000}"
RESTART_INTERVAL="${OB_RESTART_INTERVAL:-5}"
TIMEOUT_SEC="${OB_TIMEOUT_SEC:-110}"
MAX_ATTEMPTS="${OB_MAX_ATTEMPTS:-3}"
RUN_EPOCH="${OB_RUN_EPOCH:-$(date +%s)}"
POOLS="${OB_POOLS:-official,book}"
# Process at most BATCH unsettled fixtures per invocation, then exit cleanly.
# The long loop is signal-killed after ~12-17 fixtures; a small batch finishes
# (and prints POOL-SETTLED) BEFORE that threshold, so the supervisor always
# sees a clean tally and re-launches for the next batch.
BATCH="${OB_BATCH:-8}"
STATE_DIR="$REPO/.captures/.sweep_state/official-book"
mkdir -p "$STATE_DIR"
cd "$REPO"

restart_sonic_pi() {
  echo "  ↻ restarting Sonic Pi.app (SP60 mitigation)..."
  pkill -f "Sonic Pi.app" 2>/dev/null || true
  sleep 1.5
  open -a "Sonic Pi"
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

# Kill the compare subtree + any orphaned headed Playwright Chromium / capture
# child. Serial sweep → broad pkill is safe between/after fixtures.
cleanup_capture_orphans() {
  pkill -f "ms-playwright" 2>/dev/null || true            # Playwright bundled Chromium
  pkill -f "node .*tsx.*tools/capture.ts" 2>/dev/null || true
  pkill -f "node .*tsx.*tools/capture-desktop.ts" 2>/dev/null || true
}

guarded_compare() {
  local fp="$1" base="$2"
  npx tsx tools/compare-desktop-vs-web.ts \
    --file "$fp" --duration "$DURATION_MS" --name "$base" > /tmp/ob_compare.log 2>&1 &
  local cpid=$!
  local waited=0 timedout=0
  while kill -0 "$cpid" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$TIMEOUT_SEC" ]; then
      timedout=1
      echo "  ⏱ TIMEOUT ${TIMEOUT_SEC}s — killing compare subtree for $base"
      pkill -P "$cpid" 2>/dev/null || true
      kill -9 "$cpid" 2>/dev/null || true
      break
    fi
  done
  wait "$cpid" 2>/dev/null || true
  tail -6 /tmp/ob_compare.log 2>/dev/null
  cleanup_capture_orphans
  [ "$timedout" -eq 1 ] && return 124
  return 0
}

newest_report_epoch() {
  local base="$1" newest
  newest=$(ls -t .captures/compare_*_"${base}".md 2>/dev/null | head -1)
  [ -n "$newest" ] && stat -f '%m' "$newest" 2>/dev/null || echo 0
}
attempts_of() { local f="$STATE_DIR/$1.attempts"; [ -f "$f" ] && cat "$f" || echo 0; }
bump_attempts() { local f="$STATE_DIR/$1.attempts"; echo $(( $(attempts_of "$1") + 1 )) > "$f"; }
# Settled = fresh success OR exhausted retries.
is_settled() {
  local base="$1"
  [ "$(newest_report_epoch "$base")" -gt "$RUN_EPOCH" ] && return 0
  [ "$(attempts_of "$base")" -ge "$MAX_ATTEMPTS" ] && return 0
  return 1
}

# Fixture list. Official recursive; book top-level only.
FIXTURES=""
for pool in $(echo "$POOLS" | tr ',' ' '); do
  case "$pool" in
    official) FIXTURES+=$'\n'$(find "$OFFICIAL_DIR" -name "*.rb" | sort) ;;
    book)     FIXTURES+=$'\n'$(find "$BOOK_DIR" -maxdepth 1 -name "*.rb" | sort) ;;
  esac
done
FIXTURES=$(echo "$FIXTURES" | grep -v "^$")
n_total=$(echo "$FIXTURES" | wc -l | tr -d ' ')

echo "▶ Official+Book sweep (resumable): $n_total fixtures [$POOLS], ${DURATION_MS}ms, ${TIMEOUT_SEC}s timeout, max ${MAX_ATTEMPTS} attempts, RUN_EPOCH=$RUN_EPOCH"

idx=0; processed=0
# IFS=newline + while-read: official paths contain a space ("Sonic Pi.app").
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  idx=$((idx + 1))
  base=$(basename "$fp" .rb)

  if is_settled "$base"; then
    continue   # already succeeded this run, or retries exhausted
  fi

  if [ "$processed" -ge "$BATCH" ]; then
    echo "  ⏸ batch limit ($BATCH) reached — exit cleanly, supervisor re-launches"
    break
  fi
  processed=$((processed + 1))

  if [ $idx -gt 1 ] && [ $((idx % RESTART_INTERVAL)) -eq 1 ]; then
    restart_sonic_pi
  fi
  att=$(( $(attempts_of "$base") + 1 ))
  echo ""
  echo "[$idx/$n_total] $base (attempt $att/$MAX_ATTEMPTS)"
  bump_attempts "$base"

  guarded_compare "$fp" "$base"

  if [ "$(newest_report_epoch "$base")" -gt "$RUN_EPOCH" ]; then
    echo "  ✓ fresh report written for $base"
  else
    echo "  ✗ no fresh report — capture failed/crashed for $base (attempt $att)"
    restart_sonic_pi || true   # killed capture-desktop.ts can leave SP mid-recording
  fi
done <<< "$FIXTURES"

# Settled tally — supervisor parses this to decide whether to re-launch.
n_settled=0
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  base=$(basename "$fp" .rb)
  is_settled "$base" && n_settled=$((n_settled + 1))
done <<< "$FIXTURES"
echo ""
echo "=== official+book pass complete ==="
echo "POOL-SETTLED official-book $n_settled $n_total"
