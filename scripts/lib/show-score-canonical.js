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
 * Does a stored audience rating match what this page shows? Used to prove a stored rating CAME
 * FROM a UK page rather than merely sitting next to one. The page moves between the scrape and the
 * archive, so counts may differ by a few ratings; the score may then move too, but only as far as
 * those few ratings (each 0-100) can push it. BRO-7434: the-other-place-2013 stored 71%/14 from the
 * London page, which one later rating moved to 68%/15; a flat "scores within 1" test missed it.
 * Same counts: scores must be within 1 (both are rounded percentages).
 */
function storedRatingMatchesPage(stored, page) {
  if (!stored || !page) return false;
  const rc = Number.isFinite(stored.reviewCount) && stored.reviewCount > 0 ? stored.reviewCount : 0;
  const d = page.count - rc;
  if (Math.abs(d) > Math.max(3, Math.round(page.count * 0.02))) return false;
  // Ship-check (BRO-7434): the wide window is only trustworthy with a real count to anchor it. A missing
  // or tiny stored count (under 10) keeps the strict "scores within 1" rule, or any score would match.
  if (rc < 10) return Math.abs(page.score - stored.score) <= 1;
  // Sum of the ratings added (d > 0) or removed (d < 0), given both percentages are rounded (+-0.5).
  const lo = (page.score - 0.5) * page.count - (stored.score + 0.5) * rc;
  const hi = (page.score + 0.5) * page.count - (stored.score - 0.5) * rc;
  const reachLo = Math.min(0, 100 * d);
  const reachHi = Math.max(0, 100 * d);
  return hi >= reachLo && lo <= reachHi;
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
