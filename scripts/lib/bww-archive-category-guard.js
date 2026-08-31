'use strict';

const fs = require('fs');
const { validateRoundupPageTitle, isPunctuationFalsePositive } = require('./show-matching');

/**
 * Read a cached BWW archive file, but only trust it if it still passes the
 * same validateRoundupPageTitle() category check applied at write time
 * (BRO-2547's write-time guard).
 *
 * BRO-2549: a fresh mtime is not proof the file arrived via this scraper's
 * validated write path — a restore, a manual copy, a different writer, or a
 * rolled-back deploy can all put a poisoned file on disk with a fresh mtime,
 * and the old age-only check served it for up to 14 days regardless. When
 * the cached HTML fails the check here, the poisoned file is deleted so the
 * caller falls through to a fresh fetch, which the write-time guard then
 * protects again.
 *
 * Applies the SAME 'page-title-mismatch' rescue as the standing audit
 * (scripts/audit-aggregator-archive-integrity.js) via isPunctuationFalsePositive
 * — trailing punctuation, dotted acronyms, slash-joined titles, byline-prefixed
 * subtitles. Without it, a file the audit calls fine (rescued) would be purged
 * here on every read inside the 14-day window purely on a title-formatting
 * quirk, since the write-time guard this mirrors never applied that rescue
 * either. NOT applied to 'cross-market-sibling' — a distinct, deliberate check
 * per isPunctuationFalsePositive()'s own jsdoc.
 *
 * @param {string} archivePath
 * @param {number} maxAgeDays
 * @param {{title: string, category: string}} show
 * @param {string[]} [siblingCategories]
 * @returns {null|{valid: true, html: string, check: object}|{valid: false, purged: true, check: object}}
 *   null when there is no usable cache to consider (missing file, or older
 *   than maxAgeDays — the normal "go fetch fresh" case, not a validation
 *   failure).
 */
function readCachedArchiveIfValid(archivePath, maxAgeDays, show, siblingCategories) {
  if (!fs.existsSync(archivePath)) return null;
  const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
  if (age >= maxAgeDays) return null;

  const html = fs.readFileSync(archivePath, 'utf8');
  const check = validateRoundupPageTitle(html, show.title, show.category, siblingCategories);
  if (check.ok) {
    return { valid: true, html, check };
  }
  if (check.reason === 'page-title-mismatch' && isPunctuationFalsePositive(check.pageTitle, show.title)) {
    return { valid: true, html, check };
  }
  fs.unlinkSync(archivePath);
  return { valid: false, purged: true, check };
}

module.exports = { readCachedArchiveIfValid };
