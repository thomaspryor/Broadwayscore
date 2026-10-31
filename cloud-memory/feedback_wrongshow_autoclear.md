---
name: wrongShow auto-clear bypass
description: Rebuild auto-clears wrongShow for London shows with UK outlet URLs; use contentVerification.wrongArticle instead
type: feedback
archived: true
---

The rebuild (rebuild-all-reviews.js line 1558) auto-clears `wrongShow` flags for London shows when the review URL is from a UK outlet domain. This is intentional — UK outlets reviewing London shows are almost never wrong-show — but it means `wrongShow` alone CANNOT permanently exclude a London show review.

**Why:** Discovered during WE launch audit when Kinky Boots Clueless URL flags kept getting auto-cleared after every rebuild. Also affected Phantom OWE-2021 wrongProduction flags.

**How to apply:**
- To permanently exclude a review from a London show: set `contentVerification.wrongArticle = true` (rebuild checks this at line 1548 and won't auto-clear)
- `wrongShow = true` alone is unreliable for London/UK reviews — it will be cleared on next rebuild
- Also: data fixes in the review-texts private repo get overwritten by other sessions' `git pull` — always `git commit && git push` to the private repo, not just local file edits
