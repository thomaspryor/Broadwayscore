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

/**
 * Resolve a show's Show Score page URL. Prefers the curated map
 * (data/show-score-urls.json); otherwise constructs the section + slug URL.
 */
function showScoreUrlForShow(show, urlMap) {
  if (!show) return null;
  if (urlMap && typeof urlMap[show.id] === 'string' && urlMap[show.id]) {
    return urlMap[show.id];
  }
  if (!show.title) return null;
  // foldDiacritics FIRST: without it "Les Misérables" slugs to
  // "les-mis-rables" (the é is a non-[a-z0-9] char and becomes a separator),
  // which 404s. Show Score's own slugs are ASCII-folded. Task #648.
  const slug = foldDiacritics(show.title)
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  // shows get Show Score only via an explicit curated entry above.
  if (cat !== 'broadway' && cat !== 'off-broadway') return null;
  const section = cat === 'off-broadway' ? 'off-broadway-shows' : 'broadway-shows';
  const constructed = `https://www.show-score.com/${section}/${slug}`;

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
    const want = constructed.toLowerCase();
    for (const [id, u] of Object.entries(urlMap)) {
      if (id === show.id || typeof u !== 'string') continue;
      if (u.toLowerCase().replace(/\/+$/, '') === want) return null;
    }
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
 * Fetch ALL Show Score critic review URLs for a show, following pagination.
 *
 * @param {string} pageUrl - the show's Show Score page URL
 * @param {(url:string)=>Promise<string>} fetchHtml - returns page/JSON text for a URL
 * @returns {Promise<string[]>} de-duplicated outlet review URLs (show-page-vouched)
 */
async function fetchAllShowScoreReviewUrls(pageUrl, fetchHtml) {
  const all = new Set();
  let html = '';
  try { html = await fetchHtml(pageUrl); } catch { return []; }
  if (!html) return [];
  // Initial page: prefer "Read more" tiles; fall back to permissive extraction.
  let initial = extractReadMoreUrls(html);
  if (initial.length === 0) initial = extractShowScoreReviewUrls(html);
  initial.forEach(u => all.add(u));

  const { nextPagePath, totalCount } = parseShowScorePagination(html);
  if (nextPagePath && totalCount > 8) {
    const maxPages = Math.ceil(totalCount / 8) + 1; // safety margin
    for (let page = 2; page <= maxPages; page++) {
      let body = '';
      try { body = await fetchHtml(`https://www.show-score.com${nextPagePath}?page=${page}`); } catch { break; }
      if (!body) break;
      let tileHtml = body;
      try { tileHtml = JSON.parse(body).html || ''; } catch { /* not JSON — use as-is */ }
      if (!tileHtml || tileHtml.length < 10) break;
      const before = all.size;
      extractReadMoreUrls(tileHtml).forEach(u => all.add(u));
      if (all.size === before) break; // no new URLs → stop
    }
  }
  return [...all];
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

module.exports = {
  showScoreUrlForShow,
  loadShowScoreUrlMap,
  extractShowScoreReviewUrls,
  extractReadMoreUrls,
  parseShowScorePagination,
  fetchAllShowScoreReviewUrls,
};
