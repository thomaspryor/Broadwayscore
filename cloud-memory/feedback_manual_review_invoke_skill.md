---
name: Invoke /manual-review for user-spotted reviews
description: When user says "I saw a review for X on Y", call the manual-review skill FIRST — do not hand-roll ingest/score/push/verify.
type: feedback
originSessionId: 00820170-d165-434d-8637-b610ed7239c1
archived: true
---
When the user reports spotting a review ("I saw one on NY Sun", "here's a review I found", pastes review text), the first action is `Skill → manual-review`, not exploration.

**Why:** 2026-04-19 session to add ONE NY Sun review (Elysa Gardner / What Happened Was) took hours and huge token cost because I went freehand — discovered the paywall, tried the LLM ensemble scorer, debugged a skipped file, fought a corrupt private review-texts repo state, ran rebuild 3 times (2 cancelled), verified against the wrong JSON field names. The `/manual-review` skill exists specifically for "user pastes review" and would have walked the sanctioned path.

**How to apply:**
- User supplies URL or pasted review text → invoke `manual-review` skill on turn 1
- For user-spotted reviews, default to `ingest-manual-review.js --score=N` with `humanReviewScore` — the user already read it, they know the verdict. Do NOT route through the LLM ensemble scorer (it may skip files with `contentTier=complete` or other filters and waste 20+ min)
- If paywalled, try JSON-LD `articleBody` from the page source before Bright Data / SB / Playwright escalation
- Verify on the live site using compact keys: `rv` (reviews), `bd` (breakdown), `cs` (composite) — not `reviews`/`compositeScore`
- Authoritative reviews.json is `~/broadway-scorecard-data/reviews.json`, not `./data/reviews.json`
