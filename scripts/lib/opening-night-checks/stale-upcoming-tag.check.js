'use strict';

const { hasStaleUpcomingTag } = require('../opening-night-completeness.js');

const name = 'stale-upcoming-tag';
const description = 'Show is status=open but still carries the "upcoming" tag from before it opened';

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (!hasStaleUpcomingTag(show)) {
    return { ok: true, severity: 'ok', message: `No stale 'upcoming' tag (status=${show.status})` };
  }

  return {
    ok: false,
    severity: 'warning',
    message: `${show.id} is status=open but tags still include 'upcoming' — run: node scripts/fix-stale-upcoming-tags.js --show=${show.id} --apply`,
    details: { showId: show.id, tags: show.tags },
  };
}

module.exports = { name, description, run };
