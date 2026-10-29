'use strict';
/**
 * BRO-6541: match the London outlet census's regional-uk items (BRO-6488 manifests,
 * data/audit/outlet-census/london/*.manifest.json) to UK hub shows.
 *
 * The census matched each item against West End rows only, so a review of a UK hub
 * production sits in its manifest as bucket other-market-review, itemMarket regional-uk.
 * This re-runs the match against the rows that carry a UK metro `city`:
 *   1. title: the headline (a leading "review" and "the" dropped) starts with the show's
 *      title, so "Magic" never takes "The Magic Flute". British Theatre Guide slugs cut the title and the venue at
 *      15 characters ("the-woman-in-bl-the-lowry-8812"), so for that outlet the slug's
 *      first 15 characters must equal the title's and its venue part must start a venue alias;
 *   2. house: one of the show's venue aliases (data/venue-metros.json), the venue's own
 *      name, or its town appears in the same text, so "Twelfth Night" at the Crucible
 *      never takes a Glasgow Twelfth Night;
 *   3. run window: published from 45 days before opening to 60 days after closing, or
 *      150 days after opening when the row has no closing date (most hub rows are closed
 *      with only the Guardian review date).
 * Items matching two shows are reported as ambiguous and never ingested.
 */
const { norm, TABLE } = require('./venue-metro');

const DAY = 86400000;
const PRE_DAYS = 45;
const POST_CLOSE_DAYS = 60;
const NO_CLOSE_DAYS = 150;
const BTG_HOST = 'britishtheatreguide.info';
// Words that can follow a title in a review headline ("Lear with Maureen Beattie at ...").
// Not "in", "the" or "part": "Once" must not take "Once in a Lifetime", nor "Henry VI" take "Henry VI Part Two".
const TITLE_END = new Set(['review', 'at', 'with', 'by', 'musical', 'theatre', 'starring', 'directed', 'from', 'tour', 'minerva', 'swan', 'ustinov', 'studio', 'tanya', 'festival']);
const GENERIC = new Set(['the', 'theatre', 'theater', 'playhouse', 'studio', 'studios', 'festival', 'royal', 'new', 'house', 'arts', 'centre', 'center']);

function ms(d) {
  const t = Date.parse(String(d || '').slice(0, 10));
  return Number.isNaN(t) ? NaN : t;
}

function inWindow(show, publishDate) {
  const pub = ms(publishDate);
  const open = [ms(show.previewsStartDate), ms(show.openingDate)].filter((t) => !Number.isNaN(t));
  if (Number.isNaN(pub) || !open.length) return false;
  const start = Math.min(...open);
  const close = ms(show.closingDate);
  const end = Number.isNaN(close) ? Math.max(...open) + NO_CLOSE_DAYS * DAY : close + POST_CLOSE_DAYS * DAY;
  return pub >= start - PRE_DAYS * DAY && pub <= end;
}

function pathText(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

function itemText(item) {
  return ` ${norm(`${item.headline || ''} ${pathText(item.url)}`)} `;
}

function titleKey(title) {
  return norm(String(title || '').replace(/\([^)]*\)/g, ' ')).replace(/^the /, '');
}

/** Phrases that place a review at this show's house: aliases, the house name, the town. */
function housePhrases(show) {
  const v = norm(show.venue);
  const [house, town] = String(show.venue || '').split(',').map((p) => norm(p));
  const out = new Set();
  for (const e of TABLE.venues) {
    if (e.metro !== show.city) continue;
    const names = [e.venue, ...(e.aliases || [])].map(norm);
    if (!names.some((n) => n && (v.includes(n) || n.includes(house)))) continue;
    names.forEach((n) => n.length >= 4 && out.add(n));
  }
  if (house && house.split(' ').some((w) => w.length >= 4 && !GENERIC.has(w) && w !== town)) out.add(house);
  // A town alone is weak (Glasgow has three houses on the list), so it needs a house word too.
  // The town is never a house word: "Sheffield Playhouse" must not claim every Sheffield headline.
  return { phrases: [...out], town: town || null, houseWords: (house || '').split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w) && w !== town) };
}

