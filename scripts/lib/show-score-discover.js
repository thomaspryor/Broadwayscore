/**
 * Show Score per-show review discovery for the gap-audit reconciliation.
 *
 * Show Score lists critic reviews (with direct outlet links) on each show's page —
 * including off-Broadway, where it lands later and with fewer reviews than Playbill
 * or BroadwayWorld, but it DOES carry them (operator note, 2026-06-06). Unlike DTLI
 * (Broadway-only), Show Score covers OB. Adding it as a reconciliation source means
 * the hourly gap audit eventually catches a review that surfaced only on Show Score.
 *
 * Show Score server-renders only the first 8 critic reviews; the rest load via its
 * pagination endpoint /shows/{slug}/paginate_critic_reviews?page=N (JSON {"html":…}).
 * We must paginate or we miss reviews 9..N (e.g. The Receptionist has 13). The
 * "Read more" links on each tile are the canonical outlet review URLs and are
 * show-page-vouched, so the caller should NOT title-match them — that lets opaque
 * outlet URLs through (Lighting & Sound America uses story.asp?ID=… with no title
 * in the path, which title-matching would otherwise reject).
 */

const { foldDiacritics } = require('./title-match');

const SS_HOSTS = /(^|\.)show-score\.com$/i;

/** Show Score's ASCII-folded title slug, or '' (shared by the constructed URL
 *  and the same-title sibling checks). */
