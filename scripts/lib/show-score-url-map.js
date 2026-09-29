/**
 * URL-to-show grouping for audit-show-score-urls.js (BRO-3471).
 *
 * This is Check 1 from the audit script: given data/show-score-urls.json's
 * `shows` map (showId -> Show Score URL), group showIds by NORMALIZED url so
 * two entries that differ only by casing or a trailing slash still collide
 * as the same Show Score page, and any group with 2+ showIds is flagged.
 *
 * Previously this logic lived inline in audit-show-score-urls.js with no
 * test coverage of its own (scripts/lib/show-score-urls-baseline.js only
 * tests what happens AFTER duplicates are found — the baseline diff, not the
 * grouping that produces them). Per CLAUDE.md rule 15 ("never copy logic
 * into test files — extract to scripts/lib/ and require() it"), this module
 * is what the CLI and the test both call, so a regression in the grouping
 * itself (e.g. losing the normalization) fails a real test instead of
 * silently reimplementing the same bug in the test file.
 *
 * Pure — no fs. audit-show-score-urls.js reads data/show-score-urls.json and
 * passes the parsed `.shows` object in.
 */
'use strict';

const { normalizeUrl } = require('./show-score-urls-baseline');

// urlMap: { showId: url } as stored in data/show-score-urls.json's `shows`
// key. Returns [{ url, showIds }] for every normalized URL claimed by 2+
// showIds. `url` is the raw (non-normalized) url from whichever entry was
// seen first, so the report still shows real data instead of the
// normalized form.
function findDuplicateUrls(urlMap) {
  // Map, not a plain object: a url normalizing to a name like "constructor"
  // would otherwise resolve to an inherited Object.prototype value instead
  // of undefined, skip the group-init branch, and crash on .showIds.push
  // (matches this codebase's existing byX-grouping idiom, e.g. arm-yield.js).
  const byNormalizedUrl = new Map();
  for (const [showId, url] of Object.entries(urlMap || {})) {
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!byNormalizedUrl.has(key)) byNormalizedUrl.set(key, { url, showIds: [] });
    byNormalizedUrl.get(key).showIds.push(showId);
  }
  return [...byNormalizedUrl.values()].filter((entry) => entry.showIds.length > 1);
}

// BRO-4055: the writer-side guard. A hand-removed mapping (e.g. BRO-3416
// deleting "she-loves-me-1994" because Show Score has exactly one She Loves
// Me page and it describes the 2016 revival, not the 1993-94 original) kept
// coming back because every writer that assigns urlData.shows[id] = url only
// checked "does THIS showId already have a url" — never "does this URL
// already belong to a DIFFERENT showId". A slug-guessing discovery pass (or
// a listings/shard merge) would then happily re-match the newly-uncached show
// back onto the same page, recreating the exact wrong-production mapping a
// human had just removed.
//
// Call this BEFORE writing urlData.shows[showId] = url. It returns the
// OTHER showId already claiming that (normalized) url, or null if the
// assignment is safe. Callers must skip the write when this returns
// non-null — see scripts/scrape-show-score-audience.js,
// scripts/discover-show-score-urls-from-listings.js,
// scripts/merge-show-score-shards.js, scripts/discover-new-shows.js.
function findConflictingShowId(urlMap, showId, url) {
  if (!url) return null;
  const key = normalizeUrl(url);
  for (const [id, existingUrl] of Object.entries(urlMap || {})) {
    if (id === showId || !existingUrl) continue;
    if (normalizeUrl(existingUrl) === key) return id;
  }
  return null;
}

/**
 * True when HTML is Show Score's "not found" page. Show Score serves
 * <title>The page you were looking for doesn't exist (404)</title> with a
 * "404 &ndash; Not Found" heading; the scraper used to look only for
 * "Page not found" / "404 -", missed it, and treated a dead cached URL as a
 * transient fetch failure it kept retrying forever (BRO-4358).
 */
//
// Deliberately strict: a true result deletes a cached URL, so it only matches
// Show Score's own 404 template, never a page carrying a JSON-LD
// aggregateRating (a real show page whose review text happens to say "404").
function isShowScoreNotFoundPage(html) {
  if (!html || typeof html !== 'string') return false;
  if (/"aggregateRating"/.test(html)) return false;
  return /<title>[^<]*doesn(?:'|&#39;|’)t exist \(404\)/i.test(html)
    || /404\s*(?:&ndash;|–)\s*Not Found/i.test(html);
}

/**
 * What to do with a cached URL that returned Show Score's 404 page, given the
 * result of rediscovering the show (BRO-4358). Pure so it can be tested.
 *   'keep'    — rediscovery found the SAME url valid again (a one-off 404), or
 *               the per-run rediscovery budget is spent: leave the cache as is.
 *   'replace' — a different valid page that no other show owns.
 *   'drop'    — nothing usable found: uncache it so the next run's listings
 *               discovery gets another go.
 */
function decideDeadUrlAction({ deadUrl, rediscoveredUrl, conflictId, budgetLeft }) {
  if (!(budgetLeft > 0)) return 'keep';
  if (rediscoveredUrl && rediscoveredUrl === deadUrl) return 'keep';
  if (rediscoveredUrl && !conflictId) return 'replace';
  return 'drop';
}

module.exports = { findDuplicateUrls, findConflictingShowId, isShowScoreNotFoundPage, decideDeadUrlAction };
