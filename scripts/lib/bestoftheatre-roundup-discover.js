/**
 * Best of Theatre review round-up discovery + parsing (WE/OWE), BRO-4956.
 *
 * bestoftheatre.co.uk publishes one round-up per London opening at
 * /blog/post/review-roundup-<title>-<venue>, listing every review it found
 * with a direct link, the reviewer and the star rating, including the small
 * outlets WestEndTheatre / theatre.reviews / LBO round-ups leave out. On the
 * week of 7-9 Oct 2026 it cited LondonTheatre1, Musical Theatre Review, Plays
 * International, West End Wilma, London Theatre Reviews, First Night Magazine
 * and North West End reviews that none of the other reference sources had,
 * and the gap audit never knew they were missing.
 *
 * Discovery: the site's news sitemap lists every round-up url with a lastmod.
 * A slug is matched to the show the same way lbo-roundup-discover.js does
 * (progressively drop trailing venue words, high-confidence title match only),
 * then the fetched page's <title> is validated against the show title.
 *
 * Markup (stable, hand-written): each review is
 *   <div class="review"><div class="rhead"><h4>Outlet</h4>
 *     <span class="stars"><span><span style="width: calc(4 * 20%);">
 *   <p class="by">Reviewer: Name</p> ... <a class="more" href="URL">
 * and paywalled ones sit in one "Also reviewed by:" paragraph as
 *   <a href="URL">Outlet</a> (Critic, four stars, "pull quote")
 */

const SITEMAP_URL = 'https://www.bestoftheatre.co.uk/news-sitemap.xml';
const WORD_STARS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
let _sitemapCache = null;

function _decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, '’').replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a round-up page into reference rows.
 * @param {string} html
 * @returns {Array<{outlet: string, critic: string|null, stars: number|null, url: string|null}>}
 */
function extractBestOfTheatreRows(html) {
  if (!html || typeof html !== 'string') return [];
  const rows = [];
  const blocks = html.split(/<div class="review">/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<div class="review">|<p><strong>Also reviewed by/i)[0];
    const outlet = _decode((block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) || [])[1]);
    if (!outlet) continue;
    const starM = block.match(/class="stars"[\s\S]{0,120}?calc\(\s*(\d(?:\.\d)?)\s*\*\s*20%\s*\)/i);
    const by = _decode((block.match(/<p class="by">([\s\S]*?)<\/p>/i) || [])[1]).replace(/^Reviewer:\s*/i, '');
    const url = (block.match(/<a class="more" href="([^"]+)"/i) || [])[1] || null;
    rows.push({ outlet, critic: by || null, stars: starM ? Number(starM[1]) : null, url });
  }
  const also = html.match(/<p><strong>Also reviewed by:?<\/strong>([\s\S]*?)<\/p>/i);
  if (also) {
    const re = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*\(([^)]*)\)/gi;
    let m;
    while ((m = re.exec(also[1]))) {
      const parts = _decode(m[3]).split(',').map((s) => s.trim());
      const starWord = (parts.find((p) => /\b(one|two|three|four|five)\s+stars?\b/i.test(p)) || '').match(/(one|two|three|four|five)/i);
      const critic = parts[0] && !/stars?|^"/i.test(parts[0]) ? parts[0] : null;
      rows.push({ outlet: _decode(m[2]), critic, stars: starWord ? WORD_STARS[starWord[1].toLowerCase()] : null, url: m[1] });
    }
  }
  return rows;
}

/** <loc>/<lastmod> pairs for round-up posts in the news sitemap. */
function roundupEntries(sitemapXml) {
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(sitemapXml || ''))) {
    const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1];
    if (!loc || !/\/blog\/post\/review-roundup-/i.test(loc)) continue;
    out.push({ url: loc, lastmod: (m[1].match(/<lastmod>\s*([^<\s]+)/i) || [])[1] || null });
  }
  return out;
}

