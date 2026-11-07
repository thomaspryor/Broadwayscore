'use strict';

/**
 * Read a review's publish date from its own article page HTML. Pure, no I/O.
 *
 * One copy for every caller (collect-review-texts.js, backfill-review-dates.js,
 * backfill-network-tier-dates.js). Each used to carry its own copy, and only
 * one of them knew The Stage's dateline (BRO-5674).
 *
 * Order, most to least reliable:
 *   1. JSON-LD datePublished / dateCreated (also nested @graph)
 *   2. meta tags (article:published_time, itemprop=datePublished, parsely, ...)
 *   3. <time datetime>, preferring one marked as the publish date
 *   4. outlet datelines without metadata (The Stage)
 *   5. the visible dateline: an element whose class/id/itemprop names a
 *      publish date ("publish-date", "entry-date", "posted-on", "byline", ...),
 *      then a "Month D, YYYY h:mm AM" stamp, then a "Month D, YYYY" right after
 *      a "By <name>" byline.
 *
 * Step 5 was missing. Theatrely (Webflow) prints only
 * `<div class="publish-date">October 19, 2026 12:00 AM</div>`, so its reviews
 * got no page date and kept whatever an aggregator or a body-text regex had
 * put there: Other Desert Cities (2026), stored 2026-10-16, page dated
 * 2026-10-19. Related-post teasers further down the same page carry
 * "By <name> on October 16, 2026", which is why the byline rule takes the
 * FIRST match and the classed element is tried before it.
 */

const { localizeIsoStamp } = require('./local-date');
const { maxPlausibleYear } = require('./date-utils');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
// "October 19, 2026" / "Oct. 19 2026" / "19 October 2026" (UK)
const MDY = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i');
const DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE}),?\\s+(\\d{4})\\b`, 'i');
const MDY_WITH_TIME = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?:\\s+at)?\\s+\\d{1,2}:\\d{2}\\s*[AP]\\.?M\\.?`, 'i');

function monthIndex(name) {
  const k = String(name || '').toLowerCase().replace(/\./g, '').slice(0, 3);
  return MONTHS.findIndex(m => m.startsWith(k));
}

function ymd(year, monthIdx, day) {
  const y = Number(year), m = monthIdx + 1, d = Number(day);
  if (!(y >= 1970 && y <= maxPlausibleYear({ atLeast: 2030 }))) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // Feb 30
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A written-out date in a short string ("October 19, 2026 12:00 AM", "19 October 2026") as YYYY-MM-DD, or null. */
function parseWrittenDate(text) {
  const s = String(text || '');
  const a = s.match(MDY);
  const b = s.match(DMY);
  // Take whichever starts first in the string.
  if (a && (!b || a.index <= b.index)) return ymd(a[3], monthIndex(a[1]), a[2]);
  if (b) return ymd(b[3], monthIndex(b[2]), b[1]);
  return null;
}

/**
 * Normalize a date string from page metadata to YYYY-MM-DD. ISO date parts are
 * read directly (no timezone shift), except a UTC stamp, which is moved to the
 * publisher's local date first (BRO-5499, local-date.js).
 */
function normalizeExtractedDate(dateStr, pageUrl) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  dateStr = localizeIsoStamp(dateStr, pageUrl);
  try {
    const iso = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return ymd(iso[1], Number(iso[2]) - 1, iso[3]);
    const written = parseWrittenDate(dateStr);
    if (written) return written;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return ymd(d.getFullYear(), d.getMonth(), d.getDate());
  } catch (e) {
    return null;
  }
}

function jsonLdItems(data, out = []) {
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data)) { for (const x of data) jsonLdItems(x, out); return out; }
  out.push(data);
  if (Array.isArray(data['@graph'])) jsonLdItems(data['@graph'], out);
  return out;
}

function fromJsonLd(html, pageUrl) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    for (const item of jsonLdItems(data)) {
      const date = item.datePublished || item.dateCreated;
      if (typeof date === 'string') {
        const n = normalizeExtractedDate(date, pageUrl);
        if (n) return n;
      }
    }
  }
  return null;
}

const META_PATTERNS = [
  /<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
  /<meta[^>]*property=["']og:article:published_time["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]*itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]*content=["']([^"']+)["'][^>]*itemprop=["']datePublished["']/i,
  /<meta[^>]*name=["'](?:parsely-pub-date|pubdate|publish-date|publishdate|sailthru\.date|article\.published)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]*name=["']DC\.date\.issued["'][^>]*content=["']([^"']+)["']/i,
];

function fromMeta(html, pageUrl) {
  for (const re of META_PATTERNS) {
    const m = html.match(re);
    if (m && m[1]) {
      const n = normalizeExtractedDate(m[1], pageUrl);
      if (n) return n;
    }
  }
  return null;
}

const PUBLISH_MARK = /(publish|pub-?date|post-?date|posted|entry-date|article-date|date-published|datePublished|dateline)/i;

