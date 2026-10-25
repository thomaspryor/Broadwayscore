---
name: Roundup-sourced reviews vs roundup pages
description: Critical distinction — roundup-sourced reviews are legitimate; only roundup PAGES acting as reviews should be excluded
type: feedback
archived: true
---

Never auto-skip reviews based on roundup URL patterns (e.g., `/review-roundup/` in BWW URLs). Many legitimate individual critic reviews are SOURCED from roundup pages — the URL points to the roundup where the review was discovered, but the review has specific critic/outlet attribution and should count as an original review.

**Why:** Session incorrectly flagged 84 roundup-sourced reviews using generic URL patterns. Had to undo all 84. Only 6 actual roundup-pages-as-reviews exist (LBO roundups, WET pages with critic='West End Theatre').

**How to apply:** When writing roundup detection logic, only flag site-specific patterns where the roundup PAGE itself is the "review" (no individual critic attribution). Never use generic URL substring matching like `/review-roundup/` or `/round-up.*review/`.
