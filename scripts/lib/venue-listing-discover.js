'use strict';

/**
 * Off-Broadway venue listing discovery.
 *
 * Mirrors scripts/lib/playbill-ob-schedule.js. Sibling discovery source for
 * Off-Broadway non-profit subscription houses (Atlantic, Vineyard, Signature,
 * MCC) that don't list on TodayTix and aren't fully covered by Playbill's
 * OB schedule article.
 *
 * Functions exported:
 *   - parseVenueListingHtml(venue, html)   → [{title, venue, slug, source}]
 *   - scrapeVenueListing(venue)            → fetch + parse; also writes staging
 *   - extractByLink(doc, venue)            → strategy: scoped <a href> match
 *   - extractBySelector(doc, venue)        → strategy: scoped DOM selector
 *   - extractJsonLdTheaterEvents(doc)      → reusable JSON-LD helper
 *   - OB_VENUE_CONFIGS                     → the 4 OB non-profits (added in V-T2)
 *   - writeStagingCandidate(...)           → atomic staging-file write (V-T5)
 *
 * Design notes:
 *   - Exclusion as DATA (regex[]) not lambdas. Configs are JSON-serializable
 *     for fixture replay. See feedback_test_extraction_pattern.md.
 *   - Strategies are named functions. Config row picks one via {strategy: 'link'|'selector'}.
 *   - JSON-LD helper is a one-screen utility that any future venue can call.
 *
 * Cross-validation note: scrapeVenueListing does NOT promote candidates to
 * shows.json. It writes them to data/audit/ob-venue-candidates.json. A
 * separate script (scripts/promote-ob-venue-candidates.js, V-T6b) handles
 * cross-validation against Playbill OB / Lortel before promotion.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fetchPage } = require('./scraper');

const STAGING_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'ob-venue-candidates.json');

// ============================================================
// PURE PARSING
// ============================================================

/**
 * Parse a venue listing page's HTML into candidate objects.
 * Pure: no fetch, no IO. Fixture-testable.
 */
function parseVenueListingHtml(venue, html) {
  if (!html || html.length < 50) return [];
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let titles;
  switch (venue.strategy) {
    case 'link':
      titles = extractByLink(doc, venue);
      break;
    case 'selector':
      titles = extractBySelector(doc, venue);
      break;
    case 'json-ld':
      titles = extractJsonLdTheaterEvents(doc).map(e => e.name).filter(Boolean);
      break;
    default:
      throw new Error(`Unknown venue.strategy: ${venue.strategy} for ${venue.name}`);
  }

  // Apply exclusion patterns (DATA not functions) + length bounds.
  const excludePatterns = venue.excludeTitlePatterns || [];
  const filtered = titles
    .map(t => (t || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 2 && t.length <= 160)
    .filter(t => !excludePatterns.some(p => p.test(t)))
    .filter((t, i, arr) => arr.indexOf(t) === i); // dedupe within page

  return filtered.map(title => ({
    title,
    venue: venue.name,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    category: venue.category || 'off-broadway',
    source: `venue-page:${venue.name.toLowerCase().replace(/\s+/g, '-')}`,
    discoveredAt: new Date().toISOString(),
  }));
}

// ============================================================
// STRATEGIES
// ============================================================

/**
 * Strategy 'link': find anchors whose href matches venue.linkPattern.
 * Title comes from the URL slug (kept simple; OWE venues already use this).
 * If venue.scopeSelector is set, search only within that container — prevents
 * sitewide-selector leak (e.g., footer nav anchors).
 */
function extractByLink(doc, venue) {
  if (!venue.linkPattern) throw new Error(`extractByLink: venue ${venue.name} missing linkPattern`);
  const root = venue.scopeSelector ? doc.querySelector(venue.scopeSelector) : doc;
  if (!root) return []; // scope not found → empty (likely 404 / page rot)

  const seen = new Set();
  const titles = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!venue.linkPattern.test(href)) continue;
    // Skip navigation/category pages
    if (/\/(past-shows|access|account|login|logout|search|tag|category|page\/)/i.test(href)) continue;
    // Derive title from slug
    const slug = href.split('#')[0].split('?')[0].split('/').filter(Boolean).pop() || '';
    if (!slug || slug.length < 3) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Capitalize: "indian-princesses" → "Indian Princesses"
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    titles.push(title);
  }
  return titles;
}

/**
 * Strategy 'selector': find elements via venue.selector, take textContent.
 * If venue.scopeSelector is set, restrict to that container.
 */
function extractBySelector(doc, venue) {
  if (!venue.selector) throw new Error(`extractBySelector: venue ${venue.name} missing selector`);
  const root = venue.scopeSelector ? doc.querySelector(venue.scopeSelector) : doc;
  if (!root) return [];

  const titles = [];
  for (const el of root.querySelectorAll(venue.selector)) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) titles.push(t);
  }
  return titles;
}

/**
 * Reusable JSON-LD TheaterEvent extractor. Returns the raw parsed objects
 * with @type === 'TheaterEvent'. Caller picks fields (name/startDate/location).
 * Future venues with structured data should prefer this over selector hacks.
 */
function extractJsonLdTheaterEvents(doc) {
  const events = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item['@type'] === 'TheaterEvent' && !item.subEvent) events.push(item);
      }
    } catch { /* malformed JSON-LD blocks are skipped */ }
  }
  return events;
}

// ============================================================
// FETCH + PARSE + STAGING WRAPPER
// ============================================================

/**
 * Fetch the venue page (Playwright if preferPlaywright), parse, return
 * candidates. Does NOT write to staging by itself — caller decides.
 */
async function scrapeVenueListing(venue) {
  const opts = {};
  if (venue.preferPlaywright) opts.preferPlaywright = true;
  if (venue.playwrightWaitForSelector) opts.playwrightWaitForSelector = venue.playwrightWaitForSelector;

  const result = await fetchPage(venue.url, opts);
  const html = result?.content || '';
  if (!html) {
    console.warn(`::warning::venue ${venue.name}: fetch returned empty content (${venue.url})`);
    return [];
  }

  const candidates = parseVenueListingHtml(venue, html);
  return candidates;
}

// ============================================================
// STAGING (V-T5 — atomic candidate file)
// ============================================================

const crypto = require('crypto');

function candidateHash({ title, venue }) {
  const norm = `${(title || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function loadStaging() {
  try {
    const text = fs.readFileSync(STAGING_PATH, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/**
 * Atomic write — tmp file + rename. Prevents half-written staging on crash.
 */
function writeStaging(entries) {
  fs.mkdirSync(path.dirname(STAGING_PATH), { recursive: true });
  const tmp = STAGING_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, STAGING_PATH);
}

/**
 * Insert-or-update candidates by hash. Existing entries with the same hash
 * are replaced (refreshes discoveredAt + evidence); new ones are appended.
 */
function writeStagingCandidates(newCandidates) {
  const existing = loadStaging();
  const byHash = new Map(existing.map(e => [e.candidateHash, e]));
  for (const c of newCandidates) {
    const h = candidateHash(c);
    byHash.set(h, { ...c, candidateHash: h });
  }
  writeStaging([...byHash.values()]);
}

module.exports = {
  STAGING_PATH,
  parseVenueListingHtml,
  scrapeVenueListing,
  extractByLink,
  extractBySelector,
  extractJsonLdTheaterEvents,
  writeStagingCandidates,
  loadStaging,
  candidateHash,
};
