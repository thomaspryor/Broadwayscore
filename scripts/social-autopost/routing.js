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
const { foldDiacritics } = require('../lib/title-match');

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

/** Lower-case title without punctuation or a leading "The", to match one production across markets. */
const titleKey = t => foldDiacritics(String(t || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const MAIN_STAGE = new Set(['broadway', 'west-end']);

/** Names of a show's stage directors (creativeTeam roles like "Director", "Director & Choreographer"; not music or movement direction). */
const directorsOf = show => new Set((show.creativeTeam || [])
  .filter(c => /(^|[\s,&])(co-)?director\b/i.test(c.role || '') && !/music|movement|associate|assistant/i.test(c.role || ''))
  .map(c => foldDiacritics(String(c.name || '')).toLowerCase().trim()).filter(Boolean));

/**
 * True when a same-titled main-stage production in the other set opened within
 * `years`. When both list directors and none is shared, they are rival productions
 * of the same play (two Othellos), not one show crossing the Atlantic.
 */
function hasCrossMarketTwin(show, shows, years) {
  if (!MAIN_STAGE.has(show.category) || !show.openingDate || !Array.isArray(shows)) return false;
  const at = Date.parse(show.openingDate);
  const key = titleKey(show.title);
  const mine = directorsOf(show);
  return shows.some(o => {
    if (o.id === show.id || !MAIN_STAGE.has(o.category) || homeSet(o) === homeSet(show) || !o.openingDate) return false;
    if (titleKey(o.title) !== key || !(Math.abs(Date.parse(o.openingDate) - at) <= years * 365.25 * 864e5)) return false;
    const theirs = directorsOf(o);
    return !mine.size || !theirs.size || [...mine].some(n => theirs.has(n));
  });
}

/**
 * High profile in the other market (rule in config.js HIGH_PROFILE): reviewed by one
 * of that market's critics, a same-titled production there, or a transfer link.
 * showReviews: this show's reviews.json rows ({outletId}).
 */
function isHighProfile(show, showReviews, shows, rule = C.HIGH_PROFILE) {
  const other = homeSet(show) === 'broadway' ? 'west-end' : 'broadway';
  const press = new Set((rule.otherMarketPress || {})[other] || []);
  if ((showReviews || []).some(r => press.has(r.outletId))) return true;
  if (rule.sameTitleYears && hasCrossMarketTwin(show, shows, rule.sameTitleYears)) return true;
  return !!(rule.transfer && hasCrossMarketTransfer(show, shows));
}

/**
 * Channel sets this show posts to: [home] or [home, other] when high profile.
 * sets: config CHANNEL_SETS. A set with no channel ids is not configured yet; a show
 * whose home set is unconfigured keeps posting to 'broadway' (the behavior before
 * per-market accounts existed), and cross-posting to an unconfigured set is skipped.
 * A set counts as configured only when it has every network the Broadway set has, so
 * adding the accounts one at a time never moves shows onto fewer networks.
 */
function targetSets(show, showReviews, sets = C.CHANNEL_SETS, shows = null) {
  const home = homeSet(show);
  if (!home) return [];
  const configured = name => Object.keys(sets.broadway || {}).every(svc => (sets[name] || {})[svc]);
  if (!configured(home)) return ['broadway'];
  const other = home === 'broadway' ? 'west-end' : 'broadway';
  return configured(other) && isHighProfile(show, showReviews, shows) ? [home, other] : [home];
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

module.exports = { homeSet, isHighProfile, targetSets, channelKey, tagChannels, hasCrossMarketTransfer, hasCrossMarketTwin, titleKey };