function showScoreTitleSlug(show) {
  if (!show || typeof show.title !== 'string') return '';
  return foldDiacritics(show.title)
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The CONSTRUCTED (un-curated) Show Score page URL for a show: section + slug
 * from the title, NYC categories only. null when no URL can be constructed.
 * No ownership/collision checks — see showScoreUrlForShow for those.
 */
function constructShowScoreUrl(show) {
  if (!show || !show.title) return null;
  // foldDiacritics FIRST: without it "Les Misérables" slugs to
  // "les-mis-rables" (the é is a non-[a-z0-9] char and becomes a separator),
  // which 404s. Show Score's own slugs are ASCII-folded. Task #648.
  const slug = showScoreTitleSlug(show);
  if (!slug) return null;
  const cat = String(show.category || '').toLowerCase();
  // Only NYC categories get a CONSTRUCTED url. The two NYC sections below are
  // Show Score's New York pages; London shows live under a different path
  // (/uk/london/west-end-shows/<slug> with inconsistent -london / -west-end
  // suffixes) and regional shows have no page at all. Constructing a NYC url
  // for a London/regional show fetched the same-title NYC production's page
  // and fed its critic links into the gap audit as current-run misses
  // (space-dogs-off-west-end-2026 listed MCC's 2022 Off-Broadway reviews,
  // two of which were ingested and then flagged wrongProduction). Non-NYC
  // shows get Show Score only via an explicit curated entry.
  if (cat !== 'broadway' && cat !== 'off-broadway') return null;
  const section = cat === 'off-broadway' ? 'off-broadway-shows' : 'broadway-shows';
  return `https://www.show-score.com/${section}/${slug}`;
}

/**
 * A production's recency key for same-title tie-breaking (BRO-3556):
 * openingDate, else previewsStartDate, else Jan 1 of a trailing -YYYY in the
 * id. null when none is usable.
 */
function productionRecencyMs(show) {
  for (const d of [show && show.openingDate, show && show.previewsStartDate]) {
    if (!d) continue;
    const ms = new Date(d).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const m = String((show && show.id) || '').match(/-((?:19|20)\d{2})$/);
  return m ? Date.UTC(parseInt(m[1], 10), 0, 1) : null;
}

/**
 * True only when `show` is strictly newer than every rival. Any undatable
 * production in the group (show or rival) or a tie at the top → false.
 */
function isNewestProduction(show, rivals) {
  // The winner needs a REAL date. A trailing -YYYY in the id only ranks older
  // rivals: an announced revival with no dates (dreamgirls-2026,
  // private-lives-2025) would otherwise take the page Show Score still shows
  // for the last production, and with no dates isUrlYearOutOfWindow can block
  // none of that production's links.
  if (!hasProductionDate(show)) return false;
  const mine = productionRecencyMs(show);
  if (mine === null) return false;
  for (const r of rivals) {
    const theirs = productionRecencyMs(r);
    if (theirs === null || theirs >= mine) return false;
  }
  return true;
}

function hasProductionDate(show) {
  return [show && show.openingDate, show && show.previewsStartDate]
    .some((d) => d && Number.isFinite(new Date(d).getTime()));
}

const normSsUrl = (u) => u.toLowerCase().replace(/\/+$/, '');

// allShows array -> Map(normalized constructed url -> shows). Built once per
// array (callers never mutate it after the first lookup): the per-call scan was O(N) slug builds, so a full audit pass did N²
// (7.8s on 3,730 shows).
const _constructedIndex = new WeakMap();
function constructedUrlIndex(allShows) {
  let idx = _constructedIndex.get(allShows);
  if (idx) return idx;
  idx = new Map();
  for (const other of allShows) {
    if (!other) continue;
    const u = constructShowScoreUrl(other);
    if (!u) continue;
    const k = normSsUrl(u);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(other);
  }
  _constructedIndex.set(allShows, idx);
  return idx;
}

/**
 * True when a same-title production in the same Show Score section is definitively newer than `show` (BRO-3556). Show Score keeps one
 * page per title showing the newest production, so slug-guessing a page for
 * the older one lands on the newer one's critic links, which pass a
 * year-before-window gate. Applies to closed productions only. An undatable
 * sibling does not count here (the year gate still applies); a tie does not
 * either.
 */
function sameTitleSiblings(show, allShows) {
  if (!show || !Array.isArray(allShows)) return [];
  const slug = showScoreTitleSlug(show);
  if (!slug) return [];
  // Show Score section: /broadway-shows, /off-broadway-shows and the London
  // pages are separate, so only a sibling in the same section shares a page.
  const section = (c) => {
    const k = String(c || '').toLowerCase();
    return k === 'west-end' || k === 'off-west-end' ? 'london' : k;
  };
  return allShows.filter((o) => o && o.id !== show.id
    && section(o.category) === section(show.category)
    && showScoreTitleSlug(o) === slug);
}

function hasNewerSameTitleProduction(show, allShows) {
  if (!show || !Array.isArray(allShows)) return false;
  // Only a CLOSED production is superseded. Concurrent same-title runs
  // (jane-eyre-off-west-end-2026 vs the Rose Kingston one) keep discovery and
  // rely on the year gate and venue check, as before.
  if (show.status !== 'closed') return false;
  const mine = productionRecencyMs(show);
  // A sibling counts only with a real date: an announced revival with no dates
  // has no Show Score page yet (same rule as isNewestProduction).
  return sameTitleSiblings(show, allShows).some((other) => {
    if (!hasProductionDate(other)) return false;
    const theirs = productionRecencyMs(other);
    return theirs !== null && (mine === null || theirs > mine);
  });
}

/**
 * Resolve a show's Show Score page URL. Prefers the curated map
 * (data/show-score-urls.json); otherwise constructs the section + slug URL,
 * unless that constructed URL is ambiguous between productions (see below).
 *
 * @param {object} show      shows.json record
 * @param {object} [urlMap]  curated show-id → URL map
 * @param {object[]} [allShows]  every shows.json record (BRO-3556). When
 *   given, a constructed URL that un-curated same-title siblings would ALSO
 *   construct goes only to the newest of them (null for the rest, and for
 *   all of them when the newest is ambiguous). Omitting it keeps the curated-map-only check.
 */
function showScoreUrlForShow(show, urlMap, allShows) {
  if (!show) return null;
  if (urlMap && typeof urlMap[show.id] === 'string' && urlMap[show.id]) {
    return urlMap[show.id];
  }
  const constructed = constructShowScoreUrl(show);
  if (!constructed) return null;
  const want = normSsUrl(constructed);

  // Never hand back a CONSTRUCTED url that another show already owns in the
  // curated map (BRO-3416). Show Score keeps one page per title — the current
  // or most recent production — so two same-title shows slugging to the same
  // URL means at most one of them is the page's actual subject, and the other
  // would ingest the wrong production's reviews. Deleting the wrong show's
  // curated entry is the established remedy (scrape-show-score-audience.js:802
  // deletes a duplicate outright), but on its own it does NOT stick here:
  // deletion drops through to this slug construction, which rebuilds the exact
  // same URL, so the mapping would effectively resurrect itself on the very
  // next gap-audit pass. That is how she-loves-me-1994 accumulated the 2016
  // Roundabout revival's notices — 21 of that directory's 22 files.
  //
  // Only CONSTRUCTED urls are gated. An explicit curated entry is returned
  // above, untouched: if an operator deliberately points two shows at one page,
  // that stays their call. This is the same "already cached for another show"
  // test scrape-show-score-audience.js:550 applies during its own discovery.
  if (urlMap) {
    for (const [id, u] of Object.entries(urlMap)) {
      if (id === show.id || typeof u !== 'string') continue;
      if (normSsUrl(u) === want) return null;
    }
  }

  // BRO-3556: the curated-map check above misses the case where BOTH same-title
  // productions are un-curated — each constructs the identical URL and both
  // silently claim the one page. Show Score keeps one page per title, showing
  // the current or most recent production, so the NEWEST colliding sibling
  // keeps the constructed URL and every older one gets null (owned by neither
  // is too costly: strict fail-closed cost 6 active shows their discovery).
  // When the newest cannot be named unambiguously (a tie, or a sibling with no
  // date at all), fail closed for every sibling until an operator curates one.
  // A sibling that IS curated (to any URL) is skipped here: if it points at this
  // URL the check above already refused it; if it points elsewhere it does not
  // compete.
  if (Array.isArray(allShows)) {
    const rivals = (constructedUrlIndex(allShows).get(want) || []).filter((other) =>
      other.id !== show.id && !(urlMap && typeof urlMap[other.id] === 'string' && urlMap[other.id]));
    if (rivals.length > 0 && !isNewestProduction(show, rivals)) return null;
  }
  return constructed;
}

/** Pull the "Read more" outlet review links from Show Score tile HTML. These are
 *  the canonical, show-specific critic review URLs. */
function extractReadMoreUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const out = new Set();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*Read more/gi)) {
    const u = m[1];
    try { if (!SS_HOSTS.test(new URL(u).hostname)) out.add(u.split('#')[0]); } catch { /* skip */ }
  }
  return [...out];
}

