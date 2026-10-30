'use strict';

/**
 * quickTitleCheck: does a fetched aggregator page's <title> name this show?
 * Extracted from gather-reviews.js (BRO-6676, CLAUDE.md §15) so it can be
 * tested. Word overlap alone accepted DTLI's /shows/the-heart/ (a page about
 * "The Heart of Rock and Roll") for "The Heart" (Laura Pels, 2026): every word
 * of the short title is in the longer one. The containing-title guard
 * (title-containment.js, BRO-4953) already protected the roundup validators;
 * this closes the same hole on the DTLI/aggregator page picks.
 *
 * @returns {boolean} true when the page appears to be about this show (or
 *   cannot be validated: no <title> tag).
 */
const { titleWordsMatchWithConfidence } = require('./show-matching');
const { findContainingTitleSibling } = require('./title-containment');

function quickTitleCheck(html, showTitle, { log = console.log, shows } = {}) {
  const titleMatch = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return true; // No title tag = can't validate, accept
  const pageTitle = titleMatch[1];
  const result = titleWordsMatchWithConfidence(showTitle, pageTitle);
  if (!result.matched) {
    log(`    [TITLE MISMATCH] Page title "${pageTitle.trim().slice(0, 80)}" doesn't match "${showTitle}" (${result.matchCount}/${result.threshold} words)`);
    return false;
  }
  const containing = findContainingTitleSibling(pageTitle, showTitle, shows ? { shows } : {});
  if (containing) {
    log(`    [TITLE MISMATCH] Page title "${pageTitle.trim().slice(0, 80)}" names the longer show "${containing.sibling}", not "${showTitle}"`);
    return false;
  }
  return true;
}

module.exports = { quickTitleCheck };
