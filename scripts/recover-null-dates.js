#!/usr/bin/env node
/**
 * RETIRED (BRO-5614). This script wrote publishDate values parsed from review
 * URLs. CLAUDE.md rule 3: never extract metadata from URLs. A dateless review
 * is dated at rebuild time by scripts/lib/backfill-publish-date.js; a stored
 * publishDate must come from the review's own page or byline
 * (backfill-review-dates.js, backfill-network-tier-dates.js).
 */
console.error('recover-null-dates.js is retired (BRO-5614): URL-derived dates are never stored as publishDate. Use backfill-review-dates.js (page dates).');
process.exit(1);
