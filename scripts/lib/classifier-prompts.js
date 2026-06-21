/**
 * Pure prompt builders for the wrong-production / wrong-show classifiers.
 *
 * Extracted from scripts/classify-wrong-production.js and
 * scripts/classify-wrong-show.js so the opera-aware branching can be tested
 * directly (per CLAUDE.md rule 15: extract → export → require() in tests).
 *
 * No I/O, no module-level state — all dependencies passed as parameters.
 */

const {
  isOperaShow,
  getOperaWrongProductionContext,
  getOperaWrongShowContext,
} = require('./opera-prompt-context');

/**
 * Build the wrong-PRODUCTION classifier user prompt.
 *
 * @param {Object} params
 * @param {Object} params.show - The show record (must have type, title)
 * @param {Object} params.result - The audit result (showId, showYear, outlet, criticName, publishDate, signals)
 * @param {Object} params.reviewData - Review text sources (fullText, bwwExcerpt, dtliExcerpt, showScoreExcerpt, pullQuote)
 * @param {Array<{id: string, openingDate?: string}>} params.revivals - Prior productions of the same work
 * @returns {string}
 */
function buildWrongProductionUserPrompt({ show, result, reviewData, revivals }) {
  const showTitle = show?.title || result.showTitle;
  const showYear = result.showYear;
  const isOpera = isOperaShow(show);

  const revivalLines = (revivals || []).map(r => {
    const ry = r.openingDate ? new Date(r.openingDate).getFullYear() : '?';
    return `  - ${r.id} (${ry})`;
  }).join('\n');

  const text = reviewData.fullText
    || reviewData.bwwExcerpt
    || reviewData.dtliExcerpt
    || reviewData.showScoreExcerpt
    || reviewData.pullQuote
    || '';

  let truncated = text;
  if (text.length > 3000) {
    truncated = text.substring(0, 2000) + '\n\n[...truncated...]\n\n' + text.substring(text.length - 1000);
  }

  // Market-aware framing. Labelling a West End / Off-Broadway production as a
  // "Broadway opening" makes the LLM read the correctly-filed local-market
  // review as a mismatch (the Phantom 1986 West End premiere FP, 2026-06-21).
  // Derive the market label from show.market so the FILED-UNDER line names the
  // right house, and keep the candidate header market-neutral since revivals
  // span markets (Broadway revival, West End transfer, tour).
  const market = (show && show.market) || 'broadway';
  const marketLabel = market === 'west-end' ? 'West End'
    : market === 'off-broadway' ? 'Off-Broadway'
    : market === 'off-west-end' ? 'Off-West-End'
    : 'Broadway';

  // Opera-aware framing — see scripts/lib/opera-prompt-context.js for the
  // rationale. WRONG_PRODUCTION for opera means a different Met run, not
  // that the work has been performed at other opera houses.
  const filedUnderLabel = isOpera
    ? `FILED UNDER PRODUCTION: ${result.showId} (Metropolitan Opera run opening: ${showYear})

${getOperaWrongProductionContext()}`
    : `FILED UNDER PRODUCTION: ${result.showId} (${marketLabel} opening: ${showYear})`;

  return `SHOW: "${showTitle}"
${filedUnderLabel}
OUTLET: ${result.outlet || 'Unknown'}
CRITIC: ${result.criticName || 'Unknown'}
PUBLISH DATE: ${result.publishDate || 'Unknown'}

${isOpera ? 'PRIOR MET PRODUCTIONS OF THIS WORK:' : 'OTHER PRODUCTIONS OF THIS SHOW (any market — other Broadway/West End mountings, transfers, tours):'}
${revivalLines || '  (none known)'}

AUDIT SIGNALS THAT FLAGGED THIS REVIEW:
${(result.signals || []).map(s => '  - ' + s).join('\n')}

REVIEW TEXT:
${truncated || '(no text available)'}`;
}

/**
 * Build the wrong-SHOW classifier user prompt.
 *
 * @param {Object} params
 * @param {Object} params.show - The show record (must have type)
 * @param {string} params.showTitle
 * @param {string} params.showId
 * @param {string} params.text - The review text to evaluate
 * @returns {string}
 */
function buildWrongShowUserPrompt({ show, showTitle, showId, text }) {
  const truncated = text.length > 2000 ? text.substring(0, 2000) : text;
  const isOpera = isOperaShow(show);
  const operaContext = isOpera ? `\n\n${getOperaWrongShowContext()}\n` : '';

  return `Show: "${showTitle}" (${showId})${operaContext}\n\nReview text (first ${Math.min(text.length, 2000)} chars):\n${truncated}`;
}

module.exports = {
  buildWrongProductionUserPrompt,
  buildWrongShowUserPrompt,
};
