'use strict';
/**
 * BRO-7791: admit a review headline that names a subtitled show by its one-word lead ("Review: Dollygram Glitters on
 * Broadway" for "Dollygram: An Original Musical") only when everything around it says it is tonight's review.
 *
 * The strict matcher (rss-discovery titleMatchesShow / urlSlugMatchesShow) refuses a one-word lead on purpose: "Dolly"
 * is also Hello, Dolly!, "Diana" is also Diana, The Musical, "Othello" is every Othello. In the BRO-7781 simulated night
 * that left TheaterMania's index review of Dollygram as a near-miss alert, live 70 minutes later through the BWW roundup.
 *
 * All of these must hold, or the link stays a near-miss (reported, never admitted):
 *   1. tonight is the show's opening night (show.openingDate is the lane's night);
 *   2. the link comes from a direct outlet source on the show's own market: the outlet's feed or section index, on the
 *      outlet's own host (the caller says so with ctx.direct / ctx.outletId);
 *   3. a review cue (ctx.reviewCue, discovery.js hasReviewSignal) and a market or venue cue of THIS show's market, and
 *      no cue of another market ("West End" for a Broadway show, bare "Broadway" for an Off-Broadway one);
 *   4. the lead word is distinctive: no other active show in shows.json holds it, no closed show is named by it alone,
 *      at most one other closed show holds it, it is not a month, and the headline names no other show;
 *   5. the word is used as a title: first after a "Review:"-style prefix, quoted, or followed by "review", in the
 *      headline or the URL slug;
 *   6. nothing says another staging or a non-review: a tryout or tour cue, another named venue, another production's
 *      cue (show-names otherProductionCue), a casting / tickets / photos article, or a film.
 * Pure (CLAUDE.md rule 15): the show list comes from show-names' registry (data/shows.json, or setPressNameShows in tests).
 */
const { foldDiacritics } = require('../title-match');
const { registryShows, otherProductionCue, sigWords } = require('../show-names');
const { leadWord } = require('./near-miss');
const { laneMarket, outletInMarket } = require('./lane-sources');

