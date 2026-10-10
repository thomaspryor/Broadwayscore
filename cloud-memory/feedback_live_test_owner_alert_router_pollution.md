---
name: feedback_live_test_owner_alert_router_pollution
description: Live-CLI-testing any script that calls routeAlert() can write into the real repo digest queue / local alert ledger even from a scratch cwd — check and revert after
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 780f8927-7ab2-4f85-b95e-6284760bc330
  modified: 2026-08-26T18:04:58.023Z
---

Any script `require()`ing `scripts/lib/owner-alert-router.js` resolves its state file paths relative to the REAL repo root / home directory, not the calling process's `cwd`. Running the real script as a subprocess (`node scripts/foo.js`) from a scratch/tmp directory to live-test guard-escalation-style logic does NOT sandbox `routeAlert()` calls — a `disposition: 'digest'` call still appends to the real `data/audit/alert-digest-queue.json` in the actual git checkout, and any ledger write lands in `~/.broadwayscore-state/alert-ledger.json` (or the tracked ledger in CI).

**Why:** hit this twice in one session (BRO-2424, 2026-08-26) testing `check-vercel-build-guard.js` and `check-corpus-drift.js`'s escalation paths — each live run that reached `shouldEscalate()` silently queued a fake entry into the real digest file and the real local ledger, invisible until `git status`/`grep` caught it.

**How to apply:** as of this session, `owner-alert-router.js`'s `DIGEST_QUEUE_PATH` now honors an `ALERT_DIGEST_QUEUE_PATH` env override (mirroring the pre-existing `ALERT_LEDGER_PATH`) — set BOTH when live-CLI-testing anything that can call `routeAlert()`, e.g. `ALERT_DIGEST_QUEUE_PATH=/tmp/scratch-digest.json ALERT_LEDGER_PATH=/tmp/scratch-ledger.json node scripts/foo.js`. If you forget, or need to test the real unset-default path, always `git status --short data/audit/alert-digest-queue.json data/audit/alert-ledger.json` immediately after, and grep `~/.broadwayscore-state/alert-ledger.json` for the test's `conditionKey` — revert/delete before ending the session. Prefer the existing `node --test` fs-mock seam (`owner-alert-router.test.mjs`'s `_DIGEST_QUEUE_PATH` pattern) over a live CLI run when you only need to verify logic, not exercise the real network/API call.
