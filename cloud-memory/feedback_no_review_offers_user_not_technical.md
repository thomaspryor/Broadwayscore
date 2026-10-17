---
name: no-review-offers-user-not-technical
description: "Never offer the user a \"review the diff\" or \"commit vs review\" choice — user is non-technical, just commit and push"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8703a0b6-023f-4b53-a141-7517054a5c95
---

Never offer the user a choice like "want me to commit + push, or ExitWorktree so you can review the diff?" — and don't offer "review the diff first" in any form. The user is non-technical and does not review diffs.

**Why:** User explicitly said "I'm not technical. I don't review diffs. I thought that was clear in the rules and files" (2026-05-23). Project CLAUDE.md and global CLAUDE.md both say "Don't stop to ask obvious questions. If the next step is clear, just do it." After verified work in a worktree, the obvious next step is commit + push + merge to main + ExitWorktree + verify deploy — not asking for confirmation.

**How to apply:** When work in a worktree is verified-green, proceed directly through the wrap-up chain: commit → push branch → merge to main → push main → ExitWorktree (remove) → monitor deploy → /wrap-up. Do not pause for a "do you want me to..." question between these steps. Only stop if you hit a real blocker (failing test, merge conflict that needs a decision, missing credentials).

Related: [[next-steps-actionable]], [[no-premature-handoff]], [[terse-output-default]].
