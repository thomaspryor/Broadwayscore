// Same-title-family check for show ids, shared by tests/unit/show-hero-integrity.test.mjs
// and scripts/check-image-aspect.js (BRO-6748). Two ids are related when, after dropping
// leading articles and the trailing year / market suffix, one id's title tokens are a
// prefix of the other's or they share their first two tokens. A one-word match is not
// enough: the-lion-king and the-lion-in-winter must not excuse each other.
'use strict';

// Different titles, same production lineage (a Broadway retitle).
const RELATED_GROUPS = [
  ['wanted-2022', 'gun-and-powder-regional-2020', 'gun-and-powder-signature-regional-2020', 'gun-and-powder-paper-mill-regional-2024'],
];
const ARTICLES = new Set(['the', 'a', 'an']);
const SUFFIX_TOKENS = new Set(['west', 'end', 'off', 'broadway', 'regional', 'national', 'tour', 'return']);

function titleTokens(id) {
  const tokens = id.split('-').filter(Boolean);
  while (tokens.length > 1 && (/^\d{4}$/.test(tokens[tokens.length - 1]) || SUFFIX_TOKENS.has(tokens[tokens.length - 1]))) tokens.pop();
  while (tokens.length > 1 && ARTICLES.has(tokens[0])) tokens.shift();
  return tokens;
}

function related(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  let common = 0;
  while (common < ta.length && common < tb.length && ta[common] === tb[common]) common++;
  if (common === Math.min(ta.length, tb.length) || common >= 2) return true;
  return RELATED_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

module.exports = { related, titleTokens, RELATED_GROUPS };
