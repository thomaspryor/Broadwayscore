'use strict';
/**
 * One stored review record with its site chrome cut (BRO-5859). Used by
 * scripts/strip-leading-site-nav.js; rules live in text-cleaning.js.
 * Pure, no I/O. scripts/lib/site-nav-strip.test.mjs.
 */

const { stripSiteChrome } = require('./text-cleaning');

const TRIM_REASON = 'site navigation menu removed (BRO-5859)';

/** The record with its site chrome cut, or null when nothing changes. */
function stripRecord(d, at) {
  if (typeof d.fullText !== 'string' || !d.fullText || d._locked === true) return null;
  const text = stripSiteChrome(d.fullText);
  if (text === d.fullText || !text) return null;
  const out = { ...d, fullText: text };
  const words = text.split(/\s+/).filter(Boolean).length;
  for (const f of ['textWordCount', 'wordCount']) if (typeof out[f] === 'number') out[f] = words;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  if (out.llmPullQuote && !norm(text).includes(norm(out.llmPullQuote))) out.llmPullQuote = null;
  // Push restore must not read the old (longer) copy as richer text.
  out.fullTextTrimmed = { reason: TRIM_REASON, fromLength: d.fullText.length, toLength: text.length, at };
  return out;
}

module.exports = { stripRecord, TRIM_REASON };
