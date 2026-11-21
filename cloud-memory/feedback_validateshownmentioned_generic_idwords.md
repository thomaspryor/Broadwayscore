---
name: feedback-validateshownmentioned-generic-idwords
description: "recover-serp-text.js / any validateShowMentioned() caller can rubber-stamp wrong-show content when the show title is made of common English words — spot-check bulk recovery output against the real title, not just contentTier"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ec642dd9-4596-462f-9777-43dc83dcf6f6
  modified: 2026-08-03T19:48:59.980Z
---

validateShowMentioned() (scripts/lib/content-quality.js) derives idWords from showId by stripping the year and splitting on hyphens. For shows whose title IS common English words (e.g. "A Woman Among Women" -> woman/among/women/broadway), Check 2's `idWords.length >= 2` match-count fallback can validate completely unrelated articles that happen to contain 2+ of those generic words — caught live in task #914 when a bulk `recover-serp-text.js` variety.com sweep wrote contentTier=complete over a Keith David profile and a Pink/Tony-Awards news piece, both with zero relation to the actual show. Both files had a prior, correct `incompleteReason=url_content_mismatch` rejection that the recovery script's write path silently overrode.

**Why:** the bug is invisible from aggregate stats alone — the sweep's summary just reports "recovered: N" with no signal that N includes wrong-show contamination. Only a per-file spot-check against the actual show title caught it.

**How to apply:** before trusting any `recover-serp-text.js` (or similar bulk recovery script) "recovered" count, spot-check a sample of the actual `fullText` against the show's real title — not just checking `contentTier`. This risk is highest for shows with common-word titles (any word in the idWords list that's also ordinary English vocabulary).

**FIXED 2026-08-03 (card #947, commit 7f4ddb63a32 on main):** `GENERIC_ID_WORDS` stoplist added to `scripts/lib/content-quality.js`. `validateShowMentioned()` Check 2/3, `verifyFullTextContent()`, and `validateContentMentionsShow()` now all filter idWords through it before using them as match evidence — if every idWord for a show is generic, these checks decline to validate rather than falling back to the generic words. Only Check 1 (exact title substring) can then confirm such a show. `content-quality.js` was also added to `scoring-delta.js`'s `INCLUSION_FILES` watchlist (it wasn't actually there despite CLAUDE.md rule 12 claiming so — real gap, now closed).

**Residual gap (NOT fixed, lower priority — untouched by #947 on purpose):** `verifyFullTextContent`'s separate TITLE-word 50% match (content-quality.js ~2193-2213, splits the literal title string into words and checks if half+ appear in text) has the SAME generic-word weakness but works off the title itself, not the showId. E.g. a show titled entirely in common words could still over-match via this path even with idWords correctly filtered. Untouched because it's a much higher-blast-radius mechanism (used by nearly every real title match, not just common-word-titled shows) — would need its own dedicated, carefully-tested session if further contamination surfaces through it.
