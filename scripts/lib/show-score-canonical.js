'use strict';
/**
 * show-score-canonical — which market's page did Show Score actually serve?
 *
 * Why (BRO-5499): https://www.show-score.com/off-broadway-shows/midnight serves
 * the LONDON "Midnight" page (canonical /uk/london/off-west-end-shows/midnight,
 * 351 London ratings) until Show Score has a NYC page for the transfer. The
 * audience scraper's validator only rejected `/london-shows/` and
 * `/west-end-shows/` (with a leading slash), so `off-west-end-shows` slipped
 * through and the NYC show shipped a 92% audience score ("Loving") built from
 * London ratings.
 *
 * Pure: no I/O (CLAUDE.md §15). Tests: show-score-canonical.test.mjs.
 */

const UK_PATH_RE = /\/uk\/|\/london\/|\/london-shows\/|(?:^|[/-])west-end-shows\//i;

/** Canonical / og:url / JSON-LD url values found in a Show Score page. */
function canonicalUrlsOf(html) {
  const out = [];
  const s = String(html || '');
  for (const re of [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
  ]) {
    const m = s.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * True when the page is a UK (London / West End / Off-West End) page but the
 * show is not a UK show. `/open-graph/show/<id>` og:urls carry no market, so
 * only paths that name the market count.
 */
function servesUkPageForUsShow(html, url, { allowWestEnd = false } = {}) {
  if (allowWestEnd) return false;
  return [url, ...canonicalUrlsOf(html)].some((u) => UK_PATH_RE.test(String(u || '')));
}

/** "92% (351 Ratings)" off a Show Score page -> {score, count}, or null. */
function pageRatingOf(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/(\d{1,3})% \(?([\d,]+) Ratings?\)?/i);
  return m ? { score: Number(m[1]), count: Number(m[2].replace(/,/g, '')) } : null;
}

/**
 * Does a stored audience rating match what this page shows? (Scores equal, counts within
 * a few ratings: the page moves between the scrape and the archive.) Used to prove a stored
 * rating CAME FROM a UK page rather than merely sitting next to one.
 */
function storedRatingMatchesPage(stored, page) {
  if (!stored || !page) return false;
  return Math.abs(stored.score - page.score) <= 1
    && Math.abs((stored.reviewCount || 0) - page.count) <= Math.max(3, Math.round(page.count * 0.02));
}

/**
 * May this show's Show Score page legitimately be a UK page? London / Off-West-End yes; a regional
 * show only when its venue is outside the US (RSC, Chichester): a US regional venue carries a state
 * suffix ("Emerson Colonial Theatre, Boston, MA"), a UK one does not.
 */
function allowsUkShowScorePage(show) {
  const cat = show && (show.category || show.market);
  if (cat === 'west-end' || cat === 'off-west-end' || (show && show.market === 'west-end')) return true;
  if (cat === 'regional') return !/,\s*[A-Z]{2}\b/.test(String(show.venue || ''));
  return false;
}

/**
 * Single gate for "may this show's fetched Show Score page be a UK page?" used by every path that
 * turns a Show Score page into data (URL discovery, the cached-URL scrape, both show-score.json
 * extractors). BRO-5499 guarded only discovery, so Midnight's already-cached URL kept re-attaching
 * London's 92%/353 ratings on every scheduled scrape.
 */
function isUkPageForShow(show, html, url) {
  const { isLondonMarket } = require('./venue-classification');
  const allowWestEnd = isLondonMarket(show && show.category) || allowsUkShowScorePage(show);
  return servesUkPageForUsShow(html, url, { allowWestEnd });
}

module.exports = { isUkPageForShow, servesUkPageForUsShow, allowsUkShowScorePage, canonicalUrlsOf, pageRatingOf, storedRatingMatchesPage, UK_PATH_RE };
