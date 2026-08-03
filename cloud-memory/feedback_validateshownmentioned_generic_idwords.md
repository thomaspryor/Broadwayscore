---
name: feedback-validateshownmentioned-generic-idwords
description: "recover-serp-text.js / any validateShowMentioned() caller can rubber-stamp wrong-show content when the show title is made of common English words — spot-check bulk recovery output against the real title, not just contentTier"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ec642dd9-4596-462f-9777-43dc83dcf6f6
  modified: 2026-08-03T14:29:39.061Z
---

validateShowMentioned() (scripts/lib/content-quality.js) derives idWords from showId by stripping the year and splitting on hyphens. For shows whose title IS common English words (e.g. "A Woman Among Women" -> woman/among/women/broadway), Check 2's `idWords.length >= 2` match-count fallback can validate completely unrelated articles that happen to contain 2+ of those generic words — caught live in task #914 when a bulk `recover-serp-text.js` variety.com sweep wrote contentTier=complete over a Keith David profile and a Pink/Tony-Awards news piece, both with zero relation to the actual show. Both files had a prior, correct `incompleteReason=url_content_mismatch` rejection that the recovery script's write path silently overrode.

**Why:** the bug is invisible from aggregate stats alone — the sweep's summary just reports "recovered: N" with no signal that N includes wrong-show contamination. Only a per-file spot-check against the actual show title caught it.

**How to apply:** before trusting any `recover-serp-text.js` (or similar bulk recovery script) "recovered" count, spot-check a sample of the actual `fullText` against the show's real title — not just checking `contentTier`. This risk is highest for shows with common-word titles (any word in the idWords list that's also ordinary English vocabulary). See [[project_p0_validateshownmentioned_fix]] for the tracked fix (card #947, dispatched workspace:115) — until that lands, treat any recover-serp-text.js sweep involving a common-word-titled show as unverified until spot-checked.
