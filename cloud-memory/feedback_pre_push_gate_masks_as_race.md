---
name: feedback_pre_push_gate_masks_as_race
description: merge-worktree-to-main.sh push retries fail forever (not flaky) when a local pre-push hook rejects the commit outright — check hook output before assuming timing/churn
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 88a012f0-9687-4d70-96d6-b668870f505f
  modified: 2026-09-20T03:08:03.829Z
---

When `scripts/merge-worktree-to-main.sh`'s push loop reports "push not yet confirmed landed" for 5+ consecutive full script invocations (25+ raw push attempts) with origin/main visibly NOT moving in between, stop assuming race/churn and check for a **local pre-push hook rejection** instead — the retry loop's `git push` output is captured into `$OUT` but only ever printed for the network-unreachable die() path, never for a flat rejection, so a hook block looks identical to "still racing."

**Diagnostic:** write a throwaway script (not touching tracked files) that does one `git -C <main-worktree> push origin main 2>&1` and prints the raw output — this surfaces the real rejection text immediately. In this incident it was `cron-health-coverage`: a repo-specific pre-push hook that refuses any push introducing a new scheduled `.github/workflows/*.yml` cron not yet classified into `check-cron-health.yml`'s `CRITICAL_CRONS` list or `.cron-health-exempt.txt`. Fix: add the new workflow to one of those two lists (see `check-arm-yield.yml`'s CRITICAL_CRONS entry for the format), commit, retry.

**Why:** merging origin's changes in on every retry does nothing for a hook rejection — it will fail identically forever, burning ~15-20 min across repeated full-script invocations (each including the syntax floor, push audits, and optionally the 585-test post-merge floor) before anyone notices origin has gone static.

**How to apply:** the moment a push retry loop looks stuck against a QUIET origin (check `git log origin/main -1 --format=%ai` before and after a failed attempt — if unchanged, it's not a race), go straight to the raw-push diagnostic above instead of retrying blindly. Same applies to any NEW workflow file this repo adds — it needs a `CRITICAL_CRONS`/`.cron-health-exempt.txt` classification before its first push will succeed, not just before it starts monitoring.
