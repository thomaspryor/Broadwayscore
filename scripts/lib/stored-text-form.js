'use strict';
/**
 * stored-text-form — the cleaning the collector applies to a fetched page
 * before it stores the body, in one place so the content verifier judges the
 * same text that gets saved (BRO-5243).
 *
 * Before this, verifyFetchedContent() sent the RAW fetch to the LLM while the
 * save path stored the cleaned body. burn-this-2019/wsj (2026-10-13): the raw
 * Browserbase fetch was 2,469 chars with unrelated WSJ headlines appended; the
 * verifier rejected it (high confidence: "junk appended", "ends abruptly"), the
 * save path stripped the junk to a 1,385-char body that ends on the critic's
 * sign-off, and the file kept isValid:false next to a contentTier of complete.
 *
 * Multi-show posts: the save path keeps only this show's section
 * (isolateMultiShowSection), so textAsStored does too when given the url and
 * show title. On a refusal the save path stores nothing, so the verdict is moot
 * and the un-isolated body is returned.
 */
const { cleanText, stripTrailingJunk } = require('./text-cleaning');
const { stripExemptedChrome } = require('./content-quality');
const { isolateMultiShowSection } = require('./multi-show-section-extract');

/** Entity decode, whitespace and banner chrome: the save path's first step. */
function preCleanForStorage(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  return stripExemptedChrome(cleanText(raw) || raw);
}

/**
 * The body as it will be stored: preCleanForStorage, this show's section of a
 * multi-show post (when url is given), then trailing junk removal.
 */
function textAsStored(raw, opts = {}) {
  return storedTextForm(raw, opts).text;
}

/**
 * textAsStored plus whether the save path will store nothing: a multi-show
 * post with no unique section for this show is refused there, so verifying
 * it is a wasted LLM call (BRO-5261).
 */
function storedTextForm(raw, { url = null, showTitle = '' } = {}) {
  let pre = preCleanForStorage(raw);
  if (typeof pre !== 'string' || !pre.trim()) return { text: pre, refused: false };
  if (url) {
    const iso = isolateMultiShowSection(url, pre, showTitle);
    if (iso.action === 'refuse') return { text: null, refused: true };
    if (iso.action === 'isolated') pre = iso.text;
  }
  return { text: stripTrailingJunk(pre) || pre, refused: false };
}

module.exports = { preCleanForStorage, textAsStored, storedTextForm };
