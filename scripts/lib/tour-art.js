'use strict';

/**
 * Tour key art (BRO-4726): where a national tour's own poster and thumbnail
 * come from, and when they replace what it inherited from Broadway.
 *
 * Tours inherit their Broadway parent's art only when the parent is plausibly
 * the same production (tour-family.js sameProductionLikely), so a tour of an
 * old title (Mark Twain Tonight!, Richard Thomas touring in 2027 against Hal
 * Holbrook's 2005 Broadway run) had none. Every candidate here is tied to one
 * of the tour's own engagements, which is what makes it the touring
 * production's art and not a title search:
 *   1. a TodayTix listing matched to a stop of the tour (venue, metro and
 *      opening day, todaytix-tour-tickets.js matchTourTickets);
 *   2. the presenter's event page for a stop, from the Tickets link on that
 *      stop's row of the tour's Tours To You schedule.
 * fetch-tour-images.js downloads them, has Gemini confirm each shows this
 * title and is real key art, and archives the winner.
 *
 * Pure: no I/O.
 */

const { matchTourTickets } = require('./todaytix-tour-tickets');
const { parseDateRange } = require('./tour-schedule');

// TodayTix fills a listing it has no art for with a "Coming soon" card. All
// three file names below are that card (checked 2026-10-05: NORAM_480x720.jpg
// and Poster_480x720.jpg render as "Coming soon"); archive-show-images.js
// already treats NORAM_ the same way.
const PLACEHOLDER_URL = /coming.?soon|NORAM[_\s]|\/Poster_480x720\.|square_photo\.png/i;

function isPlaceholderUrl(url) {
  return !url || PLACEHOLDER_URL.test(String(url));
}

function absUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  return s.startsWith('//') ? `https:${s}` : s;
}

/**
 * TodayTix art per tour, from listings matched to the tour's stops.
 * @returns {{[tourId]: Array<{source, ref, poster, thumbnail, start}>}} upcoming stops first
 */
function todaytixArt(listings, tours, schedules, now = new Date()) {
  const byId = new Map((listings || []).map(l => [l.id, l]));
  const matched = matchTourTickets(listings || [], tours, schedules || {});
  const today = now.toISOString().slice(0, 10);
  const out = {};
  for (const [tourId, links] of Object.entries(matched)) {
    const cands = [];
    const seen = new Set();
    for (const link of links) {
      const l = byId.get(link.todaytixId);
      if (!l) continue;
      const poster = absUrl(l.posterImageUrl);
      const thumbnail = absUrl(l.posterImageSquareUrl);
      const c = {
        source: 'todaytix',
        ref: `todaytix:${l.id} (${link.city} ${link.start})`,
        poster: isPlaceholderUrl(poster) ? null : poster,
        thumbnail: isPlaceholderUrl(thumbnail) ? null : thumbnail,
        start: link.start,
      };
      const key = `${c.poster}|${c.thumbnail}`;
      if ((!c.poster && !c.thumbnail) || seen.has(key)) continue;
      seen.add(key);
      cands.push(c);
    }
    // Stops still to come first: a presenter's newest upload is the current art.
    cands.sort((a, b) => (a.start < today) - (b.start < today) || a.start.localeCompare(b.start));
    if (cands.length) out[tourId] = cands;
  }
  return out;
}

const decode = s => String(s || '').replace(/&#0?38;|&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const dayOf = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

// Links that are not a presenter's event page: ticket resellers and
// affiliate redirects, which show a generic page or a login wall.
const NOT_EVENT_PAGE = /evyy\.net|awin1\.com|ticketmaster\.|livenation\.|tourstoyou\.org|ovationtix\.com|etix\.com\/ticket\/v\/|stubhub|seatgeek|vividseats/i;

/**
 * Presenter event pages for the tour's stops: the Tickets link on each Tours
 * To You schedule row whose city, venue and opening day match a stop.
 * @param {string} html the tour's Tours To You page
 * @param {Array<{city, venue, start}>} stops data/tour-schedules.json stops
 * @returns {Array<{url, city, start}>} upcoming stops first, one per URL
 */
function stopEventPages(html, stops, now = new Date()) {
  const want = new Map((stops || []).map(s => [`${s.city}|${dayOf(s.start)}`, s]));
  const today = now.toISOString().slice(0, 10);
  const out = [];
  const seen = new Set();
  for (const tr of String(html || '').match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []);
    if (cells.length < 3) continue;
    const city = decode(cells[0]).replace(/\s*[§†‡❖◆✦*¤]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const range = parseDateRange(cells[2].replace(/^<td[^>]*>|<\/td>$/g, ''));
    if (!range) continue;
    const stop = want.get(`${city}|${dayOf(range.start)}`);
    if (!stop) continue;
    for (const m of tr.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const url = decode(m[1]);
      if (NOT_EVENT_PAGE.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, city, start: stop.start });
    }
  }
  out.sort((a, b) => (a.start < today) - (b.start < today) || a.start.localeCompare(b.start));
  return out;
}

/**
 * Image URLs an event page declares for itself: og:image, twitter:image and
 * JSON-LD Event images, in that order. Body <img> tags are left out: they are
 * the venue's other shows, sponsors and headshots.
 */
