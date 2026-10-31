'use strict';
/**
 * Apply an operator's explicit --critic to an --unknown review file (BRO-5166).
 *
 * createOrMergeReviewFile never writes criticName on a merge (it is an identity
 * key), so ingest-review-from-url.js --critic onto an --unknown file always
 * failed its stale-merge check. Hit by every TB forum-thread husk that
 * recover-talkinbroadway-forum-links.js upgraded to its review page with a
 * resolved critic (human-things-off-broadway-2026, 2026-10-12).
 *
 * Goes through the writer's guarded applyPageByline (plausible name, not an
 * outlet name or credited creative, same-outlet sibling and outlet-url
 * checks). Only when the write's url actually landed on the file: if the
 * writer kept the old url (and old body), naming it for the new page's critic
 * would misattribute that content. A refusal leaves the file untouched and the
 * caller's stale-merge check fails as before.
 *
 * @returns {{applied: boolean, newPath?: string, reason?: string}}
 */
function applyExplicitCriticToUnknown(filepath, landed, { showId, criticName, url, pageText = null }) {
  const path = require('path');
  if (!criticName || !filepath || !/--unknown\.json$/.test(path.basename(filepath))) {
    return { applied: false, reason: 'not-unknown-file' };
  }
  if (!landed || !/^unknown$/i.test(String(landed.criticName || '').trim())) {
    return { applied: false, reason: 'already-named' };
  }
  const { canonicalReviewUrl } = require('./review-url-clusters');
  if (!url || !landed.url || canonicalReviewUrl(landed.url) !== canonicalReviewUrl(url)) {
    return { applied: false, reason: 'url-not-landed' };
  }
  const { applyPageByline } = require('./review-file-writer');
  return applyPageByline(filepath, landed, {
    showId, criticName, source: 'ingest-review-from-url --critic', pageText,
  });
}

module.exports = { applyExplicitCriticToUnknown };
