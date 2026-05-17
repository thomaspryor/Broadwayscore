---
name: All audience-email send paths must acquire scripts/lib/send-lock.js before any network call
description: "Every Resend/Buttondown audience send acquires send-lock before network."
type: feedback
originSessionId: efbed214-86d5-419d-b2dc-4f805e0e2829
archived: true
---
**Rule:** Any code path that calls Resend `/emails` or Buttondown `/v1/emails` for audience-facing purposes must acquire the cross-session send lock first.

**Why:** After PR #233 closed the UTC-rollover dedup bug + the CLI/workflow state-divergence bug, two narrower races remained — two parallel CLI sessions, or a CLI session concurrent with a workflow run. Both windows are minute-scale (not hour-scale like the original) but they're real. The lock closes them. Without the lock, any new send path is a re-introduction of the same race.

**How to apply:**

1. Before the `postJSON('https://api.resend.com/emails'...)` or `postJSON('https://api.buttondown.com/v1/emails'...)` call, add:
   ```js
   const { acquireSendLock, releaseSendLock } = require('./lib/send-lock');
   const lock = acquireSendLock({
     purpose: `${MARKET}-${pathLabel}-${showId}`,
   });
   if (!lock.acquired) {
     console.error(`SEND LOCK REFUSED: ${lock.reason}`);
     process.exit(1);  // fail-safe: refuse to send
   }
   ```

2. In BOTH the success and failure branches, release:
   ```js
   try {
     await postJSON(...);
     const rel = releaseSendLock(lock);
     if (!rel.released) console.error(`WARNING: ${rel.reason}`);
   } catch (err) {
     const rel = releaseSendLock(lock);
     if (!rel.released) console.error(`(lock release note: ${rel.reason})`);
     process.exit(1);
   }
   ```

3. Scope the `purpose` label to `{market}-{pathType}-{showId}` so parallel runs for **different shows** don't block each other. Only true same-show races get refused.

4. If the new path runs in a GitHub Actions workflow step, that step MUST set `GH_TOKEN: ${{ github.token }}` in `env:` — otherwise `gh api` in the lock helper fails auth and the lock refuses, blocking the send.

5. Test coverage: add cases to `scripts/test-send-lock.js` if the new path has novel lock semantics. The existing 29 cases cover happy path, contention, expiry takeover, defensive release, idempotent release — most new callers are covered by those if they just use the helper as-is.

**Lock file:** `data/email-send.lock` on origin/main, public repo, non-sensitive. Schema: `{ sessionId, acquiredAt, expiresAt, purpose, holder, workflowRunId }`. TTL 5 min. Expired locks auto-take-over on the next acquisition attempt.

**Three paths currently covered (do not regress):**
- `--send-to` preview Resend `/emails` call
- Buttondown `/v1/emails` draft creation
- Owner-notification Resend `/emails` call (inside the Buttondown branch)

**Internal Discord/email alerts via `sendAlert()` are NOT locked** — they're owner-only, not audience broadcasts. The lock is specifically for audience-facing sends.
