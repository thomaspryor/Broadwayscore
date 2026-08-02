/**
 * Manual-entry merge — the LAST write into reviews.json during a rebuild.
 *
 * manual-review-direct.js writes `manualEntry: true` reviews straight into
 * reviews.json. Every rebuild has to carry those forward, because the pipeline
 * regenerates reviews.json from review-texts and would otherwise drop them.
 *
 * The danger: this merge runs AFTER every dedup pass (URL dedup, outlet-name
 * dedup, fingerprint dedup). Anything it appends is appended unchecked. So the
 * match between a manual entry and its pipeline twin must be robust, or the
 * manual entry lands as a permanent phantom duplicate that no later pass can
 * ever collapse.
 *
 * Two ways the old showId+outletId+lowercased-criticName match failed live
 * (both confirmed in reviews.json 2026-08-02):
 *   - punctuation drift — "R. Scott Reedy" (manual) vs "R Scott Reedy"
 *     (pipeline byline capture) on wonder-regional-2026
 *   - byline disagreement — manual says "Chris Jones", the scraper captured
 *     "Christopher Borrelli", same Chicago Tribune article on iceboy-regional-2026
 *
 * Fix is two-layered:
 *   1. criticKey() folds punctuation + diacritics, so cosmetic byline drift
 *      still matches.
 *   2. When the name match fails, fall back to the URL. Same show + same outlet
 *      + same article URL is the same review no matter whose name is on it —
 *      so it REPLACES rather than appends. The URL is the identity of record.
 *
 * @see scripts/rebuild-all-reviews.js (sole caller)
 */

/**
 * Punctuation- and diacritic-insensitive critic key.
 * "R. Scott Reedy" and "R Scott Reedy" collapse to "r scott reedy".
 * "Kelly O'Hara" and "Kelly OHara" collapse to "kelly ohara".
 */
function criticKey(name) {
  if (!name || typeof name !== 'string') return 'unknown';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')       // drop periods, apostrophes, hyphens
    .replace(/\s+/g, ' ')
    .trim() || 'unknown';
}

/**
 * Find the pipeline-produced review a manual entry corresponds to.
 * Name match first (the common case); URL match as the identity backstop.
 *
 * @param {object} manual - the manualEntry review
 * @param {object[]} reviews - pipeline-produced reviews
 * @param {(url: string) => string|null} normalizeUrl - caller's URL canonicalizer
 * @returns {{ review: object, matchedBy: 'critic'|'url' }|null}
 */
function findPipelineTwin(manual, reviews, normalizeUrl) {
  const sameSlot = (r) => r.showId === manual.showId && r.outletId === manual.outletId;

  const wantCritic = criticKey(manual.criticName);
  const byCritic = reviews.find(r => sameSlot(r) && criticKey(r.criticName) === wantCritic);
  if (byCritic) return { review: byCritic, matchedBy: 'critic' };

  // Byline disagreement — same article, different name on it. The URL decides.
  const wantUrl = manual.url ? normalizeUrl(manual.url) : null;
  if (!wantUrl) return null;
  const byUrl = reviews.find(r => sameSlot(r) && r.url && normalizeUrl(r.url) === wantUrl);
  if (byUrl) return { review: byUrl, matchedBy: 'url' };

  return null;
}

/**
 * Merge manual entries into the rebuilt review set, in place.
 *
 * Rules, in order:
 *   - twin has scoreSource 'human-review' → pipeline already consumed the
 *     manual score from the source file; it is authoritative, skip.
 *   - twin has a score → replace it (a human score beats an LLM score).
 *   - no twin at all → append (a genuinely pipeline-less manual review).
 *
 * @param {object[]} reviews - mutated in place
 * @param {object[]} manualEntries
 * @param {(url: string) => string|null} normalizeUrl
 * @returns {{preserved: number, appended: number, matchedByUrl: number}}
 */
function mergeManualEntries(reviews, manualEntries, normalizeUrl) {
  let preserved = 0;
  let appended = 0;
  let matchedByUrl = 0;

  for (const manual of manualEntries) {
    const twin = findPipelineTwin(manual, reviews, normalizeUrl);

    if (twin && twin.review.scoreSource === 'human-review') continue;

    if (twin && twin.review.assignedScore) {
      const idx = reviews.indexOf(twin.review);
      if (idx >= 0) reviews[idx] = manual;
      preserved++;
      if (twin.matchedBy === 'url') matchedByUrl++;
      continue;
    }

    if (!twin) {
      reviews.push(manual);
      preserved++;
      appended++;
    }
    // twin exists but has no score: pipeline knows the slot, manual adds
    // nothing scoreable — appending here would duplicate, so do nothing.
  }

  return { preserved, appended, matchedByUrl };
}

module.exports = { criticKey, findPipelineTwin, mergeManualEntries };