/**
 * Parse each critic tile on a Show Score page (or a pagination JSON's html):
 * [{ url, date, previousProduction, outlet }]. `date` is the tile's own review
 * date as YYYY-MM-DD ("January 28th, 2019"), or null. `previousProduction` is
 * Show Score's own "For a previous production" label (BRO-6629). Show Score
 * keeps one page per title, so the page for a 2024 revival also lists the 2019
 * and 2016 runs' notices; many of those URLs carry no year (curtainup.com/
 * veryhungrycaterpillarshow.html, offoffonline.com/?p=20946), so the tile date
 * is the only reliable production signal.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
function parseShowScoreTileDate(text) {
  const m = String(text || '').match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  const d = parseInt(m[2], 10);
  if (d < 1 || d > 31) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function extractShowScoreCriticTiles(html) {
  if (!html || typeof html !== 'string') return [];
  const parts = html.split(/class=["']review-tile-v2 -critic["']/).slice(1);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const m = part.match(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*Read more/i);
    if (!m) continue;
    // Some tiles wrap the outlet link in a Google redirect copied from a doc
    // (google.com/url?q=<review>&amp;sa=D...). Unwrap it so the host and URL
    // are the outlet's, not google.com.
    let url = require('./scraper').unwrapRedirectUrl(m[1].replace(/&amp;/g, '&')).split('#')[0];
    try { if (SS_HOSTS.test(new URL(url).hostname)) continue; } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const dateM = part.match(/review-tile-v2__date["'][^>]*>([^<]*)</);
    const alt = part.match(/<img[^>]*\balt=["']([^"']*)["']/);
    out.push({
      url,
      date: dateM ? parseShowScoreTileDate(dateM[1]) : null,
      previousProduction: /For a previous production/i.test(part.split(/review-tile-v2__body/)[0] || ''),
      outlet: alt ? alt[1].trim() : null,
    });
  }
  return out;
}

/**
 * Why a Show Score page we landed on (after redirects) is the wrong section
 * for this show, or null when it is acceptable (BRO-6629).
 *
 * Show Score files some real off-Broadway runs under /off-off-broadway-shows/
 * (Caesar and Cleopatra at the Gingold, Covenant at Roundabout Underground,
 * What Became of Us at Atlantic Stage 2): /off-broadway-shows/<slug> 301s
 * there. gather-reviews rejected every off-off landing, so those shows never
 * got their Show Score critic list. An off-Broadway show may land in either
 * off-Broadway section; the page-title and production-date gates downstream
 * still check it is the right production. A Broadway show keeps rejecting
 * both (the /broadway-shows/redwood -> off-off redirect case).
 */
function showScoreLandingBlockReason(finalUrl, { isOffBroadway = false } = {}) {
  const u = String(finalUrl || '');
  if (isOffBroadway) return null;
  if (u.includes('/off-off-broadway-shows/')) return 'off-off-broadway-redirect';
  if (u.includes('/off-broadway-shows/')) return 'off-broadway-redirect';
  return null;
}