function fromTimeElement(html, pageUrl) {
  const tags = html.match(/<time\b[^>]*\bdatetime=["'][^"']+["'][^>]*>/gi) || [];
  if (!tags.length) return null;
  // A <time> marked as the publish date wins over the first <time> on the page
  // (which can be a header clock or an "updated" stamp).
  const marked = tags.find(t => PUBLISH_MARK.test(t.replace(/datetime=["'][^"']*["']/i, '')));
  for (const t of marked ? [marked, ...tags] : tags) {
    const v = t.match(/datetime=["']([^"']+)["']/i);
    const n = v && normalizeExtractedDate(v[1], pageUrl);
    if (n) return n;
  }
  return null;
}

function fromOutletDateline(html) {
  // The Stage (thestage.co.uk): <span class="aos-ArticleDate...">Dec 1, 2025</span>
  const stage = html.match(/aos-ArticleDate[^>]*>((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},\s*\d{4})/i);
  return stage ? parseWrittenDate(stage[1]) : null;
}

/** Elements whose dates are never the article's: comment threads, related-post teasers, sidebars. ("widget" is not here: Blogger wraps the post itself in class="widget Blog".) */
const NON_ARTICLE_BLOCK = /\b(?:class|id)=["'][^"']*(?:comment|related|recommend|teaser|more-stories|read-next|sidebar)[^"']*["']/i;
/** A site header (its "today" date is the fetch date). An article's own <header class="entry-header"> is kept. */
const SITE_HEADER = /<header\b(?=[^>]*(?:role=["']banner["']|(?:class|id)=["'][^"']*(?:site|masthead|global|top-?bar|navbar|page-header)[^"']*["']))[^>]*>[\s\S]*?<\/header>/gi;

/** Remove every element (and its content) whose opening-tag attributes match attrRe. Balanced on the tag name. */
function stripBlocks(html, attrRe) {
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = open.exec(html)) !== null) {
    if (!attrRe.test(m[2] || '')) continue;
    const tag = m[1].toLowerCase();
    if (/\/\s*$/.test(m[2] || '')) continue; // self-closing
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, end = html.length, t;
    while ((t = re.exec(html)) !== null) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    out += html.slice(pos, m.index) + ' ';
    pos = end;
    open.lastIndex = end;
  }
  return out + html.slice(pos);
}

/**
 * The part of the page that is the article: scripts, styles, HTML comments,
 * nav/footer/aside, the site header, comment threads and related-post teasers
 * removed; then, when the page has an <article>, only that.
 */
function articleHtml(html) {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(SITE_HEADER, ' ');
  h = stripBlocks(h, NON_ARTICLE_BLOCK);
  // A page without <article> keeps everything left, minus a leading top-level
  // <header> (Webflow/static sites put the site banner there).
  const start = h.search(/<article\b/i);
  if (start >= 0) {
    const end = h.lastIndexOf('</article>');
    if (end > start) h = h.slice(start, end);
  } else {
    h = h.replace(/^([\s\S]*?<body\b[^>]*>\s*)<header\b[\s\S]*?<\/header>/i, '$1 ');
  }
  return h;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// class / id / itemprop values that mark a dateline element.
const DATELINE_ATTR = /\b(?:class|id|itemprop)=["']([^"']*)["']/gi;
const DATELINE_NAME = /(publish|pub-?date|post-?date|posted|entry-date|article-date|date-published|datepublished|dateline|byline|post-meta|entry-meta|article-meta|meta-date|(?:^|[\s_-])date(?:$|[\s_-]))/i;
// Named date elements that are not the publish date (fetch date, show dates, edits, print edition).
const NOT_PUBLISH_NAME = /(current|today|clock|update|modif|edited|print|comment|event|show-?date|opening|closing|preview|performance|(?:^|[\s_-])run|schedule|booking)/i;
// A date preceded by one of these words is not the publish date.
const NOT_PUBLISH_PREFIX = /\b(updated|modified|edited|revised|print|opening|opens|opened|closing|closes|closed|previews?|through|until|runs?|playing|performances?|comments?|replied)\b(?:\W+[a-z]{1,10}){0,3}\W*$/i;

const ANY_DATE = new RegExp(`(?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_RE}),?\\s+\\d{4}`, 'gi');

/** First written date in text whose preceding words do not mark it as an edit/print/show date. */
function firstPublishDateIn(text) {
  ANY_DATE.lastIndex = 0;
  let m;
  while ((m = ANY_DATE.exec(text)) !== null) {
    if (NOT_PUBLISH_PREFIX.test(text.slice(Math.max(0, m.index - 50), m.index))) continue;
    const d = parseWrittenDate(m[0]);
    if (d) return d;
  }
  return null;
}

function fromVisibleDateline(html) {
  const body = articleHtml(html);

  // 5a. An element named as a dateline whose own text holds a written date.
  const openTag = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = openTag.exec(body)) !== null) {
    const attrs = m[2];
    if (!attrs) continue;
    let named = false;
    let excluded = false;
    let a;
    DATELINE_ATTR.lastIndex = 0;
    while ((a = DATELINE_ATTR.exec(attrs)) !== null) {
      if (NOT_PUBLISH_NAME.test(a[1])) { excluded = true; break; }
      if (DATELINE_NAME.test(a[1])) named = true;
    }
    if (!named || excluded) continue;
    // Text up to the element's close (bounded; enough for "By X | October 19, 2026").
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const close = after.search(new RegExp(`</${m[1]}>`, 'i'));
    const inner = stripTags(close >= 0 ? after.slice(0, close) : after.slice(0, 200));
    if (inner.length > 160) continue; // a container, not a dateline
    const d = firstPublishDateIn(inner);
    if (d) return { date: d, method: 'html-dateline-element' };
  }

  const text = stripTags(body);
  const labelled = (idx) => NOT_PUBLISH_PREFIX.test(text.slice(Math.max(0, idx - 50), idx));

  // 5b. A date with a clock time is a publish stamp, not a run date
  // (unless labelled Updated/Modified/print).
  const timedRe = new RegExp(MDY_WITH_TIME.source, 'gi');
  let timed;
  while ((timed = timedRe.exec(text)) !== null) {
    if (labelled(timed.index)) continue;
    const d = ymd(timed[3], monthIndex(timed[1]), timed[2]);
    if (d) return { date: d, method: 'html-dateline-timestamp' };
  }

  // 5c. "By <Name> [on|,|•|-|\|] October 19, 2026" (first byline in the article).
  const byline = new RegExp(`\\bBy\\s+[A-Z][\\w.'’-]*(?:\\s+[A-Z][\\w.'’-]*){0,3}\\s*(?:on|,|\\||•|·|-|–|—|/)?\\s*(?:Published:?\\s*|Posted:?\\s*)?((?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_RE}),?\\s+\\d{4})`);
  const by = text.match(byline);
  if (by) {
    const d = parseWrittenDate(by[1]);
    if (d) return { date: d, method: 'html-dateline-byline' };
  }
  // 5d. "Published October 19, 2026" / "Posted on October 19, 2026".
  const label = new RegExp(`\\b(?:Published|Posted)(?:\\s+on)?:?\\s+((?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_RE}),?\\s+\\d{4})`, 'i');
  const lab = text.match(label);
  if (lab) {
    const d = parseWrittenDate(lab[1]);
    if (d) return { date: d, method: 'html-dateline-label' };
  }
  // 5e. A sign-off "--David Barbour (6 May 2026)" (Lighting & Sound America
  // prints the date only there). Only when the page has exactly one.
  const signoff = new RegExp(`(?:--|—|–)\\s*[A-Z][\\w.'’-]*(?:\\s+[A-Z][\\w.'’-]*){0,3}\\s*\\(((?:${MONTH_RE})\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${MONTH_RE}),?\\s+\\d{4})\\)`, 'g');
  const signs = text.match(signoff) || [];
  if (signs.length === 1) {
    const d = parseWrittenDate(signs[0]);
    if (d) return { date: d, method: 'html-dateline-signoff' };
  }
  return null;
}

