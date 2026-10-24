/**
 * Match an LBO roundup URL to a tracked West End show (BRO-6101).
 *
 * The scraper stripped a hardcoded list of theatre names from the URL slug and
 * title-matched what was left. Any venue not on that list ("tom-stoppard-theatre",
 * "regents-park-open-air-theatre") stayed in the title, dropped the match to
 * medium confidence and the roundup was skipped: Rent, Cats and One Flew Over
 * the Cuckoo's Nest were lost this way while their roundups sat in the sitemap.
 *
 * Fallback used only when the title match is not high confidence. The slug is
 * "<title>-<venue>", so a show matches when its title opens the slug and the
 * words after it name its venue. That also separates two same-title productions
 * (Jesus Christ Superstar at the Palladium vs at Drury Lane). A theatre renamed
 * since shows.json recorded it (Duke of York's -> Tom Stoppard Theatre) has no
 * venue overlap; then a single production opening within a year of the roundup
 * is accepted. The fetched page's own title is still checked afterwards.
 */
const { matchTitleToShow } = require('./show-matching');

const VENUE_GENERIC = new Set(['the', 'theatre', 'theater', 'centre', 'center', 'royal', 'of', 'at', 'and', 'london', 'hall', 'house', 'open', 'air']);

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[‘’‚′`]/g, "'").replace(/'/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    // slugs split contractions ("i-m-sorry", "york-s"); titles drop the apostrophe
    .replace(/\b([a-z]+) (s|m|t|d|re|ve|ll)\b/g, '$1$2')
    .trim();
}

function postSlugOf(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/news\/post\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}

function venueTokens(venue) {
  return norm(venue).split(' ').filter(w => w && !VENUE_GENERIC.has(w));
}

function matchBySlug(url, shows, year) {
  // "review-roundup-<title>-<venue>" or "<title>-<venue>-review-round-up"
  const slugNorm = norm(postSlugOf(url)).replace(/\breview round ?up\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!slugNorm) return null;
  const hits = [];
  for (const s of shows) {
    const full = norm(s.title);
    // LBO drops a trailing "the musical" ("Kinky Boots the Musical" -> kinky-boots-...)
    const t = [full, full.replace(/ the musical$/, '')].find(c => c && (slugNorm === c || slugNorm.startsWith(c + ' ')));
    if (!t) continue;
    const tail = slugNorm.slice(t.length).trim().split(' ').filter(Boolean);
    const vt = venueTokens(s.venue);
    const venueHit = tail.length > 0 && vt.length > 0 && vt.some(w => tail.includes(w));
    hits.push({ show: s, tail, venueHit });
  }
  if (!hits.length) return null;
  const withVenue = hits.filter(h => h.venueHit);
  if (withVenue.length === 1) return withVenue[0].show;
  if (withVenue.length > 1) {
    const near = withVenue.filter(h => year && h.show.openingDate && Math.abs(Number(h.show.openingDate.slice(0, 4)) - year) <= 1);
    return near.length === 1 ? near[0].show : null;
  }
  // No venue overlap: renamed theatre. Accept one production opening in the roundup's year window.
  if (!year) return null;
  const near = hits.filter(h => h.tail.length > 0 && h.show.openingDate
    && Number(h.show.openingDate.slice(0, 4)) >= year - 1 && Number(h.show.openingDate.slice(0, 4)) <= year);
  return near.length === 1 ? near[0].show : null;
}

/**
 * @param {string} url roundup URL
 * @param {string|null} extractedTitle title parsed from the URL (theatre suffix stripped), if any
 * @param {object[]} shows London-market shows
 * @param {{year?:number}} [opts] article year from the sitemap <lastmod>
 * @returns {{show:object, via:'title'|'slug-venue'}|null}
 */
function matchLboRoundup(url, extractedTitle, shows, opts = {}) {
  if (extractedTitle) {
    const t = matchTitleToShow(extractedTitle, shows, { market: 'west-end' });
    if (t && t.show && t.confidence === 'high') return { show: t.show, via: 'title' };
  }
  const s = matchBySlug(url, shows, opts.year);
  return s ? { show: s, via: 'slug-venue' } : null;
}

module.exports = { matchLboRoundup, matchBySlug, postSlugOf, norm };
