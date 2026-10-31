---
name: preserve-parallel-session-colors
description: "When porting Claude Design output to code, preserve color changes shipped by parallel sessions (e.g. award scorecard colors) instead of swapping in Claude Design's palette"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7629c19b-aab2-4de3-97d5-39e361803450
---

When porting a Claude Design scorecard redesign to code, **preserve the score-box / tier-badge / accent colors that were shipped by a different session** rather than swapping in the palette Claude Design proposed.

**Why:** During the show-page card redesign work (2026-05-17), the user shipped award-scorecard color changes in a parallel session and liked the result. Claude Design's redesign output also proposed colors, but the user explicitly said the parallel-session colors should win.

**How to apply:**
- Before porting any redesigned card, `git log --oneline -- <card-file>` to spot recent color-related commits from other sessions.
- If colors differ between Claude Design's mock and the current code: **default to current code**, change only the layout/structure/typography to match Claude Design.
- Specifically applies to: `AwardScoreCard.tsx`, score badges, audience grade colors, tier accents, status pills.
- Sacred-score-badge rule already covers size/position/shape — this rule covers *color* on the broader card surface.
- If Claude Design's color genuinely improves a thing the parallel session didn't touch, surface the diff to the user before changing it. Don't silently overwrite.

**ALSO applies to color-consistency fixes:** When two elements have mismatched colors, unify toward the MORE distinctive/intentional color — not the default brand color. 2026-05-17: tried to fix Opera logo inconsistency by pulling header down to muted Broadway bronze (`text-gradient`). Wrong direction — user wanted page body brought UP to the distinctive bright amber (`from-amber-400 to-amber-500`). Always ask: "is the brighter color intentional?" before dulling it.

Related: [[design-system]] · [[feedback_visual_verify_before_push]]
