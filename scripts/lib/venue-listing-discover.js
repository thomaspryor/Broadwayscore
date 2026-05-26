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
// OB VENUE CONFIGS (V-T2)
// ============================================================
// URLs + selectors verified 2026-05-24 by Playwright subagent.
// Adding/changing a venue: probe it, capture HTML fixture, write a
// per-venue test (tests/unit/venue-extract-<name>.test.mjs) before
// shipping the config change.
//
// Exclusion patterns are intentionally generic (membership/donate/etc.)
// — site-specific banner copy gets caught by the strategy's scopeSelector
// AND the fixture test, not by adding venue-specific regexes here.

const COMMON_OB_EXCLUDE_PATTERNS = [
  /^membership$/i, /^donate$/i, /^donate now$/i, /^login$/i, /^cart$/i,
  /^sorry/i, /^help us/i, /^access your/i,
  /^contact/i, /^subscribe/i, /^newsletter/i,
  /^learn more$/i, /^read more$/i, /^buy tickets?$/i,
  /^our (mission|team|staff|board|space|values|history)/i,
  /education program/i, /reading series/i, /staged reading/i,
  /spring gala/i, /annual gala/i, /gala benefit/i,
  /^benefit\b/i, /annual benefit/i, /fundraiser/i,
];

const OB_VENUE_CONFIGS = [
  {
    name: 'Atlantic Theater',
    url: 'https://atlantictheater.org/productions/',
    strategy: 'link',
    linkPattern: /\/production\/[a-z0-9-]+\/?$/,
    // Atlantic puts the season as header nav items (Elementor menu). The
    // scope is intentionally the nav container; linkPattern with trailing
    // anchor excludes #book and #directions fragments.
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: 'Vineyard Theatre',
    // No `www` subdomain on this URL — / and /whats-on/ return different
    // pages. /showsevents/ is the canonical season-list page.
    url: 'https://vineyardtheatre.org/showsevents/',
    strategy: 'link',
    linkPattern: /\/shows\//,
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: true,
    category: 'off-broadway',
  },
  {
    name: 'Signature Theatre',
    url: 'https://signaturetheatre.org/productions/',
    strategy: 'selector',
    // .type-event includes both upcoming (5) and past (9). Upcoming-only
    // filtering happens in the fixture test via ancestor heading; for now
    // we accept all 14 and let the cross-validation gate (V-T6b) reject
    // past shows that don't appear in Playbill/Lortel current data.
    selector: '.type-event .wp-block-post-title',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: true,
    // networkidle times out at 45s on this page; must wait for the
    // first .type-event element to appear instead.
    playwrightWaitForSelector: '.type-event',
    category: 'off-broadway',
  },
  {
    name: 'MCC Theater',
    // TODO: this URL embeds the season year (2025-26). When MCC switches
    // to 2026-27 (typically mid-2026), update to /our-2026-27-season/.
    // The anomaly gate (V-T7) will fire when this rots → 0 shows from MCC.
    url: 'https://mcctheater.org/our-2025-26-season/',
    strategy: 'selector',
    selector: '.c-col-card .c-col-card__title',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    // The .c-col-card grid is JS-injected — static HTML has no titles. Need
    // Playwright to capture the rendered DOM.
    preferPlaywright: true,
    category: 'off-broadway',
  },
];

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
        // schema.org allows @type as either a string or an array of strings —
        // sites like LondonTheatre.co.uk emit `@type: ["Event","TheaterEvent"]`.
        // Without array handling we'd silently drop those events.
        const t = item['@type'];
        const isTheaterEvent = Array.isArray(t) ? t.includes('TheaterEvent') : t === 'TheaterEvent';
        if (isTheaterEvent && !item.subEvent) events.push(item);
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
  // NOTE: playwrightWaitForSelector is currently a no-op — fetchWithPlaywright
  // in scripts/lib/scraper.js does not yet consume this option. V-T3 (planned
  // next in sprint-plan-ob-venue-extraction.md) adds the consumer. Until then,
  // Signature relies on networkidle (which the subagent confirmed times out at
  // 45s). Signature will return 0 candidates until V-T3 ships.
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
  OB_VENUE_CONFIGS,
  COMMON_OB_EXCLUDE_PATTERNS,
  parseVenueListingHtml,
  scrapeVenueListing,
  extractByLink,
  extractBySelector,
  extractJsonLdTheaterEvents,
  writeStagingCandidates,
  loadStaging,
  candidateHash,
};