function _phrase(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/&/g, ' ').replace(/\band\b/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

let _londonTitles = null;
function _londonTitleSlugs() {
  if (_londonTitles) return _londonTitles;
  try {
    const shows = require('../../data/shows.json').shows || [];
    _londonTitles = [...new Set(shows.filter((s) => ['west-end', 'off-west-end'].includes(s.category)).map((s) => _phrase(s.title)).filter(Boolean))];
  } catch { _londonTitles = []; }
  return _londonTitles;
}

/**
 * Does a round-up slug name this show? Title matched the lbo-roundup-discover.js
 * way (drop trailing venue words, high-confidence match), and refused when
 * another London title names MORE of the slug: "the-play-that-goes-wrong-duchess"
 * is not "The Play". A possessive credit may lead ("don-blacks-from-the-heart-
 * garrick-theatre"): a two-word name ending in s is also tried without it.
 * @param {string} url
 * @param {object} show
 * @param {string[]} [londonTitleSlugs] injected for tests
 */
function slugMatchesShow(url, show, londonTitleSlugs) {
  const { matchTitleToShow } = require('./show-matching');
  const words = url.split('/').pop().replace(/^review-roundup-/i, '').split('-').filter(Boolean);
  const leads = [0];
  if (words.length > 3 && /s$/.test(words[1])) leads.push(2);
  const others = (londonTitleSlugs || _londonTitleSlugs()).filter((t) => t !== _phrase(show.title));
  for (const lead of leads) {
    const rest = words.slice(lead).join('-');
    for (let drop = 0; drop < words.length - lead; drop++) {
      const kept = words.slice(lead, words.length - drop);
      const r = matchTitleToShow(kept.join(' '), [show], { market: 'west-end' });
      if (!(r && r.show && r.confidence === 'high')) continue;
      const keptLen = _phrase(kept.join(' ')).length;
      const longer = others.some((t) => t.length > keptLen && (`${_phrase(rest)}-`).startsWith(`${t}-`));
      return !longer;
    }
  }
  return false;
}

/**
 * @param {object} show shows.json record
 * @param {object} [opts] { fetchPage, log, stats }
 * @returns {Promise<{html: string, url: string, postDate: string|null}|null>}
 */
async function discoverBestOfTheatreRoundup(show, opts = {}) {
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const log = opts.log || console.log;
  const stats = opts.stats || {};
  stats.fetchErrors = 0;
  // One sitemap fetch per process run (the hourly audit asks for every show in
  // its window); an injected fetchPage (tests) always fetches.
  let xml = !opts.fetchPage && _sitemapCache && Date.now() - _sitemapCache.at < 30 * 60 * 1000 ? _sitemapCache.xml : null;
  if (!xml) {
    try { xml = (await fetchPage(SITEMAP_URL, { renderJs: false }))?.content || null; }
    catch (e) { stats.fetchErrors++; log(`    BoT sitemap error: ${(e.message || '').slice(0, 60)}`); }
    if (xml && !opts.fetchPage) _sitemapCache = { xml, at: Date.now() };
  }
  if (!xml) return null;
  const venueWords = String(show.venue || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !['theatre', 'theater', 'main', 'studio'].includes(w));
  const cands = roundupEntries(xml).filter((e) => slugMatchesShow(e.url, show));
  if (!cands.length) return null;
  // Same title at two houses (Into the Woods): the venue named in the slug wins, then the newest post.
  const venueHit = (e) => venueWords.some((w) => e.url.toLowerCase().includes(w));
  cands.sort((a, b) => (venueHit(b) - venueHit(a)) || String(b.lastmod).localeCompare(String(a.lastmod)));
  const pick = cands[0];
  let html = null;
  try { html = (await fetchPage(pick.url, { renderJs: false }))?.content || null; }
  catch (e) { stats.fetchErrors++; log(`    BoT page error: ${(e.message || '').slice(0, 60)}`); }
  if (!html) return null;
  const { validateRoundupPageTitle } = require('./show-matching');
  const v = validateRoundupPageTitle(html, show.title);
  if (!v.ok) {
    log(`    BoT: skipping ${pick.url} (${v.reason})`);
    return null;
  }
  const postDate = (html.match(/property="article:published_time" content="([^"]+)"/i) || [])[1] || pick.lastmod || null;
  return { html, url: pick.url, postDate };
}

module.exports = { discoverBestOfTheatreRoundup, extractBestOfTheatreRows, roundupEntries, slugMatchesShow };
