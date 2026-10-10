/**
 * WestEndTheatre.com roundup discovery + row extraction (WE/OWE).
 *
 * Extracted verbatim from opening-night-poller.js block 1g (2026-07-10) so the
 * same WP-API search + dual-format parsing is callable by both the poller and
 * the review-gap audit. Per the repo's per-source discovery-lib convention.
 *
 * Unlike LBO/TR (whose parsers live in scrape-* modules), WET's two parse
 * modes lived inline in the poller, so this lib owns BOTH discovery and
 * row extraction:
 *   - table format: star runs (★{1,5}) in the WP-API post content, outlet name
 *     taken from the preceding line (headers like "Publication/Rating" skipped)
 *   - section format: rendered page CSS classes .reviewnewpubhead /
 *     .reviewnewstars / .reviewnewauthor, plus the first external <a> href as
 *     the outlet's review URL
 *
 * Iterates the first 3 WP-API posts whose title matches the show (≥60% of
 * >2-char title words; both words for 1-2-word titles) and returns the FIRST
 * post that yields rows — same short-circuit the poller used.
 *
 * NOTE for consumers: rows may have url:'' (table format has no links). WET's
 * stars are the roundup's own rating relay; the poller stores them as
 * `wetStars` (never the outlet's score) — keep that policy.
 *
 * @param {object} show - shows.json record ({ id, title, ... })
 * @param {object} [opts]
 * @param {Function} [opts.fetchPage] Injected for tests
 * @param {Function} [opts.fetchJSON] Injected for tests
 * @param {Function} [opts.log]       Logger (default console.log)
 * @returns {Promise<{rows: Array<{outlet: string, stars: number, critic: string, url?: string}>, post: {id: number, link: string, date: string|null}}|null>}
 */

const cheerio = require('cheerio');
const { cleanSearchTitle } = require('./title-normalization');

const { foldDiacritics } = require('./title-match');

function decodeWpTitle(rendered) {
  return (rendered || '').replace(/&#8217;/g, "'").replace(/&#8211;/g, '–').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '');
}

function _normalizeForMatch(t) {
  return foldDiacritics(String(t || '')).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const _MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'are', 'was']);

// Words that appear in many unrelated show titles, so sharing one says nothing
// about identity. Counting them let "Beaches, A New Musical" match "Amelie, A
// New Musical", "King Charles III" match "King Richard III", and every
// "X - English National Opera" match every other ENO show (ship-check on #940,
// measured over all 3,061 show titles).
const _GENERIC_TITLE_WORDS = new Set([
  'new', 'musical', 'play', 'opera', 'national', 'english', 'york', 'london',
  'broadway', 'west', 'end', 'theatre', 'theater', 'show', 'live', 'tour',
  'part', 'one', 'two', 'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'you', 'can',
  'all', 'not', 'our', 'his', 'her', 'who', 'what', 'how', 'why', 'this', 'that',
]);

function _distinctiveWords(norm) {
  return Array.from(new Set(norm.split(' ')
    .filter(w => w.length > 2 && !_MATCH_STOPWORDS.has(w) && !_GENERIC_TITLE_WORDS.has(w))));
}

function _phraseIn(haystackNorm, phraseNorm) {
  const p = phraseNorm.replace(/^(the|a|an) /, '');
  if (!p) return false;
  // An "&"-led title normalizes to "and ...", which also sits inside another
  // title ("Romeo and Juliet" for "& Juliet"), so it must lead the haystack,
  // after an optional "review(s)" prefix.
  if (p.startsWith('and ')) {
    const lead = haystackNorm.replace(/^reviews? (of )?/, '');
    return lead === p || lead.startsWith(`${p} `);
  }
  return ` ${haystackNorm} `.includes(` ${p} `);
}