const MONTHS = new Set(['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
// Tokens a headline may put before the title ("Review:", "Broadway Review -", "Critic's Pick: ", "4 stars: ").
const PREFIX = new Set(['review', 'reviews', 'reviewed', 'broadway', 'off', 'west', 'end', 'london', 'nyc', 'theater', 'theatre', 'critic', 'critics',
  's', 'pick', 'star', 'stars', 'one', 'two', 'three', 'four', 'five', 'first', 'night', 'opening', 'stage']);
const NON_REVIEW_RE = /\b(cast(?:ing)?|casts|announce[sd]?|announcement|tickets?|lottery|rush|first look|photos?|gallery|video|trailer|interview|rehearsals?|sneak peek|extends?|extension|closing|cast album|recording|sets? (?:dates?|opening)|will open|to open)\b/;
const OTHER_STAGING_RE = /\b(tryout|pre broadway|before broadway|broadway bound|bound for broadway|on tour|touring|national tour|uk tour|regional|out of town|concert version|in concert|staged reading|reading of|workshop|summer stock|high school|community theat(?:re|er)|film|movie|netflix)\b/;
const VENUE_WORD_RE = /\b(?:at|At|AT)\s+(?:(?:the|The|THE)\s+)?([A-Z][A-Za-z0-9'.&]*(?:\s+[A-Z][A-Za-z0-9'.&]*){0,4}\s+(?:Theatre|Theater|Playhouse|Rep|Repertory|Center|Centre|Stage|Hall|Opera House|Arts))\b/g;

let outletsCache;
function knownOutlet(id) {
  if (outletsCache === undefined) {
    try { outletsCache = require('../../../data/outlet-registry.json').outlets || {}; } catch { outletsCache = {}; }
  }
  return Object.prototype.hasOwnProperty.call(outletsCache, id);
}

function fold(t) {
  return ' ' + foldDiacritics(String(t || '')).toLowerCase()
    .replace(/[‘’ʼ`']/g, '').replace(/&amp;|&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
const tokens = (t) => fold(t).trim().split(' ').filter(Boolean);
function slugOf(url) {
  try {
    const segs = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
    return (segs[segs.length - 1] || '').replace(/\.[a-z]{2,5}$/i, '').replace(/[-_.]+/g, ' ').replace(/\b\d{3,}\b/g, ' ');
  } catch { return ''; }
}
const hasPhrase = (hay, phrase) => { const p = fold(phrase).trim(); return !!p && hay.includes(` ${p} `); };

/** The word is used as a title in this text: first after a cue prefix, or directly followed by "review". */
function titlePosition(text, word) {
  const t = tokens(text);
  const i = t.findIndex((w) => w === word || w === `${word}s`);
  if (i < 0) return false;
  if (t.slice(0, i).every((w) => PREFIX.has(w) || /^\d+$/.test(w))) return true;
  return /^reviews?$|^reviewed$/.test(t[i + 1] || '');
}
function quoted(raw, word) {
  const r = foldDiacritics(String(raw || '')).toLowerCase();
  return new RegExp(`[“"‘']\\s*${word}(?![a-z0-9])`).test(r);
}

/** This show's market cue, and whether the text carries a cue of another market. */
function marketCues(hay, show) {
  const cat = String((show && show.category) || '').toLowerCase();
  const offBway = / off broadway /.test(hay);
  const bway = / broadway /.test(hay.replace(/ off broadway /g, ' '));
  const offWe = / off west end /.test(hay);
  const we = / west end /.test(hay.replace(/ off west end /g, ' '));
  let own; let other;
  if (laneMarket(show) === 'west-end') {
    own = cat.startsWith('off') ? (offWe || we) : we;
    other = bway || offBway;
  } else if (cat === 'off-broadway' || cat === 'off-off-broadway') {
    own = offBway; other = bway || we || offWe;
  } else {
    own = bway; other = offBway || we || offWe;
  }
  return { own, other };
}

function venueCue(hay, show) {
  const venue = String((show && show.venue) || '').replace(/\b(theatre|theater)\b/gi, '').trim();
  return sigWords(venue).length >= 1 && venue.length >= 5 && hasPhrase(hay, venue);
}

/** Another named venue in the headline ("at the Paper Mill Playhouse") that is not the show's own. */
function otherVenueNamed(raw, show) {
  const own = fold(String((show && show.venue) || '').replace(/\b(theatre|theater)\b/gi, '')).trim();
  for (const m of String(raw || '').matchAll(VENUE_WORD_RE)) {
    const v = fold(m[1].replace(/\b(theatre|theater)\b/gi, '')).trim();
    if (!v) continue;
    if (own && (` ${v} `.includes(` ${own} `) || ` ${own} `.includes(` ${v} `))) continue;
    return m[1].trim();
  }
  return null;
}

/** Why the lead word is not distinctive among loaded shows, or null. */
function sharedLeadWord(word, show) {
  let closed = 0;
  const ownTitle = fold(show.title);
  for (const s of registryShows()) {
    if (!s || !s.title) continue;
    if ((show.id && s.id === show.id) || (!show.id && fold(s.title) === ownTitle && !s.id)) continue;
    const t = new Set(tokens(s.title));
    if (!t.has(word) && !t.has(`${word}s`)) continue;
    if (s.status !== 'closed') return `shared-with-active:${s.id || s.title}`;
    // A closed namesake ("Degenerates" for "Degenerates: Dec & Jan", backtest 2026-11-18) is the same name, not a shared word.
    const sw = sigWords(s.title);
    if ((sw.length === 1 && (sw[0] === word || sw[0] === `${word}s`)) || leadWord(s.title) === word) return `closed-namesake:${s.id || s.title}`;
    closed += 1;
    if (closed >= 2) return 'shared-with-closed-shows';
  }
  return null;
}

/** Another loaded show's full title (2+ significant words) named in the text: a roundup or another show's review. */
function otherShowNamed(hay, show) {
  const own = fold(show.title);
  for (const s of registryShows()) {
    if (!s || !s.title || s.status === 'closed' || fold(s.title) === own || (show.id && s.id === show.id)) continue;
    // 2+ significant words, or one long one ('The Outsiders', 'Hamilton'): short one-word titles are everyday words
    const w = sigWords(s.title);
    if ((w.length >= 2 || (w.length === 1 && w[0].length >= 6)) && hasPhrase(hay, s.title)) return s.id || s.title;
  }
  return null;
}

/**
 * @param {{title?: string, url: string}} item
 * @param {{id?: string, title: string, venue?: string, category?: string, market?: string, openingDate?: string}} show
 * @param {{night?: string, direct?: boolean, outletId?: string, reviewCue?: boolean}} ctx
 * @returns {{admit: boolean, reason: string, word: string|null}}
 */
function corroboratedLeadWord(item, show, ctx = {}) {
  const no = (reason, word = null) => ({ admit: false, reason, word });
  if (!item || !item.url || !show || !show.title) return no('no-input');
  const word = leadWord(show.title);
  if (!word) return no('no-one-word-lead');
  if (MONTHS.has(word)) return no('lead-word-is-a-month', word);
  // 1. tonight is the show's opening night
  if (!ctx.night || String(show.openingDate || '').slice(0, 10) !== ctx.night) return no('not-opening-tonight', word);
  // 2. a direct outlet source on the show's market
  if (ctx.direct !== true || !ctx.outletId) return no('not-a-direct-outlet-source', word);
  if (!knownOutlet(ctx.outletId)) return no('unknown-outlet', word);
  if (!outletInMarket(ctx.outletId, laneMarket(show))) return no('outlet-off-market', word);
  const raw = String(item.title || '');
  const hay = fold(`${raw} ${slugOf(item.url)}`);
  if (!new Set(hay.trim().split(' ')).has(word) && !hay.includes(` ${word}s `)) return no('lead-word-absent', word);
  // 3. review cue plus this market's cue or the venue, and no other market's cue
  if (ctx.reviewCue !== true) return no('no-review-cue', word);
  const m = marketCues(hay, show);
  if (m.other) return no('other-market-cue', word);
  if (!m.own && !venueCue(hay, show)) return no('no-market-or-venue-cue', word);
  // 4. a distinctive word, and no other show named
  const shared = sharedLeadWord(word, show);
  if (shared) return no(shared, word);
  const other = otherShowNamed(hay, show);
  if (other) return no(`other-show-named:${other}`, word);
  // 6. another staging, a non-review article, another venue, another production
  if (NON_REVIEW_RE.test(hay)) return no('non-review-article', word);
  if (OTHER_STAGING_RE.test(hay)) return no('other-staging-cue', word);
  const venue = otherVenueNamed(raw, show);
  if (venue) return no(`other-venue:${venue}`, word);
  // otherProductionCue trusts any headline naming Broadway or the venue; here those cues are what admitted the link, so
  // they are taken out first ("Review: Goodspeed's Dollygram eyes Broadway" is Goodspeed's staging).
  const core = String((show && show.venue) || '').replace(/\b(theatre|theater)\b/gi, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const venueRe = core ? new RegExp(`(?:\\bthe\\s+)?${core}(?:\\s+(?:theatre|theater))?`, 'gi') : /(?!)/g;
  const cue = otherProductionCue(raw.replace(/\b(?:off[-\s]+)?broadway\b/gi, ' ').replace(venueRe, ' '), word, show);
  if (cue) return no(`other-production:${cue}`, word);
  // BRO-7785's wrong-staging guard (show-names.js), the same check every other lane match passes.
  const sn = require('../show-names');
  if (typeof sn.billedTitleOtherProductionCue === 'function' && !(typeof sn.wrongStagingGuardOff === 'function' && sn.wrongStagingGuardOff())) {
    const staged = sn.billedTitleOtherProductionCue(raw, word, show.title, { main: true });
    if (staged) return no(`wrong-staging:${staged}`, word);
    const slug = typeof sn.slugOtherStagingCue === 'function' && sn.slugOtherStagingCue(item.url, show.title);
    if (slug) return no(`wrong-staging-slug:${slug}`, word);
  }
  // 5. the word is used as a title
  if (!titlePosition(raw, word) && !titlePosition(slugOf(item.url), word) && !quoted(raw, word)) return no('lead-word-not-in-title-position', word);
  return { admit: true, reason: 'lead-word-corroborated', word };
}

module.exports = { corroboratedLeadWord, titlePosition, marketCues, sharedLeadWord };
