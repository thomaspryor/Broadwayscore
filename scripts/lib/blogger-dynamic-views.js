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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Feed JSON (string or parsed) → minimal classic-Blogger HTML, or null.
function bloggerFeedToHtml(feed) {
  let d = feed;
  if (typeof d === 'string') {
    // fetch providers sometimes wrap JSON in <pre>/<body>; take the outer object
    const start = d.indexOf('{');
    const end = d.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { d = JSON.parse(d.slice(start, end + 1)); } catch { return null; }
  }
  const e = d && d.entry;
  const content = e && e.content && e.content.$t;
  if (typeof content !== 'string' || content.trim().length < 200) return null;
  const title = (e.title && e.title.$t) || '';
  const published = (e.published && e.published.$t) || '';
  const author = (e.author && e.author[0] && e.author[0].name && e.author[0].name.$t) || '';
  return [
    '<html><head>',
    `<title>${escapeHtml(title)}</title>`,
    published ? `<meta property="article:published_time" content="${escapeHtml(published)}">` : '',
    author ? `<meta name="author" content="${escapeHtml(author)}">` : '',
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
    const rebuilt = bloggerFeedToHtml(raw);
    if (!rebuilt) return { html, expanded: false, feedUrl, error: 'feed entry had no usable content' };
    return { html: rebuilt, expanded: true, feedUrl };
  } catch (err) {
    return { html, expanded: false, feedUrl, error: err && err.message };
  }
}

module.exports = { bloggerDynamicViewsPostId, bloggerFeedUrl, bloggerFeedToHtml, expandBloggerDynamicViews };
