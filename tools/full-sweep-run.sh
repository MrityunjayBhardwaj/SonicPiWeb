#!/bin/bash
# Supervisor: capture all four example pools SERIALLY (one desktop scsynth) and
# survive the signal-kill that takes down a long capture loop after ~12-17
# fixtures. Each pool script is RESUMABLE and processes a small batch per
# invocation; this supervisor re-launches it until every fixture SETTLES
# (fresh success OR retries exhausted), then moves to the next pool.
#
# Resumable at the supervisor level too: RUN_EPOCH + per-fixture attempt state
# persist on disk, so if THIS process is killed, relaunch (without FRESH_RUN=1)
# and it picks up exactly where it stopped. Start a brand-new run with
# FRESH_RUN=1 (clears attempt state + stamps a new epoch + truncates the log).
#
#   FRESH_RUN=1 bash tools/full-sweep-run.sh   # new run
#   bash tools/full-sweep-run.sh               # resume after a death

REPO=/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb
cd "$REPO"
LOG="$REPO/.captures/full-sweep-progress.log"
EPOCH_FILE="$REPO/.captures/.sweep_run_epoch"
STATE_ROOT="$REPO/.captures/.sweep_state"
MAX_PASSES="${MAX_PASSES:-30}"

if [ "${FRESH_RUN:-0}" = "1" ] || [ ! -f "$EPOCH_FILE" ]; then
  RUN_EPOCH=$(date +%s)
  echo "$RUN_EPOCH" > "$EPOCH_FILE"
  rm -rf "$STATE_ROOT"; mkdir -p "$STATE_ROOT"
  : > "$LOG"
  echo "FULL-SWEEP START (fresh, epoch=$RUN_EPOCH) $(date)" | tee -a "$LOG"
else
  RUN_EPOCH=$(cat "$EPOCH_FILE")
  echo "FULL-SWEEP RESUME (epoch=$RUN_EPOCH) $(date)" | tee -a "$LOG"
fi

# Re-launch one pool script until its POOL-SETTLED tally shows settled==total.
run_pool() {
  local label="$1" script="$2" epochvar="$3"
  local pass=0 line settled total
  echo "POOL-START $label $(date)" | tee -a "$LOG"
  while [ "$pass" -lt "$MAX_PASSES" ]; do
    pass=$((pass + 1))
    echo "POOL-PASS $label #$pass $(date)" | tee -a "$LOG"
    env "$epochvar=$RUN_EPOCH" bash "$script" 2>&1 | tee -a "$LOG"
    line=$(grep "POOL-SETTLED $label " "$LOG" | tail -1)
    settled=$(echo "$line" | awk '{print $3}')
    total=$(echo "$line" | awk '{print $4}')
    if [ -n "$settled" ] && [ -n "$total" ] && [ "$settled" -ge "$total" ]; then
      echo "POOL-DONE $label ($settled/$total) after $pass passes $(date)" | tee -a "$LOG"
      return 0
    fi
    echo "POOL-INCOMPLETE $label (${settled:-?}/${total:-?}) — relaunch" | tee -a "$LOG"
  done
  echo "POOL-GAVEUP $label after $MAX_PASSES passes (${settled:-?}/${total:-?}) $(date)" | tee -a "$LOG"
  return 1
}

run_pool "official-book" tools/official-book-sweep.sh OB_RUN_EPOCH
run_pool "e2e"           tools/e2e-sweep.sh           E2E_RUN_EPOCH
run_pool "community"     tools/community-sweep.sh     COMMUNITY_RUN_EPOCH

echo "FULL-SWEEP DONE $(date)" | tee -a "$LOG"
