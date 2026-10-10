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

module.exports = { pickTheatreReviewsRoundup };
