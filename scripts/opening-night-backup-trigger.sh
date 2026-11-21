#!/usr/bin/env bash
# Backup trigger for the Opening Night Orchestrator.
# Runs via launchd every night at 9:00 PM ET (local time).
# Dispatches the GitHub orchestrator, which auto-discovers shows opening today.
# If no shows are opening, the orchestrator exits in <1 min (zero cost).
#
# This exists because GitHub Actions crons have 1-3 hour delays.
# The launchd trigger fires at the exact intended time as a backup.
#
# 2026-07-24 (opening-night monitor plan review): this is the SINGLE local
# force-dispatch path for the orchestrator — the monitor session only CHECKS
# orchestrator state and force-dispatches as a last resort. Two fixes from
# that review: (a) west-end was never covered (only market=broadway), so WE
# nights relied entirely on GitHub-native cron punctuality; (b) dispatch
# errors only reached this log file — network failures (dial tcp, 2026-07-06/07)
# were invisible. Errors now also route through owner-alert-router.

#
# BRO-6968: the 9 PM ET firing is after the whole West End probe window
# (probeDue: embargo 21:00 London -150/+180 min, i.e. ~1:30-7 PM ET), so WE
# nights had NO backup and the probe waited on a GitHub cron that ran 5h late
# (The Bridge 2026-11-03: probe started 23:12Z, every review graded late).
# A second launchd job (com.bwsc.opening-night-backup-trigger-we, 3 PM ET)
# passes "west-end"; the 9 PM job passes "broadway". No argument = both markets.
# scripts/lib/opening-night-backup-window.test.mjs checks both plists' hours
# land inside probeDue for their markets across DST.

set -uo pipefail

export PATH="/Users/tompryor/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/tompryor"
REPO="/Users/tompryor/Broadwayscore"
LOG="$REPO/data/opening-night-monitor/backup-trigger.log"
mkdir -p "$(dirname "$LOG")"

echo "$(date): Backup trigger firing (${1:-all markets})" >> "$LOG"

MARKETS="${1:-broadway west-end}"
FAILED_MARKETS=""
for MARKET in $MARKETS; do
  if gh workflow run opening-night-orchestrator.yml \
    -R thomaspryor/Broadwayscore \
    -f market="$MARKET" 2>>"$LOG"; then
    echo "$(date): Dispatched orchestrator ($MARKET)" >> "$LOG"
  else
    echo "$(date): ERROR dispatching orchestrator ($MARKET)" >> "$LOG"
    FAILED_MARKETS="$FAILED_MARKETS $MARKET"
  fi
done

if [ -n "$FAILED_MARKETS" ]; then
  # Digest-not-email: the GitHub-native crons are still scheduled, so a single
  # local dispatch failure is a degraded-redundancy note, not a page. The
  # 7-day conditionKey cooldown in the router keeps repeats quiet.
  node -e "
    require('$REPO/scripts/lib/owner-alert-router.js').routeAlert({
      conditionKey: 'opening-night-backup-trigger-dispatch-failed',
      title: 'Opening-night backup trigger: orchestrator dispatch failed ($FAILED_MARKETS)',
      description: 'gh workflow run failed from the Mac Studio (see data/opening-night-monitor/backup-trigger.log). GitHub-native crons remain the fallback.',
      severity: 'warning', disposition: 'digest',
    }).catch(() => {});
  " 2>>"$LOG" || echo "$(date): WARN alert routing failed too" >> "$LOG"
fi