/**
 * Does a WestEndTheatre WP post title belong to this show?
 *
 * The old check was `wpTitle.includes(word)` over the show's >2-char words: a
 * SUBSTRING test that also counted duplicate words twice. "Man to Man" became
 * ["man","man"] and matched any title containing "man" anywhere, e.g. "Fences
 * Reviews: critics enjoyed Ray Fearon's performance" and "The Children
 * reviews ... woman". The Fences roundup's The Stage URL then replaced the
 * real Man to Man review URL (reader report, 2026-09-26), and 20 WET archives
 * were cached against the wrong show the same way.
 *
 * Rule now:
 *   - whole-word matching on DISTINCT tokens only;
 *   - titles with <= 2 distinctive tokens (where single-word collisions bite)
 *     must appear as a contiguous phrase;
 *   - longer titles need >= 60% of their distinct tokens as whole words;
 *   - generic title words (musical, new, opera, III, ...) never count as
 *     distinctive, and a one-word main title before a subtitle colon must lead
 *     the post title.
 */
function wetPostTitleMatchesShow(wpTitle, showTitle) {
  const wpNorm = _normalizeForMatch(wpTitle);
  const showNorm = _normalizeForMatch(showTitle);
  if (!wpNorm || !showNorm) return false;
  if (_phraseIn(wpNorm, showNorm)) return true;
  // Subtitled shows ("Orlando: A Pornobiography") are often posted under the
  // main title alone; the main title must still match as a whole phrase.
  // A one-word main title ("Stories", "Jack") is too generic to match anywhere
  // in the post title ("Collected Stories"), so it must LEAD the post title,
  // after an optional "Review:" prefix. mainNorm is [a-z0-9 ] only (see
  // _normalizeForMatch), so it is safe inside the RegExp below.
  const mainTitle = String(showTitle || '').split(/\s*[:–—]\s+/)[0];
  if (mainTitle && mainTitle !== showTitle) {
    const mainNorm = _normalizeForMatch(mainTitle).replace(/^(the|a|an) /, '');
    if (mainNorm && _distinctiveWords(mainNorm).length >= 2) {
      if (_phraseIn(wpNorm, mainNorm)) return true;
    } else if (mainNorm) {
      const lead = wpNorm.replace(/^reviews? /, '').replace(/^(the|a|an) /, '');
      // ...and be followed by the post's own framing, so "Jack and the
      // Beanstalk reviews" is not "Jack: A Night on the Town".
      if (lead === mainNorm || new RegExp(`^${mainNorm} (reviews?|at)( |$)`).test(lead)) return true;
    }
  }
  const wpTokens = new Set(wpNorm.split(' '));
  const showWords = _distinctiveWords(showNorm);
  if (showWords.length <= 2) return false; // short titles: phrase match only
  const matched = showWords.filter(w => wpTokens.has(w));
  return matched.length >= Math.ceil(showWords.length * 0.6);
}

