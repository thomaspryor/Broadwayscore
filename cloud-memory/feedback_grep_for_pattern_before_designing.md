---
name: Grep for an established pattern before designing a new one
description: Before designing a "safety net" / cross-workflow / dispatch pattern in this repo, grep for `gh workflow run X.yml` (or the equivalent for the system) and read 2 of the matches. Established patterns beat new designs.
type: feedback
originSessionId: 04ac0f2b-fed1-4a43-84b2-ce70cde9f1dd
archived: true
---
When the problem statement is "X workflow ran but downstream Y didn't fire," the first move is `grep -l "gh workflow run X" .github/workflows/` — the repo almost certainly already has 2-4 workflows solving the same problem. Read them. Use the same pattern.

A #21 (2026-04-26): the rebuild→deploy chain was missing for failure-conclusion cases. I designed a 211-line drift-detection poller (`deploy-on-data-change.yml`) keyed off `data/audit/deploy-watermark.json`. /ship-check (Codex + Claude subagent) flagged it as the wrong design — the right fix was a 5-line `gh workflow run vercel-deploy.yml` step at the end of `rebuild-reviews.yml` + `rebuild-fast.yml`, mirroring `gather-reviews.yml:472`, `update-show-status.yml`, `weekly-grosses.yml`, `opening-night-poller.yml`. Net: -211 lines + 31 × 2 lines.

**Why:** A poller introduces a runaway-loop failure mode (drift never resets if watermark update fails) that the simple dispatch doesn't have. Established patterns have absorbed real bugs already (15-min dedup window, `outcome == 'success'` gate). Inventing parallel infrastructure means re-discovering the same edge cases.

**How to apply:**
- Before writing >50 lines of "safety net" / "watcher" / "drift detector" workflow code: grep for the verb you'd use ("dispatch", "trigger", "rebuild", "notify"), find 2 existing implementations, copy the shape.
- If the answer is "no workflow does this" — fine, you're inventing. But verify the gap is real, not just "I didn't search."
- If a reviewer (`/ship-check`, `/plan-review`) says "the simpler fix is X, used in Y", weight that heavily. Both reviewers converging on the same simpler design is near-certain evidence.

**Counter-rule:** sometimes the established pattern IS the bug (e.g., 4 workflows all using a brittle approach). In that case, fix the pattern, don't add a 5th workflow. But "fix the pattern" is still preferable to "add a parallel system."

**Bonus learning:** Don't trust a reviewer's confident claim about platform mechanics without a 30-second verification grep. Claude subagent claimed "GITHUB_TOKEN cannot dispatch workflows from scheduled runs" — disproven in 60 sec by `grep -B 25 "gh workflow run vercel-deploy" .github/workflows/update-show-status.yml | grep GH_TOKEN` showing 4 production scheduled workflows using exactly that. Verify before fixing.
