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

const POST_PATH = /\/\d{4}\/\d{2}\/[^/]+\.html$/;
const ROUNDUP_TITLE = /\b(roundup|round-up|and more|this week|top \d+|\d+ shows|best of|bulletin|things to do)\b/i;

/**
 * A failed mention check may be waived when the post is a single Blogger post (dated .html path, not a
 * label or archive page) on a titledReviews blog and its page <title> is exactly "Blog name: Show".
 * That title is the proof the URL is the right post (the lane admits the feed item on the same test), so a
 * post that never repeats the title in its body (A Few Good Men: 0 mentions) still passes. Roundup wording
 * and any extra title segment ("Blog: Theater Bulletin: Chicago") refuse.
 */
function titledBlogMentionWaiver(url, sanity, showTitle) {
  if (!isTitledBlogUrl(url) || !sanity || sanity.htmlTitleMatch !== true) return false;
  let path = '';
  try { path = new URL(url).pathname; } catch { return false; }
  if (!POST_PATH.test(path)) return false;
  const title = String(sanity.htmlTitle || '');
  if (ROUNDUP_TITLE.test(title)) return false;
  const segs = title.split(/\s*:\s*/).filter(Boolean);
  return segs.length === 2 && headlineIsShowTitle(segs[1], showTitle);
}

module.exports = { isTitledBlogUrl, titledBlogMentionWaiver, TITLED_BLOG_HOSTS };
