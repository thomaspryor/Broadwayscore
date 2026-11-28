---
name: claude-reference
description: "Subsystem reference pointed at by CLAUDE.md (\"For full details on any subsystem\"). Currently: landing code on main (land/** + land.yml) and relaunching claude in cmux tabs with the login token (relaunch-claude-tab, BRO-4065)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1b8e216e-b214-4b9e-b18a-f2019d09e761
  modified: 2026-09-20T23:06:04.039Z
---

## Landing code on main (BRO-3425 / BRO-3873 steps 4-5, 2026-09-20)

Sessions land via `bash scripts/merge-worktree-to-main.sh` from their worktree. It runs the local floors on the branch tree, pushes the tip to `land/<branch>`, and waits for `.github/workflows/land.yml` (delta-vs-base gates on the rebased tree, serialized fast-forward, ancestry verification, ref delete, a row in `data/audit/landings.jsonl`) using `scripts/lib/wait-for-run.sh` semantics (one API call per 60s+, 45 min cap), then prints `LANDED: <branch> → <sha> in <s>s via land/<branch> (<run>)` or `REFUSED: … at gate '<name>'` with the digest conditionKey `land:land/<branch>`. It never checks out, merges into, or stashes on the shared `/Users/tompryor/Broadwayscore` checkout. A worktree whose copy of the script is older than origin/main's (`MERGE_SCRIPT_VERSION`) re-execs origin/main's copy automatically. Direct `git push … main` from a session is refused twice: by `~/.claude/hooks/pre-push-review-gate.sh` at the Bash tool (row `direct-push-attempt` in `data/audit/dispatch-ledger.jsonl`) and by `scripts/hooks/pre-push` (`scripts/lib/direct-push-guard.sh`); bots keep their direct push (CI, or `scripts/lib/push-with-retry.sh`, which exports `PUSH_WITH_RETRY_CALLER=bot`). `.github/workflows/check-direct-push-to-main.yml` digests any non-bot main sha with no landings row (`direct-push:<sha>`). Rollback flags: `LAND_LEGACY_DIRECT=1` (script → old shared-main merge+push), `LAND_ENFORCE_OFF=1` (both hooks), repo variable `DIRECT_PUSH_DETECT_OFF=1` (detector).

## Relaunching claude in a cmux tab (BRO-4065, 2026-09-23)

Every claude authenticates ONLY via `CLAUDE_CODE_OAUTH_TOKEN` (`~/.config/claude/keychain-sentinel.sh` purges the keychain login every 5 min). Claude Code strips that var from its own Bash tool env, and launchd / `cmux respawn-pane` never had it, so a claude started from any of those comes up "Not logged in". Never tell the owner to /login. Sanctioned paths: `node scripts/relaunch-claude-tab.js --workspace workspace:N [--dry-run]` restarts a tab's claude INSIDE that tab's own shell (resumes the same session, confirms the prompt is back); `scripts/lib/relaunch-claude-tab.sh [--cwd DIR] <claude args>` is the wrapper that re-exports the token from .env before exec'ing claude (use it for any claude you start yourself). `scripts/cmux-auth-stall-watchdog.js` (launchd, every 5 min) does the same repair automatically for logged-out tabs (1 try per tab per 30 min, never a busy tab) and only marks ❓ when it fails. Note: current claude DRAWS the ctx status bar while logged out; the signal is the "Not logged in · Run /login" notice as the last line (`scripts/lib/cmux-auth-stall.js`).
