/**
 * Which Buffer channel sets a score post goes to (BRO-6378). Pure functions, unit-tested
 * in social-autopost.test.mjs.
 *
 * A show's home set follows its market: Broadway and Off-Broadway -> 'broadway',
 * West End and Off-West End -> 'west-end'. A high-profile show is also posted to the
 * other market's accounts (isHighProfile, rule in config.js HIGH_PROFILE). The video
 * lane (BRO-6250) must call the same isHighProfile / targetSets.
 */

const C = require('./config');

/** The set a show belongs to, or null for a category the system does not post. */
function homeSet(show) {
  return C.MARKET_CHANNEL_SET[show.category] || null;
}

/** True when the show has a transfer link to a show in the other channel set. */
function hasCrossMarketTransfer(show, shows) {
  const home = homeSet(show);
  if (!Array.isArray(shows)) return false;
  // Links count from either end: the London show may not name its Broadway transfer, nor the reverse.
  const linked = shows.filter(o => o.id !== show.id && ([show.transferOf, show.transferredTo].flat().includes(o.id)
    || [o.transferOf, o.transferredTo].flat().includes(show.id)));
  return linked.some(o => homeSet(o) && homeSet(o) !== home);
}

/**
 * High profile: a transfer to or from the other market, or HIGH_PROFILE.t1Reviews
 * tier-1 reviews. gate is the evaluateScoreConfidence result ({counts: {t1}}).
 */
function isHighProfile(show, gate, shows, rule = C.HIGH_PROFILE) {
  if (rule.transfer && hasCrossMarketTransfer(show, shows)) return true;
  return !!(gate && gate.counts && gate.counts.t1 >= rule.t1Reviews);
}

/**
 * Channel sets this show posts to: [home] or [home, other] when high profile.
 * sets: config CHANNEL_SETS. A set with no channel ids is not configured yet; a show
 * whose home set is unconfigured keeps posting to 'broadway' (the behavior before
 * per-market accounts existed), and cross-posting to an unconfigured set is skipped.
 * A set counts as configured only when it has every network the Broadway set has, so
 * adding the accounts one at a time never moves shows onto fewer networks.
 */
function targetSets(show, gate, sets = C.CHANNEL_SETS, shows = null) {
  const home = homeSet(show);
  if (!home) return [];
  const configured = name => Object.keys(sets.broadway || {}).every(svc => (sets[name] || {})[svc]);
  if (!configured(home)) return ['broadway'];
  const other = home === 'broadway' ? 'west-end' : 'broadway';
  return configured(other) && isHighProfile(show, gate, shows) ? [home, other] : [home];
}

/** Ledger/log key for a channel: the bare service for the Broadway set (history stays valid), service@set otherwise. */
function channelKey(set, service) {
  return set === 'broadway' ? service : `${service}@${set}`;
}

/** Buffer channels annotated with {set, key} when their id is in one of the sets (set null otherwise). */
function tagChannels(channels, sets = C.CHANNEL_SETS) {
  const seen = new Map();
  for (const [set, ids] of Object.entries(sets)) {
    for (const id of Object.values(ids)) {
      if (seen.has(id)) throw new Error(`Buffer channel ${id} is listed in both '${seen.get(id)}' and '${set}' channel sets (config.js CHANNEL_SETS)`);
      seen.set(id, set);
    }
  }
  return channels.map(ch => {
    for (const [set, ids] of Object.entries(sets)) {
      if (Object.values(ids).includes(ch.id)) return { ...ch, set, key: channelKey(set, ch.service) };
    }
    return { ...ch, set: null, key: null };
  });
}

module.exports = { homeSet, isHighProfile, targetSets, channelKey, tagChannels, hasCrossMarketTransfer };
