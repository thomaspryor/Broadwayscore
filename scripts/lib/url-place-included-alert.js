'use strict';
/**
 * BRO-8449: worker-card decisions for scripts/audit-url-place-included.js --alert. Pure.
 *   url-place-included:unjudged      included reviews whose url names another place and that no
 *                                    fresh content verdict has judged (queue: reverify --url-place)
 *   url-place-included:contradicted  a fresh verdict says "right production" but the url names
 *                                    another place; read the review, then fix or ack it
 * Rows are file paths, outlet ids and place names only, never review text.
 */
const { buildAuditAlert } = require('./audit-alert');

const UNJUDGED_KEY = 'url-place-included:unjudged';
const CONTRADICTED_KEY = 'url-place-included:contradicted';
const DONE = 'Done when node scripts/audit-url-place-included.js --strict exits 0.';

const row = (h) => `${h.showId}/${h.file}: url names ${h.place.replace(/-/g, ' ')}`;

/** @param {{unjudged:object[], contradicted:object[]}} out */
function decideUrlPlaceAlerts(out) {
  return [
    buildAuditAlert({
      conditionKey: UNJUDGED_KEY,
      rows: (out.unjudged || []).map(row),
      title: (n) => `${n} included review${n === 1 ? '' : 's'} whose url names another place have no fresh content verdict`,
      intro: 'These included reviews have a url path that stages the show outside its home market (a tour or regional house), and the content verifier has not judged the stored text (no verdict, or one on an older copy).',
      hint: `Run node scripts/reverify-stale-cv-promoted.js --url-place (the weekly workflow does this); a tour or regional verdict then excludes the review at the next rebuild. ${DONE}`,
      resolveReason: 'every url-place hit has a fresh verdict',
    }),
    buildAuditAlert({
      conditionKey: CONTRADICTED_KEY,
      rows: (out.contradicted || []).map(row),
      title: (n) => `${n} included review${n === 1 ? '' : 's'} judged "right production" while the url names another place`,
      intro: 'The content verifier called these the right production, but the url path stages the show somewhere else. Many are transfers or roundups; some are tour reviews the verifier missed.',
      hint: `Read each whole article. Another production: set wrongProduction via a pending-fix plan (node scripts/new-fix-plan.js --review-edit=...). Same production: add "<show>/<file>": "<why>" to data/audit/url-place-judged.json. ${DONE}`,
      resolveReason: 'no included url-place review contradicts its verdict',
    }),
  ];
}

module.exports = { decideUrlPlaceAlerts, UNJUDGED_KEY, CONTRADICTED_KEY };