function leadText(item) {
  return ` ${norm(item.headline).replace(/^(?:theatre )?review /, '').replace(/^the /, '')} `;
}

function titleMatches(show, item) {
  const t = titleKey(show.title);
  if (!t) return false;
  if (!String(item.url || '').includes(BTG_HOST)) {
    const lead = leadText(item);
    if (!lead.startsWith(` ${t} `)) return false;
    // The title must end where the headline's title ends: "magic flute review" is not "Magic".
    const rest = lead.slice(t.length + 2);
    const next = rest.split(' ')[0];
    if (!next || TITLE_END.has(next)) return true;
    const { phrases, town, houseWords } = housePhrases(show);
    return [...phrases, ...houseWords, town].some((p) => p && rest.startsWith(`${p} `));
  }
  // BTG: "<title cut at 15>-<venue cut at 15>-<id>".
  const slug = (/\/reviews\/([a-z0-9-]+?)-\d+\/?$/.exec(pathText(item.url)) || [])[1];
  const full = norm(show.title).replace(/ /g, '-');
  if (!slug || full.length < 4) return false;
  const head = full.slice(0, 15).replace(/-$/, '');
  return slug.startsWith(`${head}-`) && btgVenuePart(slug.slice(head.length + 1), show);
}

function btgVenuePart(rest, show) {
  if (!rest || rest.length < 4) return false;
  const { phrases } = housePhrases(show);
  const r = rest.replace(/-/g, ' ');
  // The slug's venue part is the venue cut at 15 characters, so a real alias starts with all of it.
  return phrases.some((p) => p.startsWith(r));
}

function houseMatches(show, text, item) {
  const { phrases, town, houseWords } = housePhrases(show);
  if (phrases.some((p) => text.includes(` ${p} `))) return true;
  if (String(item.url || '').includes(BTG_HOST)) return true; // its venue fragment is checked in titleMatches
  return !!town && text.includes(` ${town} `) && houseWords.some((w) => text.includes(` ${w} `));
}

/** Show ids an item reviews, from the UK hub rows. */
function matchItem(item, hubShows) {
  const text = itemText(item);
  const hits = hubShows.filter((s) => inWindow(s, item.publishDate) && titleMatches(s, item) && houseMatches(s, text, item));
  // "Henry VI" and "Henry VI Part One" at the same house: keep the longest title.
  if (hits.length > 1) {
    const longest = Math.max(...hits.map((s) => titleKey(s.title).length));
    return hits.filter((s) => titleKey(s.title).length === longest).map((s) => s.id);
  }
  return hits.map((s) => s.id);
}

/**
 * Bucket regional-uk census items against hub shows.
 * @param items     [{url, headline, publishDate, outletId}]
 * @param hubShows  show rows with a UK metro city
 * @param heldUrls  Map showId -> Set(urlKey) of reviews already held
 * @param urlKey    URL normaliser shared with the census
 * @returns {matched: [{showId, url, outletId, publishDate, headline}], held, ambiguous, unmatched}
 */
function matchCensusItems(items, hubShows, heldUrls, urlKey) {
  const out = { matched: [], held: [], ambiguous: [], unmatched: [] };
  for (const item of items) {
    const ids = matchItem(item, hubShows);
    if (ids.length === 0) { out.unmatched.push(item); continue; }
    if (ids.length > 1) { out.ambiguous.push({ ...item, showIds: ids }); continue; }
    const row = { showId: ids[0], url: item.url, outletId: item.outletId, publishDate: item.publishDate, headline: item.headline };
    const held = heldUrls.get(ids[0]);
    if (held && held.has(urlKey(item.url))) out.held.push(row);
    else out.matched.push(row);
  }
  return out;
}

module.exports = { matchItem, matchCensusItems, inWindow, housePhrases, titleKey };
