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
 * Multi-show isolation (isolateMultiShowSection) still runs after this on the
 * save path only; it needs the show title and can refuse the page outright.
 */
const { cleanText, stripTrailingJunk } = require('./text-cleaning');
const { stripExemptedChrome } = require('./content-quality');

/** Entity decode, whitespace and banner chrome: the save path's first step. */
function preCleanForStorage(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  return stripExemptedChrome(cleanText(raw) || raw);
}

/** The body as it will be stored: preCleanForStorage plus trailing junk removal. */
function textAsStored(raw) {
  const pre = preCleanForStorage(raw);
  if (typeof pre !== 'string' || !pre.trim()) return pre;
  return stripTrailingJunk(pre) || pre;
}

module.exports = { preCleanForStorage, textAsStored };
