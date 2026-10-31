/**
 * theatreinchicago.com page readers (BRO-6518).
 *
 * Pure parsers (no network). Fetching goes through fetchPage() in
 * scripts/theatreinchicago-crawl.js. The site's own verdict
 * (Highly / Recommended / Somewhat / Not Recommended) is a cross-check only,
 * like dtliThumb; scores come from the normal LLM scoring pipeline.
 *
 * Page shapes:
 *   /reviewlistings.php            current list: one .review-item per show
 *   /<any-slug>/reviews/<ID>/      reviews page (the site 301s any slug to the
 *                                  canonical one, so fetch with skipVerify)
 *   /<slug>/<ID>/                  detail page: Show Type, address, description
 */

const cheerio = require('cheerio');

const BASE = 'https://www.theatreinchicago.com';

const VERDICTS = {
  'highly recommended': 'highly',
  'recommended': 'recommended',
  'somewhat recommended': 'somewhat',
  'not recommended': 'not',
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeVerdict(raw) {
  return VERDICTS[clean(raw).toLowerCase()] || null;
}

/** "Jun 1, 2024" -> "2024-06-01" (null when unparseable). */
function parseSiteDate(raw) {
  const m = clean(raw).match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

function reviewsUrl(id, slug = 'show') {
  return `${BASE}/${slug}/reviews/${id}/`;
}

function detailUrl(id, slug) {
  return `${BASE}/${slug}/${id}/`;
}

function absUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return BASE + href;
  return null;
}

/**
 * Current list. Returns [{ id, slug, title, venue, reviewCount, reviews:[{outlet, verdict}] }].
 */
function parseListing(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.review-item').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.review-item-title > a').first();
    const m = (a.attr('href') || '').match(/^\/([^/]+)\/reviews\/(\d+)\/?$/);
    if (!m) return;
    const title = clean(a.text());
    const reviews = [];
    $el.find('.review-hover p.pub').each((__, p) => {
      const $p = $(p);
      const outlet = clean($p.find('b').first().text()).replace(/\s*-\s*$/, '');
      const verdict = normalizeVerdict($p.clone().children().remove().end().text());
      if (outlet) reviews.push({ outlet, verdict });
    });
    const countMatch = clean($el.find('.review-num').first().text()).match(/(\d+)/);
    // Venue is the loose text node after .review-item-title inside .rating-left.
    const venue = clean(
      $el.find('.rating-left').first().clone().children().remove().end().text()
    );
    out.push({
      id: Number(m[2]),
      slug: m[1],
      title,
      venue,
      reviewCount: countMatch ? Number(countMatch[1]) : reviews.length,
      reviews,
    });
  });
  return out;
}

/**
 * Reviews page for one id. `empty:true` when the id has no production.
 */
function parseReviewsPage(html, id = null) {
  const $ = cheerio.load(html);
  const title = clean($('.single-review .post-content h3.section-title a').first().text());
  const reviews = [];
  $('.reviews div.review').each((_, el) => {
    const $r = $(el);
    const outlet = clean($r.find('.pub .bodyBold').first().text()).replace(/\s*-\s*$/, '');
    const verdictRaw = clean($r.find('p.pub').first().clone().children().remove().end().text());
    const excerpt = clean($r.find('p.review').first().text()).replace(/^["“]\s*/, '').replace(/\s*["”]$/, '');
    const link = $r.find('.review-bottom a').first().attr('href') || null;
    const critic = clean($r.find('.review-author').first().text()).replace(/^-\s*/, '');
    if (!outlet) return;
    reviews.push({
      outlet,
      critic: critic || null,
      verdict: normalizeVerdict(verdictRaw),
      excerpt,
      url: absUrl(link),
    });
  });
  if (!title) return { id, empty: true, title: '', reviews: [] };

  const slugMatch = ($('.single-review a.detailhead').first().attr('href') || '').match(/^\/([^/]+)\/(\d+)\/?$/);
  const poster = $('.single-review img#img-review').attr('src') || $('.single-review img').first().attr('src') || null;
  const venue = clean($('.single-review .main-review span').first().text());
  const thruText = clean($('.single-review .main-review small').first().text());
  return {
    id: slugMatch ? Number(slugMatch[2]) : id,
    slug: slugMatch ? slugMatch[1] : null,
    empty: false,
    title,
    venue,
    poster: poster && !/placeholder|noimage/i.test(poster) ? poster : null,
    thruText,
    closingDate: parseSiteDate(thruText),
    reviews,
  };
}

/** Detail page: show type, venue/address, description, run end. */
function parseDetailPage(html) {
  const $ = cheerio.load(html);
  const title = clean($('.post-title h2.section-title').first().text());
  if (!title) return { empty: true };
  const theatre = $('.theatre-name a').first();
  const addrText = clean($('.theatre-name').first().clone().children('span').remove().end().text());
  const typeStrong = $('.single-post-details strong').filter((_, e) => /Show Type/i.test($(e).text())).first();
  const showType = typeStrong.length ? clean(typeStrong[0].nextSibling && typeStrong[0].nextSibling.data) : null;
  const dateText = clean($('.play-date').first().text());
  return {
    empty: false,
    title,
    venue: clean(theatre.text()), // venue-write-guard-ok: parser output, not a shows.json write
    venuePath: theatre.attr('href') || null,
    address: addrText,
    description: clean($('.post-description').first().text()),
    showType: showType || null,
    dateText,
    closingDate: parseSiteDate(dateText),
    poster: $('.playdetail-mobile-img img').first().attr('src') || null,
  };
}

// Show types that are not scripted theatre with critic coverage we want.
const EXCLUDED_TYPES = [/cabaret/i, /magic/i, /^comedy$/i, /stand.?up/i, /improv/i, /sketch/i, /performance art/i, /variety/i, /concert/i, /dance/i, /children|family/i, /burlesque/i, /circus/i, /puppet/i, /film|cinema/i];

function isExcludedType(showType) {
  if (!showType) return false;
  return EXCLUDED_TYPES.some((re) => re.test(showType));
}

/** Map the site's Show Type to our show.type ('musical' | 'play'). */
function mapShowType(showType) {
  if (/musical|opera|revue/i.test(showType || '')) return 'musical';
  return 'play';
}

module.exports = {
  BASE,
  parseListing,
  parseReviewsPage,
  parseDetailPage,
  parseSiteDate,
  normalizeVerdict,
  isExcludedType,
  mapShowType,
  reviewsUrl,
  detailUrl,
};
