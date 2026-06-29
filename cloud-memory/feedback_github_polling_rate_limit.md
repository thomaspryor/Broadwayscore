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

**Sixth incident 2026-06-21:** Core API found at 0/5000. Culprit: a `while true; do gh run list --workflow "Deploy to Vercel" | jq | while read; ...; sleep 30; done` loop spawned by the **Codex-companion runtime** (process env had `CODEX_COMPANION_SESSION_ID`). Two compounding gaps: (1) **codex-companion shells run shell OUTSIDE Claude's PreToolUse hooks**, so `gh-poll-block.sh` never saw it — the in-session blocker only inspects Claude's own Bash tool. (2) The zombie reaper's regex `(until|while)[^|]*gh (run|api)[^|]*sleep` couldn't match it: the `[^|]*` refuses to cross a pipe, and this loop had a `|` between the `gh run list` and the `sleep` (`gh run list | jq | while read; ... sleep`). So the sole backstop for codex/parallel/crashed-session loops had a blind spot, and the loop ran unbounded. **Fixes:** reaper matcher rewritten to three independent ANDed greps (loop-kw + `gh (run list|view|watch|api)` + sleep), pipe-agnostic, proven end-to-end against a live decoy; launchd `StartInterval` tightened 600→120s (the reaper makes zero API calls, so running it 5× more often is free and halves catch latency). Left `THRESHOLD_SECS` at 300 deliberately — lowering it risks killing legitimate finite `gh api` batch loops with sleep-spacing mid-run. Log-mined history: ~1 zombie/week caught, 6 of 10 non-codex — so the block hook leaks Claude-spawned loops too; a codex-side guard alone wouldn't fix it. **Key lesson: the reaper is the ONLY backstop for hook-bypassing loops (codex, crashed sessions, parallel sessions), so its matcher must have no blind spots — never narrow it with `[^|]`-style token gates.**

**Seventh incident 2026-06-29:** PRIMARY quota (not secondary) exhausted: 5 sessions logged `HTTP 403: API rate limit exceeded for user ID 3475675`. NOT a read-poll loop — the drain was **`gh workflow run` DISPATCH volume**: transcripts showed ~544 dispatches + ~214 `gh run list` + ~199 `gh run view` in one day, incl. a session's manual "backup dispatcher" (`while …; gh workflow run …; sleep 300; done`, every 5 min for 6h). The existing guards target read-poll loops (`gh run list…sleep`) and never looked at `gh workflow run`, so this slipped past both. **Plan-review (6 reviewers) REJECTED a `gh` throttle-shim 6/6** — metering shim invocations ≠ API calls (`gh run watch`=1 invocation/many calls), an always-on hot-path interceptor on every gh call diverges from the default-passthrough hook philosophy, and a stale mkdir-lock after kill-9 would deadlock all gh. **Fixes (stay in the two-layer model):** (1) **Rule 3** in `gh-poll-block.sh` blocks `(until|while)+gh workflow run+do+sleep` dispatch loops (bypass `# FORCE-DISPATCH`). (2) **Rule 4** = per-session dispatch budget (warn 25/hr, block 60/hr; per-session-keyed file so NO cross-process lock). (3) **Reaper** `is_gh_loop` broadened to `gh (run …|api|workflow run)` + ps prefilter `gh (run|api|workflow)` so it kills long-lived dispatch loops too (Codex/parallel/crashed); `for`-loops still NOT matched (legit batch loops). All proven: 8/8 hook cases + 9/9 reaper cases incl. live decoy. **GitHub App token (15k/hr, 3×) evaluated + DEFERRED** — needs an hourly JWT→installation-token refresh daemon (reintroduces the expiring-token machinery just tamed 2026-06-28); revisit only if R1–R3 prove insufficient. Detail: `~/.config/gh-dispatch-guard/README.md`. **Key lesson: the guards were scoped to ONE call shape (read-poll loops); a different shape (dispatch volume) bypassed them entirely. When adding a gh-quota guard, enumerate ALL high-volume call types (run list/view/watch, api, workflow run), not just the one that burned you last time.**

**Vercel-API fallback for deploy verification (no GitHub calls):** When GitHub is rate-limited (or to avoid spending quota), confirm a commit is deployed via Vercel's API + local git ancestry:
```bash
TOKEN=$(grep -E '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"' )
curl -s "https://api.vercel.com/v6/deployments?projectId=prj_wmBnDUrCQCwabIAYPbnMiIP3wg15&target=production&limit=6" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.deployments[] | "\(.state) \(.meta.githubCommitSha[0:10])"'
# Then: a READY deploy whose sha is a descendant of your commit means you're live:
git merge-base --is-ancestor <your-commit> <ready-deploy-sha> && echo "deployed live"
```
This is the canonical "pushed ≠ deployed" check when GitHub is unavailable. See [[feedback_vercel_api_access.md]].

**Two layers of prevention (added 2026-05-23, extended 2026-06-29):**
1. **PreToolUse block** — `~/.claude/hooks/gh-poll-block.sh`. Rule 1: rejects `(until|while) + gh (run list|view|api|watch) + sleep + do` read-poll loops. Rule 2: blocks manual `gh workflow run "Deploy to Vercel"` (bypass `# FORCE-DEPLOY`). **Rule 3 (2026-06-29): blocks `(until|while) + gh workflow run + sleep + do` dispatch loops** (bypass `# FORCE-DISPATCH`). **Rule 4 (2026-06-29): per-session `gh workflow run` budget — warn 25/hr, block 60/hr** (`GH_DISPATCH_WARN`/`GH_DISPATCH_HARD`; bypass `# FORCE-DISPATCH`); state in `~/.config/gh-dispatch-guard/count-<session>.log`, per-session-keyed so no cross-process lock.
2. **Zombie reaper** — `~/.claude/hooks/gh-zombie-reap.sh` finds shells > 5 min old matching the polling-loop signature and kills them. Triggered by SessionStart (every new Claude session) AND launchd (`~/Library/LaunchAgents/com.tompryor.gh-zombie-reap.plist`, every 120s as of 2026-06-21, independent of Claude). **Matcher is pipe-agnostic three-grep form — do not revert to a single `[^|]`-gated regex (see Sixth incident).** As of 2026-06-29 the matcher also covers `gh workflow run` (ps prefilter `gh (run|api|workflow)`) so it kills dispatch loops too; `for`-loops stay unmatched (legit finite batch loops). Logs to `~/.claude/gh-zombie-reap.log`. **A `gh` throttle-shim was considered and rejected 6/6 in plan-review (see Seventh incident) — keep rate-limiting in this hook+reaper model, never a hot-path interceptor on the gh binary.**

**How to apply:**
- Get run ID once: `gh run list --limit 1 --json databaseId --jq '.[0].databaseId'`
- Then watch it: `gh run watch <id>` — blocks, uses long-polling, rate-limit safe. `gh run watch` is the ONLY safe pattern for waiting on a run.
- Or: use `gh api repos/OWNER/REPO/actions/runs` directly (doesn't hit workflow-listing endpoint)
- Or: check once after a fixed wait, report to user, move on to other work
- **Never** chain `sleep N && gh run X` in a `while`/`until` loop — applies to `gh run list`, `gh run view`, AND `gh api`.
- **When pushing multiple repos in sequence:** push all repos first, THEN get the single final run ID and watch it once. Don't watch intermediate cancelled runs.
- If you suspect zombie loops: `ps aux | grep -E 'gh (run|api)' | grep -v grep` — also check `~/.claude/gh-zombie-reap.log` for what the reaper already killed.
- Manually run the reaper: `~/.claude/hooks/gh-zombie-reap.sh`
