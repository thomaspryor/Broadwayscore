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

module.exports = { findDuplicateUrls };
