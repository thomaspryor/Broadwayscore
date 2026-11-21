---
name: Never use UTC-date keys to dedup events anchored to US/ET time
description: "Never use YYYY-MM-DD UTC keys for evening ET events; use 24h rolling windows."
type: feedback
originSessionId: efbed214-86d5-419d-b2dc-4f805e0e2829
archived: true
---
**Incident (2026-04-11 02:09 UTC / 10:09 PM ET):** a duplicate DoaS opening-night preview email was sent to Tom because the dedup key used `YYYY-MM-DD` from `new Date().toISOString()`.

**Timeline:**
- 2026-04-10 12:16 UTC (08:16 ET): preview #1 tracked as `preview:broadway:death-of-a-salesman-2026:2026-04-10`
- 2026-04-11 02:09 UTC (22:09 ET, SAME EVENING): preview #2 run. Lookup uses key `preview:broadway:death-of-a-salesman-2026:2026-04-11`. Different key. Dedup passes. Duplicate sent with the same review count (24).

**Why this is systemic (not a one-off):** US opening-night reviews drop at 10–11 PM ET = 02–03 UTC the next day. Every re-run past 8 PM ET crosses the UTC midnight boundary and gets a fresh dedup key. So any "once per UTC day" dedup is guaranteed to fail on every US opening night.

**Rule:** When building dedup for any recurring action that fires in the evening ET (opening-night emails, overnight polling, late-night cron jobs), NEVER key by `YYYY-MM-DD` from `toISOString()`. Use one of:

1. **Rolling time window** (preferred): scan all matching entries, find the most recent by timestamp, gate on `hoursSince < N`. See `scripts/lib/preview-dedup.js` for the pattern.
2. **Prefix scan** of existing tracking entries, take max by `sentAt`.
3. **ET-anchored date key** via `new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })` — still has a midnight boundary, but at least it's at the quiet 00:00 ET instead of during peak activity. Only suitable when the caller is clearly US-only.
4. **6 AM UTC-anchored buckets** — shift the boundary to a quiet time.

**How to apply:**
- When adding dedup to any script that may run in the evening ET: flag the key format in review.
- When seeing a date-string key in existing dedup code, ask: "can this fire between 8 PM ET and midnight ET?" If yes, treat it as suspect.
- When extracting dedup logic from a script, write a regression test that simulates the UTC-rollover scenario (same event, key dates on opposite sides of UTC midnight) — the test should return `skip`, not `send`. See `scripts/test-preview-dedup.js` for the template.
- This is a pattern, not just one bug — grep for `toISOString().slice(0, 10)` used as a key/bucket in any dedup-style logic and audit each occurrence.

**2026-04-11 closeout (PR #233):**
- Script-side dedup was migrated to `scripts/lib/preview-dedup.js::checkPreviewDedup` (prefix scan + 24h rolling window).
- Workflow-side dedup (opening-night-broadcast.yml) now `require()`s two new helpers from the same lib: `hasRecentPreviewForShow` (24h default) and `hasRecentOverdueAlert` (24h default). Pattern for any other workflow inline node -e: extract to lib, require from repo root, test via `scripts/test-preview-dedup.js`.
- **The incident had a 14h gap between first and duplicate send.** A 12h window would NOT have caught it. Default to 24h rolling windows for opening-night-scale dedup unless there's a specific reason to be tighter.
- CLI `send-opening-night-broadcast.js` now calls `syncTrackerToOrigin()` after every `--send-to` preview write, using `gh api` contents PUT. No-op under GITHUB_ACTIONS. This closes the "CLI writes locally, workflow reads origin" race class.
- A separate `scripts/lib/send-lock.js` now guards all Resend/Buttondown calls with a Contents API CAS lock at `data/email-send.lock`. Any new send path in the broadcast script MUST call `acquireSendLock()` before the network call and `releaseSendLock()` in both success and failure branches — see `send-opening-night-broadcast.js` for the pattern.
