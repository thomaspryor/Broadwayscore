---
name: Three cross-show dedup guards (gather + rebuild URL + rebuild text-fp)
description: The pipeline has THREE separate cross-show dedup checks; bypassing one is not enough for test shows. _skipCrossShowDupe must hit all three.
type: feedback
originSessionId: b2030ae3-d1b1-48aa-bbf4-b0db0216c7c2
archived: true
---
The Broadway Scorecard pipeline has **three independent cross-show dedup guards**, not one:

1. **gather-reviews.js `getGlobalUrlIndex()`** — rejects URLs already claimed by another show during gather (counts as "crossShow" rejection in summary)
2. **rebuild-all-reviews.js `crossShowUrlIndex`** (line ~897) — URL-based cross-show check during rebuild
3. **rebuild-all-reviews.js `crossShowFingerprints`** (line ~2558) — TEXT-fingerprint-based cross-show check (sha256 of normalized fullText). This catches identical review text even when URLs differ.

**Why:** Discovered during 2026-04-19 Express pipeline simulation. After patching #1 and #2 for `_skipCrossShowDupe` shows, simulation still dropped 11 of 17 reviews. Investigation found `[EXCLUSION] reason: skippedCrossShowDupe` in rebuild logs traced to the third check — a text-fingerprint dedup separate from URL dedup.

**How to apply:** Any test show using `_skipCrossShowDupe` must bypass all three. Reverse: when adding new dedup logic, search for ALL existing cross-show checks (`grep -nE "crossShow|skipCrossShow|crossShowFingerprints|globalUrlIndex"`) and ensure the bypass flag works uniformly. Also: when debugging "why was this review dropped," don't stop at the URL dedup — check the text-fingerprint dedup too.

Commits implementing the bypass:
- gather (URL): `55669c941b`
- rebuild URL: `c23c74d81b`
- rebuild text-fp: `e309ddf638` (rebased from `15bc8c582b`)
