---
name: Temporal-override bypass leaks meta-essays + cross-production roundup-excerpts
description: STRONG_DIFFERENT_SHOW_MARKERS in review-guards.js misses "different production" / "film review of" / "meta-essay" phrasings — leaks two distinct wrongProduction classes through the opening-week temporal override
type: feedback
originSessionId: e7b3a0c6-0043-4044-85c5-a47649d7da87
archived: true
---
**Status (2026-05-09):** BOTH classes now fixed systematically.

- Class 2 (film-review): commit `9fed93285f` — narrow patterns in STRONG_DIFFERENT_SHOW_MARKERS catch explicit "this/scraped content is a film/movie review of …" CV phrasings.
- Class 1 (different-production-at-different-venue): commit `14c58bfdbb` — `hasNamedDifferentDirectorSignal()` extracts "directed by X" from CV, compares last name to show.creativeTeam directors, bypasses temporal override when CV-named director isn't in expected AND scrapedText doesn't mention actual director ≥2x. Prerequisite: shows.json director accuracy (14 corrections shipped 2026-05-08 via Phase 0 critic-consensus audit; commits 93eaabcf + 30d81ad2 + abfa15fd in private repo). Phase 0 + Phase 1 design notes in Notion card `35a637c5-416f-8139-a4b9-c346719faecf`.

Open follow-up: shows with no `creativeTeam.Director` entry (or co-directors) skip the bypass — the named-entity check requires single-director shows.json metadata. Future improvement: add producer/lead-actor extraction for additional safety net.

The temporal override (review-guards.js fix #14) downgrades LLM-flagged wrongProduction to "low confidence" for reviews within 30 days of opening, on the theory the LLM is mistaking a real near-opening review for a different production. STRONG_DIFFERENT_SHOW_MARKERS bypasses the override when the CV reasoning contains unambiguous "different show / not in / completely different" phrasing.

**Why:** 2026-05-08 user (drubins24) flagged that hamlet-off-broadway-2026 (BAM Harvey, Robert Hastie/Hiran Abeysekera production) was scoring 91 on a single Front Row Center review of *Teatro La Plaza's* TFANA Hamlet — clearly a different OB production. CV correctly identified `wrongProduction:true` with reasoning naming the venue mismatch, but `[OVERRIDE: review within 0d of opening, likely correct production]` re-included it. Same gap also leaked `vulture--bilge-eberi.json`, a Bilge Ebiri meta-essay/film review of Riz Ahmed's Hamlet film, which scored 71 and was included.

**How to apply:** When a wrongProduction-class data issue surfaces near opening, check the CV reasoning for these patterns that the bypass currently misses:
- "different (off-broadway )?production" — production explicitly named different
- "different theater" / "different venue" — venue-explicit mismatch (RISKY: legit transfers like London → BAM say this; only safe to bypass when reasoning ALSO names the wrong specific production)
- "film review of" / "movie adaptation" / "cinematic elements" — wrong-medium meta-essays
- "not a review of (a/the/an) (off-broadway )?(theater )?production" — explicit non-review

Don't ship a regex-only fix without a corpus probe. The Hamlet BAM transfer is itself an example: London-run reviews would say "at the National Theatre" — different theater — but it's the SAME production. Naive `/different theater/i` would block legitimate transfer reviews. Strong markers must require BOTH a venue/production-mismatch phrase AND an explicit different-production identifier.

Manual data fix recipe (when override gap leaks a review near opening):
1. Set root-level `wrongProduction: true`, `wrongProductionNote`, `contentTier: 'invalid'` on the review-text JSON
2. Don't just rely on `contentVerification.wrongProduction` — `isIncludableForRebuild` gates on the root flag
3. Commit + push private review-texts repo
4. Trigger rebuild-reviews; wait; verify
