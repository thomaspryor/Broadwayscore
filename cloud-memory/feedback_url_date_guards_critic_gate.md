---
name: URL-date guards need criticName gate
description: Any ingest-time guard that flags based on URL-path date alone must gate on Unknown-byline criticName — named critics writing pre-transfer OB/London coverage trip the same heuristic.
type: feedback
originSessionId: 2f54af31-389c-4b33-a64a-e22e86bae89e
---
URL-date guards that decide wrongProduction based purely on URL path (e.g. `/2015/feb/18/`) will false-positive on named critics reviewing the SAME production at an earlier venue (Off-Broadway or London pre-transfer).

**Why:** Fallen-angels 2026-04-19 opening night. Extended the URL-path-year guard and ran a full-fleet dry run — surfaced 33 historical candidates. ~50% were FPs: Jesse Green / Ben Brantley / Michael Billington reviewing the Public Theater OB run or a West End pre-transfer. Hamilton 2015 Guardian `/2015/feb/18/` is the canonical case — Jesse Green correctly reviewing the OB run before the Broadway transfer. URL date alone can't distinguish "different show" from "same show, earlier venue." Named critics get benefit-of-the-doubt at ingest.

**How to apply:** For any ingest-time (gather-reviews.js) URL-date or URL-year guard:
1. Keep the pure URL-date helper criticName-agnostic (reusable for audit sweeps where human reviews each hit).
2. Wrap with a criticName gate for ingest: only flag when byline is empty / "Unknown" / "Staff" (case-insensitive, trimmed). Named critic → null.
3. Post-hoc sweep scripts (`flag-wrong-production-by-url-date.js`, `flag-wrong-production-pending.js`) can use either — but bulk-applying the raw helper without human audit will flag legitimate pre-transfer coverage.
4. Pattern is now in `scripts/lib/review-guards.js`: `getWrongProductionReasonFromUrl()` (pure) + `getWrongProductionReasonForUnknownCritic()` (wrapper with gate). Mirror this split for any future URL-path heuristic.

The Unknown-byline gate is cheap, preserves audit trail, and blocks the one real threat (SERP-derived Unknown-byline pollution from the wrong production) without killing Hamilton-class legitimate reviews.
