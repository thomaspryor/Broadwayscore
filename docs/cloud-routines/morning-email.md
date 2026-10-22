# Morning email (cloud), one firing

Read by the "Morning email (cloud)" routine at ~07:24 ET. It replaces the Mac's
launchd job `com.broadwayscore.morning-digest`, which ran
`node scripts/send-morning-digest.js --send-to-owner` at 07:30 ET. That script
is the owner's one scheduled daily email; it reads snapshot files only and
calls no LLM.

No human is watching. Never send more than one owner email per day. Never use
a Resend broadcast or audience (CLAUDE.md §17): the script sends one
transactional email to one recipient, and that is the only send allowed here.

## 0. Setup

In /home/user/Broadwayscore: `git fetch origin main && git checkout -f -B morning-base origin/main`
(retry with backoff on network errors), then `npm ci --no-audit --no-fund | tail -2`
if `node_modules` is missing.

## 1. Credentials

Run `echo "RESEND ${RESEND_API_KEY:+SET} OWNER ${OWNER_EMAIL:+SET}"`. If either
is unset, send nothing and end with the single line
`morning email skipped: RESEND_API_KEY or OWNER_EMAIL not set in this environment`.
Do not look for the keys in files and do not ask for them.

## 2. Already sent today?

    node scripts/check-morning-digest-sent.js --dry-run

If it reports today's (America/New_York) email as already sent, send nothing and
end with `morning email already sent today`.

## 3. Send

    node scripts/send-morning-digest.js --send-to-owner 2>&1 | tail -20

Run it once. If it fails, do not retry: the CI zero-send floor
(`monitor-scheduled-email-count.js`) is the alarm for a missed day.

## 4. Reply

One line: sent (with the Resend id the script prints) or skipped/failed and
why. End with `SAFE TO ARCHIVE`.