/**
 * Fallback extractor (JSON-LD `url` + anchors) for the initial page when no
 * "Read more" tiles are present. Previously grabbed EVERY href/JSON-LD url on
 * the page — that harvested the page's own asset shell (cloudfront fonts,
 * doubleclick ad slots, a Google Form, a merch page) as "review candidates"
 * for The Vessel (task #1073, 2026-08-05). Now every URL must pass the
 * canonical classifyReviewUrl shape filter at the harvest point — rejecting
 * by URL/host SHAPE only, never by outlet-registry membership, so unknown
 * new outlets still surface for onboarding.
 */
function extractShowScoreReviewUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const { classifyReviewUrl } = require('./non-review-url-patterns');
  const urls = new Set();
  const add = (u) => {
    if (!u || !/^https?:\/\//i.test(u)) return;
    let host; try { host = new URL(u).hostname; } catch { return; }
    if (SS_HOSTS.test(host)) return;
    if (!classifyReviewUrl(u).ok) return;
    urls.add(u.split('#')[0]);
  };
  for (const m of html.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/gi)) add(m[1]);
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) add(m[1]);
  return [...urls];
}

/** Parse pagination attributes from the critic-reviews block. */
function parseShowScorePagination(html) {
  const np = (html || '').match(/data-next-page-path=(["'])([^"']+)\1/);
  const tc = (html || '').match(/data-total-count=(["'])(\d+)\1/);
  return { nextPagePath: np ? np[2] : null, totalCount: tc ? parseInt(tc[2], 10) : 0 };
}

/**
 * The pagination pages to request after the initial render: 2..ceil(N/8)+1
 * (the "+1 safety page" is the empty `{"html":" "}` terminator Show Score
 * returns past the last page), or [] when the first 8 already cover N.
 * Shared by fetchAllShowScoreReviewUrls below and by
 * scripts/fetch-aggregator-pages.ts's archive renderer (BRO-4204 S7-T9) so
 * the two can't drift on the page-count rule.
 *
 * @param {number|string} totalCount - data-total-count / "Critic Reviews (N)"
 * @param {number} [perPage=8]
 * @returns {number[]}
 */
function showScorePaginationPages(totalCount, perPage = 8) {
  const n = parseInt(String(totalCount), 10);
  if (!Number.isFinite(n) || n <= perPage) return [];
  const last = Math.ceil(n / perPage) + 1; // safety margin
  const pages = [];
  for (let p = 2; p <= last; p++) pages.push(p);
  return pages;
}

/**
 * Fetch ALL Show Score critic review URLs for a show, following pagination.
 *
 * @param {string} pageUrl - the show's Show Score page URL
 * @param {(url:string)=>Promise<string>} fetchHtml - returns page/JSON text for a URL
 * @returns {Promise<string[]>} de-duplicated outlet review URLs (show-page-vouched)
 */
async function fetchAllShowScoreReviewUrls(pageUrl, fetchHtml) {
  return (await fetchAllShowScoreCriticTiles(pageUrl, fetchHtml)).map((t) => t.url);
}

/**
 * Same walk as fetchAllShowScoreReviewUrls, returning tiles
 * ({ url, date, previousProduction, outlet }; see extractShowScoreCriticTiles).
 * A URL found only by the permissive fallback extractor gets date null.
 */
async function fetchAllShowScoreCriticTiles(pageUrl, fetchHtml) {
  const all = new Map();
  let html = '';
  try { html = await fetchHtml(pageUrl); } catch { return []; }
  if (!html) return [];
  // Initial page: prefer "Read more" tiles; fall back to permissive extraction.
  let initial = extractShowScoreCriticTiles(html);
  if (initial.length === 0) {
    initial = extractReadMoreUrls(html).map((url) => ({ url, date: null, previousProduction: false, outlet: null }));
  }
  if (initial.length === 0) {
    initial = extractShowScoreReviewUrls(html).map((url) => ({ url, date: null, previousProduction: false, outlet: null }));
  }
  initial.forEach((t) => all.set(t.url, t));

  const { nextPagePath, totalCount } = parseShowScorePagination(html);
  if (nextPagePath) {
    for (const page of showScorePaginationPages(totalCount)) {
      let body = '';
      try { body = await fetchHtml(`https://www.show-score.com${nextPagePath}?page=${page}`); } catch { break; }
      if (!body) break;
      let tileHtml = body;
      try { tileHtml = JSON.parse(body).html || ''; } catch { /* not JSON — use as-is */ }
      if (!tileHtml || tileHtml.length < 10) break;
      const before = all.size;
      let tiles = extractShowScoreCriticTiles(tileHtml);
      if (tiles.length === 0) {
        tiles = extractReadMoreUrls(tileHtml).map((url) => ({ url, date: null, previousProduction: false, outlet: null }));
      }
      tiles.forEach((t) => { if (!all.has(t.url)) all.set(t.url, t); });
      if (all.size === before) break; // no new URLs → stop
    }
  }
  return [...all.values()];
}

/**
 * Curated show → Show Score page map (data/show-score-urls.json). Callers pass
 * their repo root so worktrees/tests can point elsewhere. Missing or unreadable
 * file → {} (constructed urls still work for NYC shows).
 */
function loadShowScoreUrlMap(root) {
  try {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'show-score-urls.json'), 'utf8'));
    return raw.shows || raw || {};
  } catch {
    return {};
  }
}

/**
 * The show's own poster on a Show Score page: { poster, thumbnail } or null.
 * The page's og:image (".../fb-posts/image/show/<id>_<n>.jpg", or a
 * poster_image url) names the show's folder; only a medium_ poster in that
 * folder counts. Without an og:image there is no answer: the first
 * poster_image on a page can be a promoted show's (one "Chicks in Heaven" file
 * went onto 18 London fringe rows, BRO-4996). Any of Show Score's CloudFront
 * hosts (d4ov6iqsvotvt, later dalyklerwhmui).
 */
function showScorePosterFromHtml(html) {
  const tag = (String(html || '').match(/<meta[^>]+og:image[^>]*>/i) || [])[0] || '';
  const og = (tag.match(/content="([^"]+)"/i) || [])[1] || '';
  const folder = (og.match(/\/(?:poster_image|image\/show)\/(\d+)[/_]/) || [])[1];
  if (!folder) return null;
  const re = new RegExp(`https://[a-z0-9]+\\.cloudfront\\.net/uploads/show/poster_image/${folder}/medium_[^"'<\\s]+\\.(?:jpg|jpeg|png)`, 'i');
  const poster = (String(html).match(re) || [])[0];
  return poster ? { poster, thumbnail: poster.replace('/medium_', '/preview_') } : null;
}

/**
 * True when a guessed BARE-title Show Score slug for `show` may land on
 * another production's page (BRO-3556): a closed production with a newer
 * same-title sibling, or a production with no real date (an announced
 * revival) that has any same-title sibling, since isUrlYearOutOfWindow can
 * block nothing without dates. Slugs carrying the production's year are
 * still safe to try.
 */
function bareSlugGuessUnsafe(show, allShows) {
  if (hasNewerSameTitleProduction(show, allShows)) return true;
  return !hasProductionDate(show) && sameTitleSiblings(show, allShows).length > 0;
}

/** Gate gather-reviews' slug variations with the canonical page ownership rule.
 * Year-specific guesses may still find an older production's dedicated page.
 * London retains its own slug variations since constructed NYC URLs do not apply.
 */
function showScoreSlugGuessBlockReason(show, url, urlMap, allShows, year) {
  const want = normSsUrl(url);
  if (Object.entries(urlMap || {}).some(([id, u]) =>
    id !== show.id && typeof u === 'string' && normSsUrl(u) === want)) {
    return 'curated page of another production';
  }
  const bareUnsafe = !Array.isArray(allShows)
    || bareSlugGuessUnsafe(show, allShows)
    || (constructShowScoreUrl(show) && !showScoreUrlForShow(show, urlMap, allShows));
  const yearTag = year ? `-${year}` : null;
  if (bareUnsafe && !(yearTag && new URL(url).pathname.includes(yearTag))) {
    return 'bare title; a same-title production may own it';
  }
  return null;
}

module.exports = {
  showScoreLandingBlockReason,
  showScorePosterFromHtml,
  showScoreUrlForShow,
  constructShowScoreUrl,
  productionRecencyMs,
  hasNewerSameTitleProduction,
  bareSlugGuessUnsafe,
  showScoreSlugGuessBlockReason,
  loadShowScoreUrlMap,
  extractShowScoreReviewUrls,
  extractReadMoreUrls,
  parseShowScorePagination,
  showScorePaginationPages,
  fetchAllShowScoreReviewUrls,
  fetchAllShowScoreCriticTiles,
  extractShowScoreCriticTiles,
  parseShowScoreTileDate,
};
