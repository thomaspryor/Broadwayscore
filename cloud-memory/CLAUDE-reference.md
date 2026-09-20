---
name: claude-reference
description: "Subsystem reference pointed at by CLAUDE.md (\"For full details on any subsystem\"). Currently: how sessions land code on main (land/** + land.yml, BRO-3425/BRO-3873)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1b8e216e-b214-4b9e-b18a-f2019d09e761
  modified: 2026-09-20T23:06:04.039Z
---

## Landing code on main (BRO-3425 / BRO-3873 steps 4-5, 2026-09-20)

Sessions land via `bash scripts/merge-worktree-to-main.sh` from their worktree. It runs the local floors on the branch tree, pushes the tip to `land/<branch>`, and waits for `.github/workflows/land.yml` (delta-vs-base gates on the rebased tree, serialized fast-forward, ancestry verification, ref delete, a row in `data/audit/landings.jsonl`) using `scripts/lib/wait-for-run.sh` semantics (one API call per 60s+, 45 min cap), then prints `LANDED: <branch> → <sha> in <s>s via land/<branch> (<run>)` or `REFUSED: … at gate '<name>'` with the digest conditionKey `land:land/<branch>`. It never checks out, merges into, or stashes on the shared `/Users/tompryor/Broadwayscore` checkout. A worktree whose copy of the script is older than origin/main's (`MERGE_SCRIPT_VERSION`) re-execs origin/main's copy automatically. Direct `git push … main` from a session is refused twice: by `~/.claude/hooks/pre-push-review-gate.sh` at the Bash tool (row `direct-push-attempt` in `data/audit/dispatch-ledger.jsonl`) and by `scripts/hooks/pre-push` (`scripts/lib/direct-push-guard.sh`); bots keep their direct push (CI, or `scripts/lib/push-with-retry.sh`, which exports `PUSH_WITH_RETRY_CALLER=bot`). `.github/workflows/check-direct-push-to-main.yml` digests any non-bot main sha with no landings row (`direct-push:<sha>`). Rollback flags: `LAND_LEGACY_DIRECT=1` (script → old shared-main merge+push), `LAND_ENFORCE_OFF=1` (both hooks), repo variable `DIRECT_PUSH_DETECT_OFF=1` (detector).
