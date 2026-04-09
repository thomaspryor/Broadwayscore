#!/usr/bin/env bash
# Backup trigger for the Opening Night Orchestrator.
# Runs via launchd every night at 9:00 PM ET (local time).
# Dispatches the GitHub orchestrator, which auto-discovers shows opening today.
# If no shows are opening, the orchestrator exits in <1 min (zero cost).
#
# This exists because GitHub Actions crons have 1-3 hour delays.
# The launchd trigger fires at the exact intended time as a backup.

set -euo pipefail

export PATH="/Users/tompryor/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/tompryor"
LOG="/Users/tompryor/Broadwayscore/data/opening-night-monitor/backup-trigger.log"
mkdir -p "$(dirname "$LOG")"

echo "$(date): Backup trigger firing" >> "$LOG"

# Dispatch the orchestrator for broadway market
if gh workflow run opening-night-orchestrator.yml \
  -R thomaspryor/Broadwayscore \
  -f market=broadway 2>>"$LOG"; then
  echo "$(date): Dispatched orchestrator (broadway)" >> "$LOG"
else
  echo "$(date): ERROR dispatching orchestrator" >> "$LOG"
fi