async function discoverWetRoundupRows(show, opts = {}) {
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const fetchJSON = opts.fetchJSON || require('./scraper').fetchJSON;
  const log = opts.log || console.log;
  // opts.stats (optional, mutated): { titleMatchedPosts, apiPosts } — lets the
  // gap audit distinguish "no matching post" (fine) from "title-matched post but
  // 0 rows parsed" (WET template drift = detector failure that must ALARM).
  const stats = opts.stats || {};
  stats.apiPosts = 0;
  stats.titleMatchedPosts = 0;
  stats.fetchErrors = 0;

  const searchTitle = cleanSearchTitle(show.title);
  // Optional publish window (YYYY-MM-DD), for callers that know the run's
  // dates. Without it a same-title production from another year can win: the
  // 2025 Shaftesbury "Just For One Day" matched the 2023 Old Vic roundup
  // (BRO-4851). Live opening-night callers leave it unset.
  const window = (opts.after ? `&after=${opts.after}T00:00:00` : '') + (opts.before ? `&before=${opts.before}T00:00:00` : '');
  const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=20&search=${encodeURIComponent(searchTitle)}${window}`;

  // fetchJSON for proxy-routed WP API call (avoids TLS blocking in CI)
  let posts = [];
  try {
    posts = await fetchJSON(apiUrl);
    if (!Array.isArray(posts)) posts = [];
  } catch (e) {
    stats.fetchErrors++;
    log(`    WET API error: ${(e.message || '').substring(0, 60)}`);
  }

  if (!Array.isArray(posts) || posts.length === 0) return null;
  stats.apiPosts = posts.length;

  // Enforce the window on each post's own date too: in the pilot the API
  // still returned the 2023 roundup for a 2025 window (the after/before
  // params did not survive the fetchJSON proxy path).
  const inWindow = post => {
    const d = String(post.date || '').slice(0, 10);
    if (!d) return !(opts.after || opts.before);
    return (!opts.after || d >= opts.after) && (!opts.before || d <= opts.before);
  };
  for (const post of posts.filter(inWindow).slice(0, 3)) {
    // Validate post title matches our show (WP search can return wrong shows)
    const wpTitle = decodeWpTitle(post.title?.rendered);
    if (!wetPostTitleMatchesShow(wpTitle, searchTitle)) {
      log(`    ✗ WET title mismatch: "${wpTitle.slice(0, 60)}" doesn't match "${searchTitle}"`);
      continue;
    }

    stats.titleMatchedPosts++;
    const htmlContent = post.content?.rendered || '';
    let wetReviews = [];

    // Try table format first (API content)
    if (htmlContent.includes('★') || htmlContent.includes('<table')) {
      const text = htmlContent.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ');
      const starRegex = /(★{1,5})/g;
      let sMatch;
      while ((sMatch = starRegex.exec(text)) !== null) {
        const stars = sMatch[1].length;
        const before = text.substring(Math.max(0, sMatch.index - 200), sMatch.index).trim();
        const outletLine = before.split('\n').filter(l => l.trim()).pop()?.trim() || '';
        if (!outletLine || outletLine.length < 2 || outletLine.length > 50) continue;
        if (outletLine.startsWith('"') || outletLine.startsWith('“')) continue;
        // Skip table headers parsed as outlet names
        if (/publication|rating|critic/i.test(outletLine)) continue;
        wetReviews.push({ outlet: outletLine, stars, critic: 'Unknown' });
      }
    }

    // Fallback: fetch rendered page for section-format posts (CSS classes)
    if (wetReviews.length === 0 && post.link) {
      try {
        log(`    Fetching rendered page: ${post.link}`);
        const pageResult = await fetchPage(post.link, { renderJs: false });
        const pageHtml = pageResult?.content || null;
        if (pageHtml) wetReviews.push(...parseWetRenderedBlocks(pageHtml));
      } catch (e) {
        stats.fetchErrors++;
        log(`    WET page fetch error: ${(e.message || '').substring(0, 60)}`);
      }
    }

    if (wetReviews.length === 0) continue;

    return {
      rows: wetReviews,
      post: { id: post.id, link: post.link || '', date: post.date ? post.date.slice(0, 10) : null },
    };
  }

  return null;
}

/**
 * Rendered WET roundup page → one row per outlet block. A block is a
 * `.reviewnewpubhead` and its following siblings UP TO the next pubhead:
 * stars, author and the outlet's own review link are read only from inside
 * that block. The old unbounded `nextAll()` let a block with no byline or no
 * link take the NEXT outlet's critic or URL (BRO-4851; 13 of 41 WE pilot
 * reviews were left URL-less and some carried a neighbour's URL).
 */
function parseWetRenderedBlocks(pageHtml) {
  const $w = cheerio.load(pageHtml);
  const rows = [];
  $w('.reviewnewpubhead').each((_, el) => {
    const outlet = $w(el).text().trim();
    const block = $w(el).nextUntil('.reviewnewpubhead');
    const stars = (block.filter('.reviewnewstars').first().text().match(/★/g) || []).length;
    const authorText = block.filter('.reviewnewauthor').first().text().trim();
    const cm = authorText.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)/);
    // The outlet's own link is a sibling or sits in the byline; a link inside
    // the quote is cited text, not this review.
    const links = block.filter('a[href]').add(block.filter('.reviewnewauthor').find('a[href]'));
    let url = '';
    links.each((__, a) => {
      const href = $w(a).attr('href') || '';
      if (!url && href.startsWith('http') && !href.includes('westendtheatre.com')) url = href;
    });
    if (outlet && stars > 0) rows.push({ outlet, stars, critic: cm ? cm[1] : 'Unknown', url });
  });
  return rows;
}

module.exports = { discoverWetRoundupRows, wetPostTitleMatchesShow, decodeWpTitle, parseWetRenderedBlocks };
