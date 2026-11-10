'use strict';

/**
 * Rows written only by the legacy LLM 'web-search' discovery step (BRO-5081).
 *
 * That step made up the row by itself: no aggregator or page ever vouched for
 * it, so its url, byline and excerpt fields (dtliExcerpt and friends) are the
 * step's own guesses. 0 of 34 reachable review pages contained the excerpt.
 * Pure, no I/O.
 *
 * The writer was gather-reviews.js searchForReview(), which asked Claude for a
 * review url WITHOUT web-search tools and wrote whatever came back tagged
 * source:'web-search' (deleted in df2f305f80e, Feb 2026: "271 fabricated
 * entries"). Its rows are still the bulk of the dead urls the gap engine hit
 * in BRO-7171 Stage 4 (WaPo 25/31, WSJ 15/16, New Yorker 10/12, NYT 4/5:
 * invented ids like ".../8c5c5a5a-e4a1-11e5-..._story.html",
 * "...-4c8b8c8a"). findWebSearchSourceWrites() is the class guard that keeps
 * any new code from writing that tag again (legacy-web-search.test.mjs).
 */
function isLegacyWebSearchOnly(data) {
  if (!data) return false;
  const sources = [].concat(data.sources || [], data.source || []).filter((x) => typeof x === 'string' && x);
  return sources.length > 0 && sources.every((x) => x === 'web-search');
}

// `source: 'web-search'`, `source = "web-search"`, `sources.push('web-search')`.
const WRITE_RE = /\bsources?\s*(?::|=(?!=)|\.push\(|\.add\()\s*\[?\s*['"`]web-search['"`]/g;

/**
 * Lines of `src` that tag a record source as 'web-search'. Comment lines are
 * ignored; comparisons (`=== 'web-search'`) are not writes. Pure.
 * @param {string} src
 * @returns {Array<{line:number, text:string}>}
 */
function findWebSearchSourceWrites(src) {
  const out = [];
  String(src || '').split('\n').forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    WRITE_RE.lastIndex = 0;
    if (WRITE_RE.test(text)) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

module.exports = { isLegacyWebSearchOnly, findWebSearchSourceWrites };
