'use strict';
/**
 * One stored review record with its page furniture removed (BRO-7171 Stage
 * 5). Used by scripts/clean-page-furniture-corpus.js; the rules live in
 * page-furniture.js, the same module cleanText applies at fetch time.
 * Pure, no I/O. scripts/lib/page-furniture.test.mjs.
 */

const crypto = require('crypto');
const { stripPageFurniture, detectPageFurniture } = require('./page-furniture');

const TRIM_REASON = 'page furniture removed (BRO-7171 Stage 5)';

/** Why a record is left alone, or null when it may be cleaned. */
function skipReason(d) {
  if (!d || typeof d.fullText !== 'string' || !d.fullText) return 'no-text';
  if (d._locked === true) return 'locked';
  // Text a person pasted or approved stays as they left it.
  if (d.fetchMethod === 'manual-entry' || d.sourceMethod === 'manual-entry') return 'manual-entry';
  // A Theatre Record lift breadcrumb (BRO-6154) is read off fullTextTrimmed;
  // overwriting it would drop the lift's wrongProduction clear.
  if (d.fullTextTrimmed && /BRO-6154/.test(String(d.fullTextTrimmed.reason || ''))) return 'tr-lift-breadcrumb';
  return null;
}

/**
 * The record with its furniture cut, or null when nothing changes.
 * @returns {null|{record: object, removed: {category: string, line: string}[]}}
 */
function cleanRecord(d, at) {
  if (skipReason(d)) return null;
  const text = stripPageFurniture(d.fullText);
  if (text === d.fullText || !text || !text.trim()) return null;
  const removed = detectPageFurniture(d.fullText);
  const out = { ...d, fullText: text };
  const words = text.split(/\s+/).filter(Boolean).length;
  for (const f of ['textWordCount', 'wordCount']) if (typeof out[f] === 'number') out[f] = words;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  if (out.llmPullQuote && !norm(text).includes(norm(out.llmPullQuote))) out.llmPullQuote = null;
  // Push restore must not read the old (longer) copy as richer text
  // (review-write-guard _deliberateTextTrim); the hash names the exact prior.
  out.fullTextTrimmed = {
    reason: TRIM_REASON,
    fromLength: d.fullText.length,
    toLength: text.length,
    at,
    priorFullTextHash: crypto.createHash('sha256').update(d.fullText).digest('hex'),
    categories: [...new Set(removed.map((r) => r.category))].sort(),
  };
  return { record: out, removed };
}

module.exports = { cleanRecord, skipReason, TRIM_REASON };
