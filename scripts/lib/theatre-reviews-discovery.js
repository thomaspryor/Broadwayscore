'use strict';

/**
 * theatre-reviews-discovery.js — find a show's theatre.reviews round-up via
 * the site's WordPress search API (BRO-4431).
 *
 * gather-reviews.js used to scan only the theatre.reviews homepage, which
 * lists the latest ~10 posts: a round-up that had scrolled off (Golden Boy,
 * Cleansed at the Almeida) was never found, so its paywalled Times/FT/i
 * entries never reached us. `wp-json/wp/v2/posts?search=` answers a plain
 * request and covers the whole archive.
 */

const { normalizeTitle } = require('./title-match');

function _decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&amp;|&#038;/g, '&')
    .replace(/&#\d+;/g, ' ');
}

/**
 * Pick the round-up post for `showTitle` from a WP posts API response.
 * A post qualifies when its link is a /reviews-roundup/ page and its title
 * or slug contains every word of the normalized show title. Returns the
 * link or null.
 */
function pickTheatreReviewsRoundup(posts, showTitle) {
  if (!Array.isArray(posts) || !showTitle) return null;
  const want = normalizeTitle(showTitle).split(' ').filter(Boolean);
  if (!want.length) return null;
  for (const p of posts) {
    const link = p && typeof p.link === 'string' ? p.link : '';
    if (!/\/reviews-roundup\//.test(link)) continue;
    const title = normalizeTitle(_decode(p.title && p.title.rendered));
    const slug = String(p.slug || '').replace(/-/g, ' ');
    const haystack = ` ${title} ${slug} `;
    if (want.every((w) => haystack.includes(` ${w} `))) return link;
  }
  return null;
}

/**
 * Homepage variant of pickTheatreReviewsRoundup (BRO-4828): anchors are
 * [{ href, text }] from `a[href*="/reviews-roundup/"]`. The scan used to match
 * on the first 8 characters of the title, so "The Hungry Ghost" ("the hung")
 * accepted "The Hunger Games On Stage". Same every-title-word rule as the
 * WP-API picker; returns an absolute URL or null.
 */
function pickTheatreReviewsRoundupFromAnchors(anchors, showTitle) {
  if (!Array.isArray(anchors)) return null;
  const posts = anchors
    .filter((a) => a && typeof a.href === 'string')
    .map((a) => ({
      link: a.href.startsWith('http') ? a.href : `https://theatre.reviews${a.href}`,
      title: { rendered: a.text || '' },
      slug: a.href.replace(/\/+$/, '').split('/').pop(),
    }));
  return pickTheatreReviewsRoundup(posts, showTitle);
}

const ROUNDUP_CATEGORY_ID = 2030;
const REST_PER_PAGE = 100;
const REST_MAX_PAGES = 12;

/**
 * Walk the whole reviews-roundup category through the WP REST API (BRO-6084).
 * `fetchJSON(url)` is injected (the shared scraper's fetchJSON in production)
 * so pagination is testable. A page shorter than per_page is the last one; a
 * null/non-array answer (WP answers 400 past the last page) also ends the walk.
 * Returns { posts, pages, complete }; complete is true only when a short
 * (last) page was seen.
 */
async function discoverRoundupPostsRest(fetchJSON, opts = {}) {
  const perPage = opts.perPage || REST_PER_PAGE;
  const maxPages = opts.maxPages || REST_MAX_PAGES;
  const category = opts.category || ROUNDUP_CATEGORY_ID;
  const fields = '&_fields=id,date,modified,link,slug,title';
  const posts = [];
  const seen = new Set();
  let pages = 0;
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    let batch = null;
    try {
      batch = await fetchJSON(`https://theatre.reviews/wp-json/wp/v2/posts?categories=${category}&per_page=${perPage}&page=${page}&orderby=date&order=desc${fields}`);
    } catch (e) {
      // WP answers 400 (rest_post_invalid_page_number) one page past a full last page: that is the end.
      if (page > 1 && pages === page - 1 && /\b400\b|invalid_page_number/.test(String(e && e.message))) { complete = true; break; }
      batch = null;
    }
    if (!Array.isArray(batch)) break; // a failed page is an incomplete walk, never a quiet end
    pages++;
    for (const p of batch) {
      const key = p && (p.id != null ? `id:${p.id}` : p.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      posts.push(p);
    }
    if (batch.length < perPage) { complete = true; break; }
  }
  return { posts, pages, complete };
}

/**
 * Body venue (the <h5> under the headline) for the given round-up post ids,
 * one small REST call each. A failed fetch just leaves that id out.
 * @returns {Promise<Record<string,string>>} id -> venue text
 */
async function fetchRoundupBodyVenues(fetchJSON, ids) {
  const { venueFromContent } = require('./tr-roundup-match');
  const out = {};
  for (const id of ids) {
    try {
      const post = await fetchJSON(`https://theatre.reviews/wp-json/wp/v2/posts/${id}?_fields=id,content`);
      const v = venueFromContent(post && post.content && (post.content.rendered ?? post.content));
      if (v) out[id] = v;
    } catch (_) { /* leave unresolved */ }
  }
  return out;
}

module.exports = {
  fetchRoundupBodyVenues,
  pickTheatreReviewsRoundup, pickTheatreReviewsRoundupFromAnchors,
  discoverRoundupPostsRest, ROUNDUP_CATEGORY_ID,
};
