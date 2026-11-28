---
name: Rotating-token APIs need a single caller
description: "One script owns Theatr-style auth; GITHUB_TOKEN can't write secrets."
type: feedback
originSessionId: f92fe8b2-d15d-4d53-9af6-06a1dd9d85c4
archived: true
---
**Rule:** When an external API rotates its refresh token on every use (Theatr, and likely others), there must be exactly ONE script in the codebase that calls its auth endpoint. Every other consumer reads a cache file populated by that script.

**Why:** Two separate workflows called Theatr auth — `update-theatr.yml` persisted correctly via `REVIEW_TEXTS_TOKEN`, `fetch-all-image-formats.yml` used `GITHUB_TOKEN` which cannot write repository secrets at all. Every Mon+Thu fetch-images cron rotated the token and silently dropped the new value, burning the chain within days of each manual refresh. Took 2 sessions to diagnose because the `gh secret set` step printed "Refresh token rotated" with no error even though the write silently failed.

**How to apply:**
- When adding a new consumer for a rotating-token API, make it read from a cache file — never call auth directly. Rotating-token APIs include: Theatr, Mezzanine (session token), anything using refresh-token rotation semantics.
- `GITHUB_TOKEN` can NEVER write repository secrets. Any `gh secret set` in a workflow needs a PAT with `repo` or `admin:repo_secrets` scope.
- When debugging "token keeps dying", grep the entire codebase for the auth endpoint URL — not just workflow files. Any script that calls it is a potential racer.
- Verify secret writes actually happened by checking `gh secret list` timestamps against the workflow run time. A "rotated" log line without a timestamp change means the write failed silently.
- Validated by the user's observation: "we used the first Theatr token for several weeks" — the chain was durable with a single caller; it broke the day a second caller was added.
