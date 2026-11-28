'use strict';
/**
 * Blogger "Dynamic Views" pages render the post body in the browser, so the
 * server HTML holds only a 150-char description and article extraction
 * returns 0 chars (BRO-8210: newyorktheatrereview.blogspot.com, submission
 * #1199). The same post is public in Blogger's feed API, so a Dynamic Views
 * page is rebuilt as ordinary Blogger HTML from
 * /feeds/posts/default/<postId>?alt=json, which the existing .post-body
 * extractor pattern then reads.
 *
 * Pure helpers (detect, feed URL, feed → HTML) plus one async wrapper that
 * takes the fetch function, so callers keep using fetchPage().
 */

// Dynamic Views pages carry the Blogger widget bootstrap with the template
// name and the numeric post id; classic templates print .post-body instead.
function bloggerDynamicViewsPostId(html) {
  if (typeof html !== 'string' || !html) return null;
  if (/class=['"][^'"]*\bpost-body\b/.test(html)) return null; // classic template: body is in the HTML
  if (!/'name':\s*'Dynamic Views'/.test(html) && !/blogblog\.com\/dynamicviews\//.test(html)) return null;
  const m = html.match(/'postId':\s*'(\d{5,})'/);
  return m ? m[1] : null;
}

function bloggerFeedUrl(pageUrl, postId) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !postId || !/^\d+$/.test(String(postId))) return null;
  return `https://${u.host}/feeds/posts/default/${postId}?alt=json`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A browser-rendering fetch tier returns a JSON URL as <pre>-wrapped,
// entity-escaped text; undo the escaping before JSON.parse.
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
}

function postPath(u) {
  try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return null; }
}

// Feed JSON (string or parsed) → minimal classic-Blogger HTML, or null.
// No author meta: the feed's author is the Blogger account (often a house
// handle like "NYTR"), not the critic; the caller's --critic or the body wins.
function bloggerFeedToHtml(feed, { postId = null, pageUrl = null } = {}) {
  let d = feed;
  if (typeof d === 'string') {
    // fetch providers sometimes wrap JSON in <pre>/<body>; take the outer object
    if (/^\s*</.test(d)) d = decodeEntities(d.replace(/<\/?(html|head|body|pre)[^>]*>/gi, ''));
    const start = d.indexOf('{');
    const end = d.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { d = JSON.parse(d.slice(start, end + 1)); } catch { return null; }
  }
  const e = d && d.entry;
  const content = e && e.content && e.content.$t;
  if (typeof content !== 'string' || content.trim().length < 200) return null;
  // Identity: the entry must be the post we asked for (id and/or alternate link).
  if (postId) {
    const id = (e.id && e.id.$t) || '';
    if (!new RegExp(`\\.post-${postId}$`).test(id)) return null;
  }
  if (pageUrl) {
    const alt = (e.link || []).find((l) => l && l.rel === 'alternate');
    if (alt && alt.href && postPath(alt.href) !== postPath(pageUrl)) return null;
  }
  // A feed set to "until jump break" ends at a Read-more link: not the full review.
  if (/<a[^>]+href=['"][^'"]*#more['"]/i.test(content)) return null;
  const title = (e.title && e.title.$t) || '';
  const published = (e.published && e.published.$t) || '';
  return [
    '<html><head>',
    `<title>${escapeHtml(title)}</title>`,
    published ? `<meta property="article:published_time" content="${escapeHtml(published)}">` : '',
    '</head><body>',
    `<h3 class='post-title entry-title'>${escapeHtml(title)}</h3>`,
    `<div class='post-body entry-content'>${content}</div>`,
    "<div class='post-footer'></div>",
    '</body></html>',
  ].join('\n');
}

/**
 * If `html` is a Blogger Dynamic Views shell, fetch the feed entry and return
 * rebuilt HTML; otherwise return the input unchanged.
 * fetchFn(url) → string | { content|html|body }.
 */
async function expandBloggerDynamicViews(html, pageUrl, fetchFn) {
  const postId = bloggerDynamicViewsPostId(html);
  if (!postId) return { html, expanded: false };
  const feedUrl = bloggerFeedUrl(pageUrl, postId);
  if (!feedUrl) return { html, expanded: false };
  try {
    const r = await fetchFn(feedUrl);
    const raw = typeof r === 'string' ? r : (r && (r.content || r.html || r.body)) || '';
    const rebuilt = bloggerFeedToHtml(raw, { postId, pageUrl });
    if (!rebuilt) return { html, expanded: false, feedUrl, error: 'feed entry missing, truncated, or not this post' };
    return { html: rebuilt, expanded: true, feedUrl };
  } catch (err) {
    return { html, expanded: false, feedUrl, error: err && err.message };
  }
}

/**
 * Collector form (BRO-8224): `result` is a fetched article
 * { html, text, method }. When its HTML is a Dynamic Views shell, return the
 * same shape with the feed-rebuilt html and the text re-extracted from it by
 * the caller's own `extractText(html)`; otherwise return `result` unchanged.
 * `method` is kept so the caller's source-method mapping still applies.
 */
async function expandFetchedArticle(result, pageUrl, fetchFn, extractText) {
  if (!result || typeof result.html !== 'string') return result;
  const bdv = await expandBloggerDynamicViews(result.html, pageUrl, fetchFn);
  if (!bdv.expanded) {
    return bdv.feedUrl ? { ...result, bloggerFeedUrl: bdv.feedUrl, bloggerFeedError: bdv.error || 'unknown' } : result;
  }
  return { ...result, html: bdv.html, text: extractText(bdv.html), bloggerFeedUrl: bdv.feedUrl };
}

module.exports = { bloggerDynamicViewsPostId, bloggerFeedUrl, bloggerFeedToHtml, expandBloggerDynamicViews, expandFetchedArticle };
