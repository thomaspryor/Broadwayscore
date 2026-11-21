---
name: feedback_followup_card_check_prereq_merged
description: "A \"<X> follow-up\" card can be dispatched before <X>'s own PR is merged — check git log/gh pr view for the referenced function/file before starting, not after hitting a missing-symbol error"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1996cd86-ffa5-48dd-839a-b44d998588a2
  modified: 2026-08-20T20:49:09.931Z
---

Before implementing a "<Feature X> follow-up" card that references a specific function/file <X> introduced (e.g. "route remaining consumers through verifyCreativeTeamViaSerp() — Linear BRO-102"), verify <X>'s own PR is actually merged to main first: `grep -rn "<referenced symbol>" <expected file>` or `git log --oneline --all | grep <linear-id>` then check `gh pr view <n> --json state`. If it's still open, the follow-up card was created (or auto-dispatched) before the prerequisite landed.

**Why:** Task #1863 ("route remaining IBDB creativeTeam consumers through SERP verification, BRO-102 follow-up") referenced `scripts/auto-fix-show-data.js`'s `verifyCreativeTeamViaSerp()` as the reference implementation — but BRO-102 itself (PR #632) was still open, unmerged, on a separate branch (`job/linear-BRO-102-mt1wx1za`) in another worktree. The function didn't exist on main yet. This is a natural consequence of the P0/P1 auto-dispatch-at-creation rule: a reviewer can spot a gap in an in-flight fix and immediately card the follow-up, before the original fix has cleared CI/review.

**How to apply:** When a card's problem statement cites a specific function/file from a recent fix by name, don't assume it's on main. Grep for it first. If missing: check `gh pr list --head <branch>` for an open PR carrying it — if found, green + already reviewed, merge it yourself and rebase onto it before starting (don't wait idle or ask the user; this is a same-repo, same-author, already-reviewed dependency). If no such PR exists, the reference itself may be stale/wrong — flag it rather than building on a phantom API.
