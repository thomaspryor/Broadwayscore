---
name: feedback_aggregator_archive_stale_and_crossshow
description: "Local aggregator-archive can be stale vs the canonical private repo; validate roundup archives at the PAGE level (verifyAggregatorUrl), never per review URL"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0cf9a96a-8567-444e-a617-d2cc5c1e199f
---

Two linked lessons about `data/aggregator-archive/` roundup archives, from the
2026-06-29 census-hardening session.

**1. Local working copy can be STALE vs the canonical private repo.** The archives
live in `thomaspryor/broadway-review-texts` (cloned at `data/review-texts/aggregator-archive/`);
`data/aggregator-archive/` is just the working copy CI checks out. They drift. I
found War Horse's local theatre-reviews archive was the *Equus* roundup and almost
shipped a census fix + deleted it as "contaminated" — but the **canonical private
repo had the correct War Horse roundup all along**; only my local copy was stale
(the session-start "STALE LOCAL DATA" warning was real). **Before concluding an
archive is mis-saved, check it in the private repo** (`data/review-texts/aggregator-archive/...`),
not just the local working copy. The genuinely-wrong one (Phantom-1986 = the High
Noon roundup) was wrong in the canonical repo too — that's the real signal.

**2. Validate a roundup archive at the PAGE level, not per review URL.** Combined/
mis-saved roundups (a War Horse page that's actually Equus) contaminate the census.
The safe guard is `verifyAggregatorUrl({url, html, show})` from
`scripts/lib/show-match-verifier.js` — it checks the roundup PAGE's `<title>` /
canonical slug / venue against the show. **Do NOT filter per individual review URL
by title-token overlap** — outlets slug reviews by star/headline (Cabaret →
`/eddie-redmayne-kit-kat-club`), so per-entry token matching false-drops legitimate
reviews (a ship-check P0). The page names its own show; per-entry URLs don't.
`review-census.js` applies this only to `validate:true` sources (theatre-reviews);
a `no-significant-title-tokens` verdict means *can't judge* (zero-token titles like
"2:22") → **fail open**, don't reject. Related: [[feedback_ship_check_finds_real_bugs.md]],
[[feedback_prod_show_json_abbreviated_keys.md]], [[feedback_review_texts_not_symlink.md]].