function pageImageUrls(html, pageUrl) {
  const s = String(html || '');
  const urls = [];
  const add = (u) => {
    if (!u) return;
    try {
      const abs = new URL(decode(u), pageUrl).toString();
      if (/^https?:/.test(abs) && !urls.includes(abs)) urls.push(abs);
    } catch { /* not a URL */ }
  };
  const meta = (name) => {
    for (const tag of s.match(/<meta\b[^>]*>/gi) || []) {
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (key && key.toLowerCase() === name) add((tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1]);
    }
  };
  meta('og:image');
  meta('og:image:secure_url');
  meta('twitter:image');
  for (const block of s.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    let data;
    try { data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, '')); } catch { continue; }
    const nodes = [].concat(data['@graph'] || data);
    for (const n of nodes) {
      if (!n || !/Event|TheaterEvent/i.test([].concat(n['@type'] || '').join(' '))) continue;
      for (const img of [].concat(n.image || [])) add(typeof img === 'string' ? img : img && img.url);
    }
  }
  return urls;
}

// Within scripts/check-image-aspect.js's gate (the canonical copy, which a
// staged image must pass), with a stricter poster floor: the show page frames
// the poster 2:3 with object-cover (ShowHeroRedesign.tsx), so a square
// "poster" loses its sides ("Mrs. Doubtfire" read "s. Doubtf", 2026-10-05).
// Square art still makes the thumbnail.
const ASPECT = {
  poster: { min: 1.4, max: Infinity },
  thumbnail: { min: 0.85, max: 1.7 },
};
const MIN_SIDE = 300;

/** Which roles an image of this size can fill: [] when too small or landscape. */
function rolesForSize(width, height) {
  if (!width || !height || Math.min(width, height) < MIN_SIDE) return [];
  const r = height / width;
  return Object.entries(ASPECT).filter(([, t]) => r >= t.min && r <= t.max).map(([k]) => k);
}

/** A banner wide enough that its centre square is a thumbnail-sized crop. */
function landscapeCroppable(width, height) {
  return Boolean(width && height) && height >= MIN_SIDE && height / width < ASPECT.thumbnail.min && width / height <= 2.5;
}

const titleWords = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter(w => w && !['the', 'a', 'an', 'of', 'and', 'musical', 'tour', 'in'].includes(w));

/**
 * Gemini's description names the show: every distinctive title word appears.
 * A centre crop is accepted only on this, since a crop can cut the title off
 * and still look like the show's art.
 */
function descriptionNamesTitle(description, title) {
  const want = titleWords(title);
  if (!want.length) return false;
  const have = new Set(titleWords(description));
  return want.every(w => have.has(w));
}

/**
 * A centre crop may only fill an empty thumbnail. It often clips the title
 * (checked 2026-10-05: Beetlejuice, The Notebook, Hadestown), so it never
 * replaces art the tour already shows, inherited or not.
 */
function cropAllowed(tour) {
  return !(tour.images || {}).thumbnail;
}

const RETRY_DAYS = 7;

/** A tour whose last search found nothing is searched again after RETRY_DAYS. */
function retryDue(attempt, now = new Date()) {
  if (!attempt || !attempt.triedAt) return true;
  const t = Date.parse(attempt.triedAt);
  return Number.isNaN(t) || now.getTime() - t >= RETRY_DAYS * 86400000;
}

/**
 * What a finished search does to a tour's backoff record: 'clear' when every
 * needed role was written, 'keep' (try again next run) when nothing was really
 * searched or Gemini errored, else 'backoff' for RETRY_DAYS. Partial, refused
 * and placeholder-only outcomes back off too: each search is ~30 Gemini calls.
 */
function attemptAction({ need, written = [], searched, transient }) {
  if (need.length && need.every(r => written.includes(r))) return 'clear';
  if (transient || !searched) return 'keep';
  return 'backoff';
}

const ownPath = (tour, v) => typeof v === 'string' && v.startsWith(`/images/shows/${tour.id}/`);

/**
 * Roles the tour still needs its own art for. A role already holding the
 * tour's own archived file is done; one holding inherited Broadway art or
 * nothing is open. Own verified art replaces inherited art: a stop-matched
 * source is the touring production's by construction (BRO-4726).
 * @param {(p: string) => boolean} [fileExists] for an archived path
 */
function rolesNeeded(tour, fileExists = () => true) {
  const imgs = tour.images || {};
  return ['poster', 'thumbnail'].filter(k => !(ownPath(tour, imgs[k]) && fileExists(imgs[k])));
}

/**
 * Open roles whose own archived file is already on disk: a run archived it
 * after Gemini passed it but its shows.json write was lost (BRO-4726: the
 * write-guard dropped all but the first tour's save). Those tours sit in
 * backoff, so without this they keep Broadway art for a week.
 * Only a role with a source in data/image-sources.json counts: that record is
 * written for verified art alone, so a stray file is never adopted.
 * @param {(p: string) => boolean} fileExists for an archived path
 * @param {object} [sourceEntry] data/image-sources.json entry for the tour
 */
function archivedUnreferenced(tour, fileExists, sourceEntry) {
  const src = sourceEntry || {};
  return rolesNeeded(tour, fileExists)
    .filter(r => src[r] || src[`${r}CroppedFrom`])
    .filter(r => fileExists(`/images/shows/${tour.id}/${r}.webp`));
}

module.exports = {
  archivedUnreferenced,
  isPlaceholderUrl,
  todaytixArt,
  stopEventPages,
  pageImageUrls,
  rolesForSize,
  rolesNeeded,
  attemptAction,
  retryDue,
  RETRY_DAYS,
  landscapeCroppable,
  cropAllowed,
  descriptionNamesTitle,
  ASPECT,
  MIN_SIDE,
};
