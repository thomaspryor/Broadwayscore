'use strict';
/**
 * headline-classifier.js — Heuristics for deciding whether an article
 * title/URL looks like a theatre review (vs. a preview, list, interview, etc.).
 *
 * Exported from scripts/lib/author-pages/ for use by audit and future
 * multi-source author-page scanners.
 */

module.exports = { looksLikeReview };

/**
 * Return true if the title + URL combination looks like a review article.
 *
 * @param {string} title
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeReview(title, url) {
  const t = (title||'').toLowerCase();
  const u = (url||'').toLowerCase();
  const excludes = ['remembering ', 'obituary', 'in memoriam', 'best theater of', 'best plays of', 'best broadway shows', 'best of 20', 'preview ', 'what to see', '5 things', 'q&a', 'interview with', 'behind the scenes', 'what we', 'how to', 'most anticipated', 'tony nominat', 'tony predict', 'tony win', 'list:', 'shows we', 'plays we', "we can't wait", 'ate the lea', "valerie cherish"];
  if (excludes.some(e => t.includes(e))) return false;
  if (t.includes('review')) return true;
  if (t.match(/[★]/)) return true;
  if (u.includes('review')) return true;
  if (u.includes('theater-review')) return true;
  return false;
}
