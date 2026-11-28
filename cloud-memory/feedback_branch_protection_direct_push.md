---
name: branch-protection-direct-push
description: "GitHub branch protection's required_status_checks DOES block a direct push of a brand-new commit outright (GH006) — corrected 2026-08-18 after the opposite claim caused a live production outage"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a31f4cef-d4fa-40ec-bd4d-c390619e6577
  modified: 2026-08-18T01:15:41.612Z
---

**CORRECTED 2026-08-18 (BRO-378) — the original claim below ("required_status_checks only gates PR merges, never blocks a direct push") is WRONG, or at minimum was true only under conditions this repo no longer has.** Trusting the original version of this memory caused a live production outage: BRO-378 applied `enforce_admins:true` + `required_status_checks` (no `required_pull_request_reviews`) to main on the strength of this file's original claim, then a real bot workflow's direct push (Update Deploy Watermark, run 32087193625) was rejected outright on all 3 retries:

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Required status check "Lint Workflows" is expected.
```

Reverted within 3 minutes; no data lost (the bot's retry-with-rebase discarded its own unpushed local commit safely). Root cause: `required_status_checks` requires the pushed commit's exact SHA to already have a passing check run recorded against it. A commit made directly (not via a branch GitHub already ran CI against) can never satisfy that — GitHub rejects the push before any check has a chance to run, independent of `enforce_admins` or the pushing identity's permission level.

**Conclusion: there is no configuration of classic GitHub branch protection with a non-empty `required_status_checks` list that leaves a direct-push-to-main architecture working.** Not a matter of finding the right flag combination — `required_status_checks` alone, even without `required_pull_request_reviews`, blocks every direct push of a new commit. The only way to have both "required checks" and direct pushes is `required_pull_request_reviews` OFF and `required_status_checks` OFF entirely (today's Broadwayscore baseline: `allow_force_pushes:false` + `allow_deletions:false` only).

**How to apply:**
- Never assume `required_status_checks` alone is a "free" hardening step against a direct-push repo. Test it live on a real workflow before trusting it (a disposable branch does NOT reproduce this — GitHub returns the SAME rejection there; the safe test is dispatching a real low-risk production workflow and reading its push step's actual output, exactly as BRO-378 did).
- If the user wants true gate enforcement for direct pushes, the only path is `required_pull_request_reviews` (no direct pushes at all) — which itself requires migrating every direct-push workflow off `git push origin main` first (GitHub Rulesets with a bypass-actor list for bot identities is the likely mechanism; untested as of 2026-08-18).
- Source of truth for main's protection state is now `scripts/setup-branch-protection.js` (`SAFE_TARGET` vs `FULL_ENFORCEMENT_TARGET`, the latter marked not-safe-to-apply) — read that file's header before touching branch protection again, don't re-derive from this memory alone.

See also: [[worktree-code-changes]] for the related discipline of using worktrees.
