---
name: github-polling-rate-limit
description: Never use gh run list in a polling loop — burns GitHub rate limit to zero in minutes
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb4711d-b2fd-4824-a30c-440ee0feee95
---

Never put `gh run list` in a `until`/`while` polling loop to monitor CI. Discovered 2026-05-17: burned entire GitHub API quota in ~2 hours using a 15s-interval loop, blocking ALL other CI from calling the API.

**Why:** `gh run list --workflow=NAME` makes two API calls per invocation — first it lists all workflows (`/actions/workflows`) to resolve the name, then lists runs. At 15s intervals that's 480+ calls/2hrs. GitHub 403s immediately when rate-limited, but the loop just retries instead of exiting, running forever.

**How to apply:**
- Get run ID once: `gh run list --limit 1 --json databaseId --jq '.[0].databaseId'`
- Then watch it: `gh run watch <id>` — blocks, uses long-polling, rate-limit safe
- Or: use `gh api repos/OWNER/REPO/actions/runs` directly (doesn't hit workflow-listing endpoint)
- Or: check once after a fixed wait, report to user, move on to other work
- **Never** chain `sleep N && gh run list` in a background loop
- **Never** use `until gh run list ... | grep ...` — 403s don't break the loop
