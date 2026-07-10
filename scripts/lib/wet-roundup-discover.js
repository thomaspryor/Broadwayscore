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
  const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=20&search=${encodeURIComponent(searchTitle)}`;

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

  for (const post of posts.slice(0, 3)) {
    // Validate post title matches our show (WP search can return wrong shows)
    const wpTitle = (post.title?.rendered || '').replace(/&#8217;/g, "'").replace(/&#8211;/g, '–').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '');
    const normalizeForMatch = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const wpNorm = normalizeForMatch(wpTitle);
    const showNorm = normalizeForMatch(searchTitle);
    const showWords = showNorm.split(' ').filter(w => w.length > 2);
    const matchedWords = showWords.filter(w => wpNorm.includes(w));
    const minMatch = showWords.length <= 2 ? showWords.length : Math.ceil(showWords.length * 0.6);
    if (matchedWords.length < minMatch) {
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
        if (pageHtml) {
          const $w = cheerio.load(pageHtml);
          $w('.reviewnewpubhead').each((_, el) => {
            const outlet = $w(el).text().trim();
            const stars = ($w(el).next('.reviewnewstars').text().match(/★/g) || []).length;
            const authorText = $w(el).nextAll('.reviewnewauthor').first().text().trim();
            const cm = authorText.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)/);
            // Extract individual review URL from the <a> after this review block
            let reviewUrl = '';
            $w(el).nextAll('a').each((_, a) => {
              const href = $w(a).attr('href') || '';
              if (!reviewUrl && href.startsWith('http') && !href.includes('westendtheatre.com')) {
                reviewUrl = href;
              }
            });
            if (outlet && stars > 0) {
              wetReviews.push({ outlet, stars, critic: cm ? cm[1] : 'Unknown', url: reviewUrl });
            }
          });
        }
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

module.exports = { discoverWetRoundupRows };
