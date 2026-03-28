#!/bin/bash
# Nightly Digest — local replacement for RemoteTrigger trig_017Gcb5bebH2TcfZZMz2ZSBL
# Runs send-daily-digest.js. If changes detected, sends email via Resend.
# Scheduled daily at 11 PM ET via launchd.

set -euo pipefail
cd /Users/tompryor/Broadwayscore

# Source env vars
set -a
source .env
set +a

LOG="/Users/tompryor/Library/Logs/bwsc-nightly-digest.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running nightly digest..." >> "$LOG"

# Pull latest data
git pull --ff-only origin main >> "$LOG" 2>&1 || true

# Run the digest script
node scripts/send-daily-digest.js >> "$LOG" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Nightly digest completed successfully." >> "$LOG"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Nightly digest failed with exit code $EXIT_CODE." >> "$LOG"
fi
