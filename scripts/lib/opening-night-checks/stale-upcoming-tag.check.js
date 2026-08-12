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

  const message = `${show.id} is status=open but tags still include 'upcoming' — run: node scripts/fix-stale-upcoming-tags.js --show=${show.id} --apply`;

  return {
    ok: false,
    severity: 'warning',
    message,
    details: {
      showId: show.id,
      tags: show.tags,
      // Self-declared remediation (task #1132, extending #389). kind:'alert', not
      // 'workflow' — fix-stale-upcoming-tags.js has no workflow_dispatch wrapper,
      // and a tag-only fix on the shows.json write-guard path doesn't warrant
      // standing up new CI just to auto-run it (owner review gate, rule 18).
      remediation: {
        kind: 'alert',
        key: `stale-upcoming-tag:${show.id}`,
        conditionKey: `opening-night-stale-upcoming-tag-${show.id}`,
        title: `Stale 'upcoming' tag on ${show.title || show.id}`,
        description: message,
        severity: 'warning',
        reason: 'status=open with tags still including upcoming',
      },
    },
  };
}

module.exports = { name, description, run };
