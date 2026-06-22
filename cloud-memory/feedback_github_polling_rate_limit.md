---
name: github-polling-rate-limit
description: Never use gh run list in a polling loop — burns GitHub rate limit to zero in minutes. Hook now enforces this.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb4711d-b2fd-4824-a30c-440ee0feee95
---

Never put `gh run list` in a `until`/`while` polling loop to monitor CI. Discovered 2026-05-17: burned entire GitHub API quota in ~2 hours using a 15s-interval loop, blocking ALL other CI from calling the API.

**Why:** `gh run list --workflow=NAME` makes two API calls per invocation — first it lists all workflows (`/actions/workflows`) to resolve the name, then lists runs. At 15s intervals that's 480+ calls/2hrs. GitHub 403s immediately when rate-limited, but the loop just retries instead of exiting, running forever.

**Second incident 2026-05-17:** Five zombie `until gh run list` loops from old deploy-monitoring sessions were found still running hours later. When rate-limited, the loops kept retrying infinitely (403 doesn't break `until`). Killed with `ps aux | grep "gh run list" | grep -v grep | awk '{print $2}' | xargs kill`.

**Prevention:** A PreToolUse hook (`~/.claude/hooks/gh-poll-block.sh`) now blocks `until gh run list` and `sleep N && gh run list` patterns. Wired into `~/.claude/settings.json`.

**Third incident 2026-05-18:** Hit rate limit via cascading cancelled runs — NOT a loop, but 3 × `gh run watch` + 3 × `gh run list` within ~5 min because each push (two repos pushed separately) cancelled the previous CI run, forcing a new ID lookup. Combined with other sessions consuming quota, hit 0.

**Fourth incident 2026-05-23:** Rate limit drained to 0 again. Root cause: a **4-day-old `until gh run view <id>; do sleep 60; done`** zombie from a Tue afternoon session that never exited (its `until D=... && [ "$D" = completed ]` conditional bugged out), plus a 4-min-old `while true; do gh run list ...; sleep 120; done` from a parallel session. The old hook only matched `until gh run list` literally — `gh run view` and `while`-loops slipped through. Hook broadened to match `(until|while).*gh (run|api).*sleep`.

**Fifth incident 2026-06-21:** Hit 403 via the **Monitor tool** running `while true; do gh run list --workflow "Deploy to Vercel" ...; sleep 30; done` to watch for a deploy. Monitor IS a polling loop — `gh run list --workflow` inside it makes the same two-call (workflow-listing + runs) burn as a bash loop, and the PreToolUse hook doesn't inspect Monitor commands. **Don't poll `gh run list --workflow` from Monitor either.** Recovered by verifying the deploy a different way (see Vercel-API fallback below) — no need to wait for the GitHub quota to reset.

**Vercel-API fallback for deploy verification (no GitHub calls):** When GitHub is rate-limited (or to avoid spending quota), confirm a commit is deployed via Vercel's API + local git ancestry:
```bash
TOKEN=$(grep -E '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"' )
curl -s "https://api.vercel.com/v6/deployments?projectId=prj_wmBnDUrCQCwabIAYPbnMiIP3wg15&target=production&limit=6" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.deployments[] | "\(.state) \(.meta.githubCommitSha[0:10])"'
# Then: a READY deploy whose sha is a descendant of your commit means you're live:
git merge-base --is-ancestor <your-commit> <ready-deploy-sha> && echo "deployed live"
```
This is the canonical "pushed ≠ deployed" check when GitHub is unavailable. See [[feedback_vercel_api_access.md]].

**Two layers of prevention (added 2026-05-23):**
1. **PreToolUse block** — `~/.claude/hooks/gh-poll-block.sh` now rejects any `(until|while) + gh (run list|view|api|watch) + sleep + do` combination at the tool-call boundary.
2. **Zombie reaper** — `~/.claude/hooks/gh-zombie-reap.sh` finds shells > 5 min old matching the polling-loop signature and kills them. Triggered by SessionStart (every new Claude session) AND launchd (`~/Library/LaunchAgents/com.tompryor.gh-zombie-reap.plist`, every 10 min, independent of Claude). Logs to `~/.claude/gh-zombie-reap.log`.

**How to apply:**
- Get run ID once: `gh run list --limit 1 --json databaseId --jq '.[0].databaseId'`
- Then watch it: `gh run watch <id>` — blocks, uses long-polling, rate-limit safe. `gh run watch` is the ONLY safe pattern for waiting on a run.
- Or: use `gh api repos/OWNER/REPO/actions/runs` directly (doesn't hit workflow-listing endpoint)
- Or: check once after a fixed wait, report to user, move on to other work
- **Never** chain `sleep N && gh run X` in a `while`/`until` loop — applies to `gh run list`, `gh run view`, AND `gh api`.
- **When pushing multiple repos in sequence:** push all repos first, THEN get the single final run ID and watch it once. Don't watch intermediate cancelled runs.
- If you suspect zombie loops: `ps aux | grep -E 'gh (run|api)' | grep -v grep` — also check `~/.claude/gh-zombie-reap.log` for what the reaper already killed.
- Manually run the reaper: `~/.claude/hooks/gh-zombie-reap.sh`
