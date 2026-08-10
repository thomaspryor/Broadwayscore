'use strict';

const { hasEmptyCast } = require('../opening-night-completeness.js');
const { isBroadwayCategory } = require('../venue-classification.js');

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

  // IBDB (backfill-cast.js / backfill-cast.yml) is Broadway-only — dispatching
  // it for an Off-Broadway or West End show can never find cast data, no
  // matter how many times it retries (task #1223: this is why
  // empty-cast:isla-off-broadway-2026 escalated twice and never resolved).
  // backfill-cast-web.js/.yml is the web-search path those markets actually use.
  const isBroadway = isBroadwayCategory(show);
  const workflow = isBroadway ? 'backfill-cast.yml' : 'backfill-cast-web.yml';
  const inputs = isBroadway
    ? { show_filter: show.id, force: 'true' }
    : { show_filter: show.id, category: show.category || 'all', force: 'true' };
  const tryCommand = isBroadway
    ? `node scripts/backfill-cast.js --show-filter=${show.id} --force`
    : `node scripts/backfill-cast-web.js --show-filter=${show.id} --force`;

  return {
    ok: false,
    severity: 'warning',
    message: `cast is empty for ${show.id} — source from review JSON-LD or a major review body; can also try: ${tryCommand}`,
    details: {
      showId: show.id,
      // Self-declared remediation (task #1132, extending #389; routing fixed
      // by task #1223). Both workflows expose show_filter + force for exactly
      // this single-show case.
      remediation: {
        kind: 'workflow',
        key: `empty-cast:${show.id}`,
        workflow,
        inputs,
        reason: 'cast is empty at/near opening',
      },
    },
  };
}

module.exports = { name, description, run };
