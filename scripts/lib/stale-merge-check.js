/**
 * stale-merge-check.js — BRO-3790
 *
 * createOrMergeReviewFile's merge-into-existing path (review-file-writer.js
 * _mergeIntoExisting) only fills fields that are currently blank on the
 * existing file — url is further gated by maybeUpgradeUrl's own "existing
 * content is bad" check, and criticName is never merged at all (it's only
 * used as an identity key, not a mergeable field). A caller that re-ingests
 * against a show+outlet whose file already has a non-blank (but wrong)
 * url/criticName/fullText therefore gets back `action: 'updated'` — the
 * writer DID write something (e.g. a metadata field) — while the exact
 * value the caller was trying to correct silently stays the old one. The
 * caller has no way to tell "my correction landed" from "something
 * unrelated changed" without checking.
 *
 * findStaleMergeFields is that check: it diffs the caller's INTENDED values
 * against what actually landed on disk, so a caller like
 * ingest-review-from-url.js can refuse to report success when a field it
 * explicitly asked to set didn't take.
 */

'use strict';

/**
 * @param {object} intended - fields this write attempted to establish, keyed
 *   by field name. Omit a key entirely (don't pass it as null/undefined) when
 *   the caller has no opinion on it — e.g. criticName was auto-extracted
 *   rather than explicitly supplied, so a mismatch there isn't a correction
 *   that failed to land, just a value nobody asked to change.
 * @param {object} landed - the record actually read back from disk after the
 *   write, e.g. `JSON.parse(fs.readFileSync(result.filepath, 'utf8'))`.
 * @returns {string[]} field names where the intended value did not land.
 */
function findStaleMergeFields(intended, landed) {
  const stale = [];
  for (const key of Object.keys(intended)) {
    if (intended[key] == null) continue;
    if (!landed || landed[key] !== intended[key]) stale.push(key);
  }
  return stale;
}

/**
 * Mirrors review-normalization.js's maybeUpgradeUrl `badContent` gate
 * exactly: true when the pre-existing file actually needed fixing (so
 * checking whether a field like fullText landed is meaningful), false when
 * it was already good (so a fresh re-extraction landing something slightly
 * different — site chrome, rotating ad copy — is not staleness). The
 * writer's own url-upgrade guard already treats "good content, don't touch"
 * as intentional, not a defect; findStaleMergeFields must agree, or a
 * caller re-ingesting a URL that resolves to a page with even trivially
 * different incidental text would see every already-correct file flagged
 * stale.
 *
 * @param {{data: object}|null} preExisting - findExistingReviewFile's return
 *   value, read BEFORE the write this check verifies (or null/undefined
 *   when no matching file existed — a fresh create, always "bad" in the
 *   sense that there's nothing yet to compare against).
 * @returns {boolean}
 */
function isPreExistingContentBad(preExisting) {
  const data = preExisting && preExisting.data;
  if (!data) return true;
  return !data.fullText
    || (data.contentTier != null && data.contentTier !== 'complete')
    || !!data.needsRefetch;
}

function _words(text) {
  const { foldDiacritics } = require('./title-match');
  return foldDiacritics(String(text || '').toLowerCase()).replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function _shingles(words, n) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/**
 * BRO-4431: true when `incomingText` is a longer copy of the SAME article as
 * the file's stored body, and that stored body is not a complete one. The
 * writer's merge only fills blank fields, so a truncated body (a paywall cut,
 * a 105-word e-edition fetch) was never replaced by a later fuller fetch of
 * the same page: the Golden Boy Daily Mail submission (issue 908) failed on
 * exactly that. Same article = at least half of the stored body's 5-word
 * shingles appear in the incoming text, or the stored body's first 15 words
 * do (a stub that is one lede sentence plus sign-up boilerplate), so a
 * different page that merely shares the url never replaces it.
 * @param {object} existing  record on disk
 * @param {string} incomingText
 * @returns {boolean}
 */
function isSameArticleBodyUpgrade(existing, incomingText) {
  if (!existing || typeof incomingText !== 'string') return false;
  const before = typeof existing.fullText === 'string' ? existing.fullText : '';
  if (!before) return false; // blank bodies already fill through the merge
  if (existing.manualContentTier || existing._locked === true) return false;
  // A split parent holds one section of the article; a re-ingest bringing
  // the whole article back lets the fan-out re-plan (re-trim, or undo a
  // wrong split). Only the lede test below applies to it.
  const splitParent = existing.multiShowSplitParent === true;
  if (!splitParent && !isPreExistingContentBad({ data: existing })) return false;
  const next = incomingText.trim();
  if (next.length < before.length + 200 || next.length < before.length * 1.25) return false;
  const oldWords = _words(before);
  const newWords = _words(next);
  // The stored stub's opening (a lede captured before a paywall/sign-up
  // wall) found in the incoming text is the same article.
  if (oldWords.length >= 15) {
    const lede = oldWords.slice(0, 15).join(' ');
    if ((' ' + newWords.join(' ') + ' ').includes(' ' + lede + ' ')) return true;
  }
  if (splitParent) return false;
  const oldShingles = _shingles(oldWords, 5);
  if (oldShingles.size < 8) return false;
  const newShingles = _shingles(newWords, 5);
  let shared = 0;
  for (const s of oldShingles) if (newShingles.has(s)) shared++;
  return shared / oldShingles.size >= 0.5;
}

module.exports = { findStaleMergeFields, isPreExistingContentBad, isSameArticleBodyUpgrade };
