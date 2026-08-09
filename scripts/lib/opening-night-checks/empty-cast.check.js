'use strict';

const { hasEmptyCast } = require('../opening-night-completeness.js');

const name = 'empty-cast';
const description = 'Show has no cast entries at/near opening — discovery likely skipped cast enrichment';

// Historical backfill entries (status=closed) are out of scope — this gate is
// for shows that are about to be publicized, not the historical catalogue.
const SKIP_STATUSES = new Set(['closed']);

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (SKIP_STATUSES.has(show.status)) {
    return { ok: true, severity: 'ok', message: `Status is ${show.status} — cast completeness not checked` };
  }

  if (!hasEmptyCast(show)) {
    return { ok: true, severity: 'ok', message: `Cast has ${show.cast.length} entr${show.cast.length === 1 ? 'y' : 'ies'}` };
  }

  return {
    ok: false,
    severity: 'warning',
    message: `cast is empty for ${show.id} — source from review JSON-LD or a major review body; Broadway shows can also try: node scripts/backfill-cast.js --show-filter=${show.id} --force`,
    details: {
      showId: show.id,
      // Self-declared remediation (task #1132, extending #389). backfill-cast.yml
      // already exposes show_filter + force for exactly this single-show case.
      remediation: {
        kind: 'workflow',
        key: `empty-cast:${show.id}`,
        workflow: 'backfill-cast.yml',
        inputs: { show_filter: show.id, force: 'true' },
        reason: 'cast is empty at/near opening',
      },
    },
  };
}

module.exports = { name, description, run };
