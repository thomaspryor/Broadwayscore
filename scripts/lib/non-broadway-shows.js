'use strict';
// BRO-8281: the one definition of "this show is not Broadway" for the deploy gate (deploy-reveal.js) and the
// time-to-publish SLA. Kept dependency-free on purpose: requiring the larger deploy-reveal.js from a workflow step
// would drag its transitive reads into that step's secret-gap audit.

const DEFAULT_REVEAL_CATEGORIES = ['broadway'];
const NON_BROADWAY_CATEGORIES = ['off-broadway', 'west-end', 'off-west-end', 'regional', 'tour'];
// Broadway ids carry no market hint; every other market's id does, as a whole `-` delimited segment.
const NON_BROADWAY_ID_RE = /(^|-)(off-broadway|west-end|off-west-end|regional|tour|london|uk-tour)(-|$)/;

/** Pure: env switch -> categories policy. GATE_REVEAL_ALL_CATEGORIES=true restores the old all-categories reveal. */
function revealCategoriesFromEnv(env = process.env) {
  return env && env.GATE_REVEAL_ALL_CATEGORIES === 'true' ? null : DEFAULT_REVEAL_CATEGORIES;
}

/** Pure: should the SLA / reporting skip this shows.json entry as non-Broadway? An entry whose own category says broadway is never skipped. */
function isNonBroadwayShowEntry(show) {
  if (!show || !NON_BROADWAY_ID_RE.test(String(show.id || ''))) return false;
  const c = show.category;
  return !(typeof c === 'string' && /^broadway$/i.test(c));
}

module.exports = { DEFAULT_REVEAL_CATEGORIES, NON_BROADWAY_CATEGORIES, NON_BROADWAY_ID_RE, revealCategoriesFromEnv, isNonBroadwayShowEntry };
