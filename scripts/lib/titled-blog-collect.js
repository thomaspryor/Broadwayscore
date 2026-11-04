'use strict';

/**
 * Text collection for the titledReviews blogs in LANE_FEEDS (BRO-6965).
 * Bob's Theater Blog heads each review with the bare show title, under the blog name
 * ("Gotham Playgoer: Other Desert Cities"). Two things then go wrong in the collector:
 *   - Playwright lands on a Google "sorry" page for blogspot hosts, and every paid scraper
 *     returns nothing; a plain HTTP request to the post answers 200 with the full page.
 *   - A short post names the show once, and the "show mentioned" check (needs 2) rejects it
 *     although the page <title> is exactly the show's title.
 * Read-only use of the lane config (code freeze): the hosts come from LANE_FEEDS itself.
 */

const { LANE_FEEDS } = require('./opening-night-lane/lane-sources');
const { headlineIsShowTitle } = require('./opening-night-lane/discovery');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

const TITLED_BLOG_HOSTS = new Set(
  LANE_FEEDS.filter((f) => f.titledReviews).map((f) => hostOf(f.url)).filter(Boolean)
);

function isTitledBlogUrl(url) {
  return TITLED_BLOG_HOSTS.has(hostOf(url));
}

/**
 * A failed mention check may be waived when the post is on a titledReviews blog and one
 * segment of its page <title> ("Blog name: Show") is exactly the show's title.
 */
function titledBlogMentionWaiver(url, sanity, showTitle) {
  if (!isTitledBlogUrl(url) || !sanity || sanity.htmlTitleMatch !== true) return false;
  return String(sanity.htmlTitle || '').split(/\s*(?:[:|–—]|\s-\s)\s*/).some((seg) => headlineIsShowTitle(seg, showTitle));
}

module.exports = { isTitledBlogUrl, titledBlogMentionWaiver, TITLED_BLOG_HOSTS };
