'use strict';

const name = 'critics-take-present';
const description = 'Composite score exists but Critics Take (critic-consensus.json) is missing or empty';

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (show.compositeScore == null) {
    return { ok: true, severity: 'ok', message: 'No compositeScore yet — Critics Take not required' };
  }

  const entry = context.criticConsensusDoc[show.id];
  const hasSummary = entry && typeof entry.summary === 'string' && entry.summary.trim().length > 0;

  if (!hasSummary) {
    return {
      ok: false,
      severity: 'warning',
      message: `Composite score exists (${show.compositeScore}) but Critics Take is missing; run: node scripts/generate-critic-consensus.js --show=${show.id}`,
      details: { compositeScore: show.compositeScore, entry: entry || null },
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `Critics Take present for ${show.id} (score: ${show.compositeScore})`,
  };
}

module.exports = { name, description, run };
