/**
 * Opportunistic score recovery for ingest-manual-review.js.
 *
 * Why this exists: manual paste of a NYSR/TimeOut/UK-stars review usually
 * captures the article body but drops the header line that holds the star
 * rating (e.g. NYSR's `<p class="text-xl">★★☆☆☆`). Result: opening-night
 * manual ingests land with originalScore=null even when the outlet has a
 * dedicated extractor that would have read the rating verbatim from HTML.
 *
 * Rocky Horror 2026-04-23 hit this on both NYSR critics (Verini, Sommers).
 * Each had explicit ★★☆☆☆ in the page header but landed null; the LLM
 * ensemble then guessed Sommers at 57 vs the verbatim 40. Manual patch.
 *
 * The collect-review-texts.js path already calls extractScore on freshly
 * fetched HTML (verified live 2026-04-25 against the RHS Verini URL — pulls
 * 2/5 stars correctly). The gap is the manual-ingest path: it never sees
 * HTML.
 *
 * Scope: pure decision logic — `recoverFromText` is sync and free, runs the
 * fallback text-anchor extractor on whatever was pasted. `recoverFromUrl`
 * adds an opportunistic fetchPage call when the outlet has a dedicated
 * extractor and a URL was provided. fetchPage is injectable for tests.
 */

const { extractScore, OUTLET_EXTRACTORS } = require('./score-extractors');

function _hasDedicatedExtractor(outletId) {
  if (!outletId) return false;
  const ext = OUTLET_EXTRACTORS[outletId.toLowerCase()];
  if (!ext) return false;
  return ext.name !== 'noScoreExtractor';
}

/**
 * Try to recover a score from already-pasted text. Sync, no I/O.
 * Returns { originalScore, normalizedScore, source } or null.
 */
function recoverFromText(text, outletId) {
  if (!text || !outletId) return null;
  const result = extractScore('', text, outletId);
  if (!result || result.normalizedScore == null) return null;
  return result;
}

/**
 * Try to recover a score by fetching the outlet URL and running the
 * dedicated extractor against the HTML. Async, network-dependent.
 *
 * Returns null when the outlet has no dedicated extractor (we don't fetch
 * just to run generic extractors — too noisy on outlets that don't publish
 * scores). Returns null when the fetch fails — manual ingest should
 * proceed without auto-extracted stars rather than block.
 *
 * @param {string} url
 * @param {string} outletId
 * @param {object} [options]
 * @param {Function} [options.fetchPage] Injected fetcher for tests
 * @param {Function} [options.log] Injected logger; defaults to console.log
 */
async function recoverFromUrl(url, outletId, options = {}) {
  if (!url || !outletId) return null;
  if (!_hasDedicatedExtractor(outletId)) return null;
  const fetchPage = options.fetchPage || require('./scraper').fetchPage;
  const log = options.log || (() => {});
  let result;
  try {
    result = await fetchPage(url, { method: 'auto' });
  } catch (e) {
    log(`  ⚠ recoverFromUrl: fetch threw: ${e.message}`);
    return null;
  }
  const html = (result && (result.content || result.html)) || '';
  if (!html) {
    log(`  ⚠ recoverFromUrl: no html returned (${result && result.method})`);
    return null;
  }
  const extracted = extractScore(html, '', outletId);
  if (!extracted || extracted.normalizedScore == null) {
    log(`  ⚠ recoverFromUrl: extractor returned null on ${html.length}-char html`);
    return null;
  }
  return extracted;
}

module.exports = {
  recoverFromText,
  recoverFromUrl,
  _hasDedicatedExtractor,
};