/**
 * True when the page's JSON-LD carries more than one entity with different
 * datePublished values. article-extractor.extractPublishDate abstains then
 * unless one entity is this page (2026-07-11: a related article's date was
 * stored), so the first-match JSON-LD and <time> readers must not pick one.
 */
function jsonLdDatesAmbiguous(html, pageUrl) {
  const dates = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    for (const item of jsonLdItems(data)) {
      if (typeof item.datePublished !== 'string') continue;
      const n = normalizeExtractedDate(item.datePublished, pageUrl);
      if (n) dates.add(n);
    }
  }
  return dates.size > 1;
}

/**
 * @param {string} html - the article page
 * @param {string} [pageUrl] - used to pick the publisher's timezone for UTC stamps
 * @returns {{date: string, method: string}|null}
 */
function extractPublishDateDetailed(html, pageUrl) {
  if (!html || typeof html !== 'string' || html.length < 100) return null;
  let d;
  // Scoped first: og/article:published_time, then the JSON-LD entity whose URL
  // is this page (never an embedded related article's date). article-extractor.js
  // requires this file lazily, so this require stays inside the function.
  try {
    d = require('./article-extractor').extractPublishDate(html, pageUrl);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, method: 'scoped-metadata' };
  } catch (e) { /* fall through to the first-match readers */ }
  // Several JSON-LD entities with different dates and none is this page: the
  // scoped reader abstained on purpose, so the first-match JSON-LD and <time>
  // readers would only pick a related article's date.
  const ambiguous = jsonLdDatesAmbiguous(html, pageUrl);
  if (!ambiguous && (d = fromJsonLd(html, pageUrl))) return { date: d, method: 'json-ld' };
  if ((d = fromMeta(html, pageUrl))) return { date: d, method: 'meta' };
  if (!ambiguous && (d = fromTimeElement(html, pageUrl))) return { date: d, method: 'time-element' };
  if ((d = fromOutletDateline(html))) return { date: d, method: 'outlet-dateline' };
  return fromVisibleDateline(html);
}

/** YYYY-MM-DD read from the article page, or null. */
function extractPublishDateFromHtml(html, pageUrl) {
  const r = extractPublishDateDetailed(html, pageUrl);
  return r ? r.date : null;
}

module.exports = {
  extractPublishDateFromHtml,
  extractPublishDateDetailed,
  normalizeExtractedDate,
  parseWrittenDate,
};
