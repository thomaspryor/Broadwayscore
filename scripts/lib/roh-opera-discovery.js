/**
 * roh-opera-discovery.js (BRO-6766)
 *
 * Pure parsing for Royal Opera House (Royal Ballet and Opera, Covent Garden)
 * discovery. Scope is NEW productions and premieres only: revivals at ROH are
 * out of scope (owner decision 2026-11-01). Network fetches live in
 * discover-opera-shows.js; everything here takes HTML in and returns data out.
 *
 * Source: https://www.rbo.org.uk/tickets-and-events (server-rendered list of
 * /production/<slug> links) and each production page (meta description +
 * JSON-LD performances with "startDate").
 */
'use strict';

const ROH_VENUE = 'Royal Opera House';
const ROH_ADDRESS = 'Bow Street, London WC2E 9DD';
const ROH_BASE = 'https://www.rbo.org.uk';

// Listing slugs that are never a staged production.
const SKIP_SLUG_RE = /rehears|cinema|live-from|tour-|workshop|talk|open-day|friends-|insight|gala|concert|recital/i;
const NEW_PRODUCTION_RE = /new production|world premi[eè]re|royal opera premi[eè]re|house premi[eè]re|first staging/i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;#39;|&#x27;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Non-numeric /production/<slug> links from the listing page, de-duplicated. */
function extractProductionSlugs(listingHtml) {
  const out = new Set();
  const re = /\/production\/([a-z0-9][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(listingHtml || '')) !== null) {
    const slug = m[1];
    if (/^\d+$/.test(slug) || SKIP_SLUG_RE.test(slug)) continue;
    out.add(slug);
  }
  return [...out];
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = (html || '').match(re) || (html || '').match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Title without the " | Royal Ballet and Opera" style site suffix. */
function cleanTitle(raw) {
  return decodeEntities(raw)
    .replace(/\s*[|–—-]\s*(Royal Ballet and Opera|Royal Opera House|ROH|RBO).*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

/** Distinct ISO dates (YYYY-MM-DD) from JSON-LD "startDate" fields, sorted. */
function extractPerformanceDates(html) {
  const dates = new Set();
  const re = /"startDate"\s*:\s*"(\d{4}-\d{2}-\d{2})/g;
  let m;
  while ((m = re.exec(html || '')) !== null) dates.add(m[1]);
  return [...dates].sort();
}

/**
 * Parse one production page.
 * Returns { slug, title, isOpera, isNewProduction, openingDate, closingDate,
 *           performanceCount, description } (dates null when none found).
 * isOpera: the page's own description names The Royal Opera (not The Royal Ballet).
 */
function parseRohProduction(html, slug) {
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  const h1 = (html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanTitle(h1 ? h1[1].replace(/<[^>]+>/g, ' ') : metaContent(html, 'og:title'));
  const dates = extractPerformanceDates(html);
  const opera = /the royal opera\b/i.test(description) && !/the royal ballet\b/i.test(description);
  return {
    slug,
    title,
    description,
    isOpera: opera,
    isNewProduction: NEW_PRODUCTION_RE.test(description),
    openingDate: dates[0] || null,
    closingDate: dates.length ? dates[dates.length - 1] : null,
    performanceCount: dates.length,
  };
}

function slugify(title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function deriveStatus(openingDate, closingDate, today = new Date().toISOString().slice(0, 10)) {
  if (closingDate && closingDate < today) return 'closed';
  if (openingDate && openingDate > today) return 'upcoming';
  return 'open';
}

/**
 * Build the shows.json entry for an ROH production. Category off-west-end /
 * market west-end matches the existing A Masked Ball row; always provisional.
 */
function buildRohShowEntry(prod, today) {
  const year = prod.openingDate.slice(0, 4);
  const base = slugify(prod.title);
  const id = `${base}-off-west-end-${year}`;
  const status = deriveStatus(prod.openingDate, prod.closingDate, today);
  return {
    id,
    idPrefix: `${base}-off-west-end`,
    entry: {
      id,
      title: prod.title,
      slug: id,
      venue: ROH_VENUE,
      openingDate: prod.openingDate,
      closingDate: prod.closingDate,
      previewsStartDate: prod.openingDate,
      status,
      type: 'opera',
      isRevival: false,
      category: 'off-west-end',
      market: 'west-end',
      tags: status === 'closed' ? [] : ['upcoming'],
      synopsis: prod.description || '',
      openingDateSource: 'rbo.org.uk',
      discoverySource: 'venue-page:rbo.org.uk',
      provisional: true,
      theaterAddress: ROH_ADDRESS,
      ticketLinks: [],
      cast: [],
      creativeTeam: [],
      statusSource: `BRO-6766 weekly ROH discovery: ${ROH_BASE}/production/${prod.slug}`,
      evidenceUrls: [`${ROH_BASE}/production/${prod.slug}`],
    },
  };
}

module.exports = {
  ROH_VENUE, ROH_BASE, extractProductionSlugs, parseRohProduction,
  extractPerformanceDates, buildRohShowEntry, deriveStatus, slugify, cleanTitle,
};
