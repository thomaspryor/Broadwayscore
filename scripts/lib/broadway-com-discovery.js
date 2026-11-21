'use strict';

const { isBotChallenge } = require('./broadway-com-rating-parser');

const LISTING_URL = 'https://www.broadway.com/shows/tickets/';
const SITEMAP_URL = 'https://www.broadway.com/sitemap-shows.xml';
const UTILITY_SLUGS = new Set(['shows', 'broadway-guide', 'discount-broadway-tickets', 'tickets', 'find-by-date']);
// Both endpoints normally contain dozens of shows. Fewer than five unique
// results warrants one retry, including full-size shells with a few nav links.
const MIN_DISCOVERED_SHOWS = 5;

function parseListingShows(html) {
  const shows = [];
  const linkPattern = /<a[^>]+href="\/shows\/([a-z0-9-]+)\/"[^>]*>([^<]+)<\/a>/gi;
  const seen = new Set();
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const slug = match[1];
    const title = match[2].trim()
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
    if (seen.has(slug) || UTILITY_SLUGS.has(slug)) continue;
    if (title.length < 2 || ['Shows', 'Tickets', 'Shows (tickets)'].includes(title)) continue;
    seen.add(slug);
    shows.push({ title, slug, url: `https://www.broadway.com/shows/${slug}/` });
  }
  return shows;
}

function parseSitemapSlugs(xml) {
  const slugs = new Set();
  // Only sitemap URL entries count, not show links in a degraded HTML shell.
  const entryPattern = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let entry;
  while ((entry = entryPattern.exec(xml)) !== null) {
    const match = entry[1].match(/<loc>\s*https?:\/\/(?:www\.)?broadway\.com\/shows\/([a-z0-9-]+)\/\s*<\/loc>/i);
    if (match && !UTILITY_SLUGS.has(match[1])) slugs.add(match[1]);
  }
  return [...slugs];
}

/** Fetch dependencies are supplied by the scraper, so tests exercise the same
 * discovery and fallback path without network calls or audience-data writes. */
async function discoverShows({ httpsGet, fetchPage, logger = console }) {
  logger.log('Fetching Broadway.com /shows/tickets/ listing...');
  const { status, data: html } = await httpsGet(LISTING_URL);
  if (status !== 200) throw new Error(`Broadway.com /shows/ returned ${status}`);

  let shows = parseListingShows(html);
  if (isBotChallenge(html) || shows.length < MIN_DISCOVERED_SHOWS) {
    logger.log(`  Listing yielded ${shows.length} shows, trying scraper fallback chain...`);
    const result = await fetchPage(LISTING_URL, { renderJs: true });
    const fallbackHtml = result?.content || '';
    const fallbackShows = isBotChallenge(fallbackHtml) ? [] : parseListingShows(fallbackHtml);
    // Keep valid direct results if the fallback is also partial.
    shows = [...new Map([...shows, ...fallbackShows].map(show => [show.slug, show])).values()];
    if (shows.length === 0) {
      throw new Error('Broadway.com /shows/ contained no shows and scraper fallback failed');
    }
  }
  logger.log(`  Discovered ${shows.length} shows on Broadway.com`);
  return shows;
}

async function discoverFromSitemap({ httpsGet, fetchPage, logger = console }) {
  logger.log('\nFetching Broadway.com sitemap for closed shows...');
  const { data: xml } = await httpsGet(SITEMAP_URL);
  let slugs = parseSitemapSlugs(xml);
  if (isBotChallenge(xml) || slugs.length < MIN_DISCOVERED_SHOWS) {
    logger.log(`  Sitemap yielded ${slugs.length} show URLs, trying shared fetchPage()...`);
    try {
      const result = await fetchPage(SITEMAP_URL, { renderJs: false });
      const fallbackXml = result?.content || '';
      if (!isBotChallenge(fallbackXml)) {
        slugs = [...new Set([...slugs, ...parseSitemapSlugs(fallbackXml)])];
      }
    } catch (e) {
      logger.log(`  fetchPage sitemap fetch failed: ${e.message}`);
    }
  }
  logger.log(`  Found ${slugs.length} show slugs in sitemap`);
  return slugs;
}

module.exports = { discoverShows, discoverFromSitemap, parseListingShows, parseSitemapSlugs };
