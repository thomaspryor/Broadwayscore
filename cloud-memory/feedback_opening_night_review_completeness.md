---
name: Opening night review completeness rule
description: "Every BWW RR + DTLI review scored and live before declaring opening done."
type: feedback
archived: true
---

**For every Broadway opening, the Opening Night process is not complete until every review cited on the BWW Review Roundup page AND every review on the DTLI page is scored and live on the site.**

**Why:** Comprehensiveness is the site's positioning. BWW RR and DTLI are the two canonical aggregators that critics, publicists, and subscribers reference. If they cite a review and we don't have it, we look incomplete. Hitting parity-plus-one with each is the bar that justifies "the most comprehensive Broadway scorecard."

**How to apply:**
- This is a rule for the **Opening Night process** (gathering, scoring, validation) — not for the email broadcast script. The broadcast is downstream and uses its own (looser) gate.
- During opening-night runs and morning-after audits, cross-reference BWW RR and DTLI for each opening show. Any cited critic missing from `data/review-texts/{showId}/` is a gap that must be filled before declaring the opening done.
- Build automation: a script that scrapes BWW RR + DTLI for an opening and reports which outlets the site is missing would be high value.
- Don't conflate this with the broadcast gate (`feedback_broadcast_quality_bar.md`). That one is "≥1 more than BWW RR" as a soft warning at send time. This is "100% of BWW RR + 100% of DTLI" as a process requirement.
