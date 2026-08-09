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
  // critic-consensus.json uses 'text' field for the consensus blurb
  const hasText = entry && typeof entry.text === 'string' && entry.text.trim().length > 0;

  if (!hasText) {
    return {
      ok: false,
      severity: 'warning',
      message: `Composite score exists (${show.compositeScore}) but Critics Take is missing; run: node scripts/generate-critic-consensus.js --show=${show.id}`,
      details: {
        compositeScore: show.compositeScore,
        entry: entry || null,
        // Self-declared remediation (task #389). The checklist runner collects
        // details.remediation from every result — it does NOT switch on check
        // name — so a new check opts into auto-remediation by emitting this
        // field, exactly like details.missingReviews already works for the BWW
        // RR stub path (opening-night-checklist.js remediateMissingReviews).
        remediation: {
          kind: 'workflow',
          key: `critic-consensus:${show.id}`,
          workflow: 'update-critic-consensus.yml',
          inputs: { show: show.id, force: 'true' },
          reason: `composite ${show.compositeScore} with no Critics Take`,
        },
      },
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `Critics Take present for ${show.id} (score: ${show.compositeScore})`,
  };
}

module.exports = { name, description, run };
