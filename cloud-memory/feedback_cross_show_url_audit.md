---
name: Cross-show URL misattribution pattern
description: gather-reviews SERP discovery assigns reviews to wrong shows — audit via URL slug cross-reference catches them
type: feedback
archived: true
---

gather-reviews pipeline assigns reviews to wrong shows via SERP discovery. The URL slug clearly belongs to Show B but the file is stored under Show A. This corrupts scores when the misattributed file gets LLM-scored.

**Why:** SERP discovery finds review URLs but doesn't validate that the URL's slug matches the target show before filing. Long-running WE shows (Phantom, Mamma Mia, Matilda) are most affected because they have few recent reviews and the pipeline eagerly assigns new-show reviews to them.

**How to apply:** After any bulk gather-reviews run on WE or new market, audit review-texts with URL slug cross-reference (compare URL path against all show title slugs). The audit script pattern: for each review file, check if the URL path contains a different show's title slug but NOT the assigned show's title slug. Delete matches + their LLM scores.
