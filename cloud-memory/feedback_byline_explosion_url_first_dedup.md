---
name: byline-explosion-url-first-dedup
description: Review files keyed by criticName explode into N same-URL files when the byline extractor is non-deterministic; dedup by URL-within-outlet. Detector + root-cause fix shipped 2026-07-04.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb6d1a98-ca47-495d-9746-d158749d341f
---

Some outlet pages (WhatsOnStage `/news/...review_XXXXX`, The Times) have an author list / non-deterministic byline area, so re-scrapes of the SAME review URL extract a DIFFERENT critic name each time. Review files are named `<outlet>--<slug(criticName)>.json`, so each variant is a NEW file → one URL accumulates as 9 same-body files. The write-guard marks them url-collision duplicates (circular `duplicateOf`), the real review's body gets classified `invalid`, and it never scores. This buried WhatsOnStage/Times reviews on both 2026 "A Midsummer Night's Dream" productions and Much Ado (Globe).

**Why:** `findExistingReviewFile` (scripts/lib/review-normalization.js) matched only by `(outlet, criticName)` — a URL is a review's identity, but it wasn't used.

**How to apply:**
- Detector: `node scripts/audit-review-url-clusters.js` flags any URL scraped into 5+ byline files (runs non-blocking in check-corpus-drift.yml). `findUrlClusters()` in scripts/lib/review-url-clusters.js.
- Root-cause fix (commit 9484a116b7): `findExistingReviewFile(showDir, outlet, critic, url)` Pass 0 matches by `canonicalReviewUrl` **within the same outlet** before criticName, so re-scrapes merge instead of spawning variants. The same-outlet gate is REQUIRED — aggregator roundup URLs (WET/Show-Score/Stagedoor) are legitimately shared across Telegraph/FT/Guardian star-stubs; URL-alone would collapse distinct reviews (see [[feedback_aggregator_roundup_urls_shared_across_outlets]]).
- **Do NOT hand-recover an already-exploded review.** It's a multi-flag whack-a-mole: write-guard re-marks the canonical as a dup → `contentTier:invalid` → `manualContentTier:complete` overridden on the junk body → `wrongShow:true` mis-flag. Needs the full 8-field manual-clear ([[feedback_manual_review_protection_fields]]); rarely worth it for one review. Existing clusters are a MIX of correct + wrong-production files (2024/2025 siblings) and can't be safely bulk-collapsed — /second-opinion killed a general `--fix` for this. Cleanup is per-show manual (Notion 393637c5-416f-8130).
- `canonicalReviewUrl` strips query/hash/slash; the write-guard's `normalizeUrl` keeps query — intentional divergence, the URL-dedup path is deliberately stronger.
- review-normalization.js is a score-source file → run scoring-delta + temporal regression before any edit ([[feedback_scoring_delta_required]]).
