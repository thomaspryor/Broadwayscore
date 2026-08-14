#!/usr/bin/env node
/**
 * validate-show-venue.js
 *
 * Cross-validate a show's venue + dates against Playbill's authoritative
 * production page. Catches stub entries where the venue or year are wrong
 * (e.g. a 2014 revival surfaced as a 2026 production by a venue-page scraper).
 *
 * Resolution chain per show:
 *   1. data/playbill-urls.json mapping (cached)
 *   2. SERP query "site:playbill.com production <title> <venue>"
 *      → filter results to /production/ paths
 *      → score by market match (off-broadway vs broadway slug)
 *
 * Comparison:
 *   - venue: canonicalVenue() from scripts/lib/title-match.js
 *   - openingDate: > 30-day delta = mismatch
 *   - opening-year: shows.json year vs Playbill URL year (last 4 digits of slug)
 *
 * Output: data/audit/venue-date-mismatches.json (full report each run).
 *
 * Modes:
 *   --show=ID              one show only
 *   --all-provisional      every entry with provisional:true OR
 *                          discoverySource matching ^manual|^venue-page
 *   --fail-on-mismatch     exit 1 + emit ::error:: lines per mismatch
 *   --dry-run              do not write audit file
 *   --limit=N              cap shows processed (debug aid)
 *   --data-dir=PATH        validate PATH/shows.json instead of the live
 *                          checkout's data/shows.json (autonomous loop
 *                          Tier-2 verification against a candidate branch)
 *
 * Usage:
 *   node scripts/validate-show-venue.js --show=sunset-baby-off-broadway-2026
 *   node scripts/validate-show-venue.js --all-provisional
 *   node scripts/validate-show-venue.js --all-provisional --fail-on-mismatch
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { canonicalVenue, normalizeTitle } = require('./lib/title-match');
const { venuesMatch } = require('./lib/deduplication');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
// --data-dir overrides ONLY the shows.json this run validates (Sprint 4,
// autonomous nightly loop): SHOWS_PATH is __dirname-relative, so without this
// flag a check invoked from ANY cwd — including a Tier-2 verification
// scratch dir wired to a candidate branch's worktree — would silently
// validate the live checkout's shows.json instead of the candidate diff.
// playbill-urls.json (read cache) and the audit report (output) are NOT part
// of what a card mutates, so they intentionally keep resolving to the real
// repo regardless of this flag.
const dataDirOverride = args.find(a => a.startsWith('--data-dir='))?.split('=').slice(1).join('=');
const SHOWS_PATH = dataDirOverride ? path.join(path.resolve(dataDirOverride), 'shows.json') : path.join(ROOT, 'data', 'shows.json');
const PLAYBILL_URLS_PATH = path.join(ROOT, 'data', 'playbill-urls.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'venue-date-mismatches.json');

const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const allProvisional = args.includes('--all-provisional');
const candidatesFile = args.find(a => a.startsWith('--candidates-file='))?.split('=')[1];
const failOnMismatch = args.includes('--fail-on-mismatch');
const dryRun = args.includes('--dry-run');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const verbose = args.includes('--verbose');

const DATE_DELTA_DAYS = 30;
const MONTH_MAP = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

function loadPlaybillUrlCache() {
  try { return JSON.parse(fs.readFileSync(PLAYBILL_URLS_PATH, 'utf8')); }
  catch { return { shows: {} }; }
}

function isProvisional(show) {
  const src = show.discoverySource || '';
  // Roundup-promoted REGIONAL shows are exempt: "the roundup IS the validation"
  // (user rule 2026-07-08, CLAUDE.md §3). Playbill validation false-positives on
  // them because Playbill's /production/ page for a same-title show is often the
  // Broadway transfer, not the regional run (little-bear-ridge-road-regional-2024:
  // Steppenwolf 2024 record vs Playbill's Booth 2025 transfer — main red 2026-07-10).
  if (show.category === 'regional' && src.startsWith('aggregator-roundup')) return false;
  // Free outdoor/park productions with no Playbill /production/ page at all
  // (not tracked by Playbill's commercial-production database) are exempt.
  // Without this, the SERP query in findPlaybillUrl() falls back to a
  // same-titled but unrelated production (e.g. two different "Othello"s in
  // the same year — a commercial Broadway revival WITH a Playbill page, and
  // a free Classical Theatre of Harlem outdoor run WITHOUT one) and reports
  // a false-positive venue/date mismatch. Requires a substantive
  // statusBackfillSource recording the independent cross-validation actually
  // done — the flag alone is not honored, so it can't become a silent
  // stub-from-memory bypass of CLAUDE.md §3 (second-opinion review, task
  // #814).
  if (show.noPlaybillProductionPage === true
      && typeof show.statusBackfillSource === 'string'
      && show.statusBackfillSource.length > 50) return false;
  if (show.provisional === true) return true;
  return src.startsWith('manual-user-request') || src.startsWith('venue-page');
}

function shortTitleSlug(title) {
  return String(title || '').toLowerCase()
    .replace(/[''""‘’“”]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Score a Playbill production URL against a show. Returns null when the URL
 * is not a plausible match for THIS title (prevents picking a different show
 * just because the SERP returned it).
 *
 * Hard filter: the slug between /production/ and the first market keyword
 * must equal the show's title slug. "des-moines-off-broadway-..." cannot
 * match "Ms. Blakk for President" no matter how high the other signals score.
 */
function scorePlaybillUrl(url, show) {
  const u = url.toLowerCase();
  const m = u.match(/\/production\/([a-z0-9-]+?)-(?:off-)?(?:broadway|regional|tour|west-end)-/);
  const titleSegment = m ? m[1] : null;
  const showSlug = shortTitleSlug(show.title);
  if (!titleSegment || !showSlug) return null;
  // Compare via canonical normalizer so "Urinetown" matches Playbill's
  // "urinetown-the-musical" (trailing " musical" / leading "the " stripped)
  // and accent variants align ("Les Misérables" ≡ "les-miserables").
  const norm = (s) => normalizeTitle(s.replace(/-/g, ' ')).replace(/\s+/g, '-');
  if (norm(titleSegment) !== norm(show.title)) return null;

  let s = 10; // title match earned
  const isOB = show.category === 'off-broadway';
  // Regional/tour URLs are never a fit for a NYC OB/Broadway entry — they
  // describe a different production (different venue, different cast).
  if ((u.includes('-regional-') || u.includes('-tour-')) && (isOB || !show.category)) return null;
  if (u.includes('-off-broadway-')) s += isOB ? 5 : -5;
  else if (u.includes('-broadway-')) s += isOB ? -5 : 5;
  const cv = canonicalVenue(show.venue || '');
  if (cv) {
    const cvSlug = cv.replace(/\s+/g, '-');
    if (u.includes(cvSlug)) s += 2;
  }
  const idYear = (show.id || '').match(/\d{4}/)?.[0];
  if (idYear && u.includes(idYear)) s += 1;
  return s;
}

async function findPlaybillUrl(show, log) {
  const cache = loadPlaybillUrlCache();
  if (cache.shows && cache.shows[show.id]) {
    return { url: cache.shows[show.id], source: 'cache' };
  }
  const market = show.category === 'off-broadway' ? 'Off-Broadway' : 'Broadway';
  const venueWord = (show.venue || '').split(/[\s\-,—\/]/)[0];
  const queries = [
    `site:playbill.com/production "${show.title}" ${market} ${venueWord}`,
    `site:playbill.com/production "${show.title}" ${venueWord}`,
    `site:playbill.com production "${show.title}" ${market}`,
  ];
  for (const q of queries) {
    let results = null;
    try { results = await serpQuery(q, { nbResults: 10 }); }
    catch (e) { log(`    serp error: ${e.message}`); continue; }
    if (!results || !results.length) continue;
    const candidates = results
      .filter(r => r.url && r.url.includes('playbill.com/production/'))
      .map(r => {
        const cleanUrl = r.url.replace(/[?#].*$/, '');
        return { url: cleanUrl, score: scorePlaybillUrl(cleanUrl, show) };
      })
      .filter(c => c.score !== null && c.score > 0)
      .sort((a, b) => b.score - a.score);
    if (candidates.length) {
      return { url: candidates[0].url, source: 'serp', score: candidates[0].score };
    }
    await sleep(800); // rate limit between SERP fallbacks
  }
  return { url: null, source: 'none' };
}

function parseTitleVenueYear(html) {
  // Page title pattern: "Title (Off-Broadway, Venue, YYYY) | Playbill"
  const tm = html.match(/<title>([^<]+)<\/title>/);
  if (!tm) return null;
  const t = tm[1].trim();
  const m = t.match(/^(.*?)\s*\(\s*(Broadway|Off-Broadway|Off-Off-Broadway|West End|Tour)\s*,\s*([^,]+?)\s*,\s*(\d{4})\s*\)/i);
  if (!m) return { rawTitle: t, market: null, venue: null, year: null };
  return { rawTitle: m[1].trim(), market: m[2], venue: m[3].trim(), year: parseInt(m[4], 10) };
}

function parseFactDates(html) {
  // Each fact block:
  //   <div class="bsp-list-promo-title">First Preview|Opening Date|Closing Date</div>
  //   ...
  //   <span class="info-circular-pre-text">Jan</span>
  //   <span class="info-circular-text">30</span>
  //   <span class="info-circular-post-text">2024</span>
  const out = { firstPreview: null, openingDate: null, closingDate: null };
  const re = /<div class="bsp-list-promo-title">([^<]+)<\/div>[\s\S]{0,1200}?<span class="info-circular-pre-text">\s*([A-Za-z]{3})\s*<\/span>\s*<span class="info-circular-text">\s*(\d{1,2})\s*<\/span>\s*<span class="info-circular-post-text">\s*(\d{4})\s*<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = m[1].toLowerCase().trim();
    const mon = MONTH_MAP[m[2].toLowerCase().slice(0, 3)];
    const day = m[3].padStart(2, '0');
    const yr = m[4];
    if (!mon) continue;
    const iso = `${yr}-${mon}-${day}`;
    if (label.includes('first preview')) out.firstPreview = iso;
    else if (label.includes('opening')) out.openingDate = iso;
    else if (label.includes('closing')) out.closingDate = iso;
  }
  return out;
}

function urlYear(url) {
  const m = url.match(/-(\d{4})(?:[\/?#]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round(Math.abs((db - da) / 86400000));
}

function compareShow(show, parsed, playbillUrl) {
  const mismatches = [];
  const showVenueCanon = canonicalVenue(show.venue || '');
  const pageVenueCanon = canonicalVenue(parsed.titleParse?.venue || '');
  // The actual mismatch decision uses venuesMatch(), not the showVenueCanon/
  // pageVenueCanon equality above (those two stay as display-only fields in
  // the audit record below) — canonicalVenue()'s fallback for a venue
  // outside VENUE_ALIASES is just the lowercased FIRST WORD, so two
  // genuinely different venues sharing a leading word ("The X") would
  // silently PASS this check as "not a mismatch" (BRO-243). That's the wrong
  // direction of error for a venue-mismatch DETECTOR — false negatives are
  // exactly what this script exists to catch.
  if (show.venue && parsed.titleParse?.venue && !venuesMatch(show.venue, parsed.titleParse.venue)) {
    mismatches.push({
      field: 'venue',
      shows: show.venue,
      showsCanonical: showVenueCanon,
      playbill: parsed.titleParse?.venue,
      playbillCanonical: pageVenueCanon,
    });
  }

  // Year: prefer URL year (always present); cross-check with title year.
  const pbYear = urlYear(playbillUrl) || parsed.titleParse?.year || null;
  const showYear = (() => {
    if (show.openingDate) return parseInt(show.openingDate.slice(0, 4), 10);
    const idy = (show.id || '').match(/\d{4}/);
    return idy ? parseInt(idy[0], 10) : null;
  })();
  if (pbYear && showYear && pbYear !== showYear) {
    mismatches.push({ field: 'opening-year', shows: showYear, playbill: pbYear });
  }

  // Date deltas (only when both ends are known).
  if (show.openingDate && parsed.dates?.openingDate) {
    const delta = daysBetween(show.openingDate, parsed.dates.openingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      mismatches.push({
        field: 'openingDate',
        shows: show.openingDate,
        playbill: parsed.dates.openingDate,
        deltaDays: delta,
      });
    }
  }
  if (show.closingDate && parsed.dates?.closingDate) {
    const delta = daysBetween(show.closingDate, parsed.dates.closingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      mismatches.push({
        field: 'closingDate',
        shows: show.closingDate,
        playbill: parsed.dates.closingDate,
        deltaDays: delta,
      });
    }
  }
  return mismatches;
}

async function validateOne(show, log) {
  log(`\n${show.id}  "${show.title}"  (${show.venue})`);
  const urlResult = await findPlaybillUrl(show, log);
  if (!urlResult.url) {
    log(`  ⚠ no Playbill URL found`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'no-playbill-url', urlSource: urlResult.source,
      mismatches: [], playbillUrl: null, parsed: null,
    };
  }
  log(`  url (${urlResult.source}): ${urlResult.url}`);

  let html = '';
  try {
    const r = await fetchPage(urlResult.url, { timeout: 30000 });
    html = r.html || r.content || '';
  } catch (e) {
    log(`  ⚠ fetch error: ${e.message}`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'fetch-error', error: e.message,
      mismatches: [], playbillUrl: urlResult.url, parsed: null,
    };
  }
  if (!html || html.length < 5000) {
    log(`  ⚠ short response (${html.length} bytes)`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'short-response', htmlBytes: html.length,
      mismatches: [], playbillUrl: urlResult.url, parsed: null,
    };
  }

  const titleParse = parseTitleVenueYear(html);
  const dates = parseFactDates(html);
  const parsed = { titleParse, dates };
  log(`  parsed venue: ${titleParse?.venue || '(none)'} | year ${titleParse?.year || '(none)'} | opening ${dates.openingDate || '(none)'}`);

  const mismatches = compareShow(show, parsed, urlResult.url);
  if (mismatches.length === 0) {
    log(`  ✓ match`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'match', playbillUrl: urlResult.url, parsed, mismatches: [],
    };
  }
  log(`  ✗ ${mismatches.length} mismatch(es):`);
  mismatches.forEach(m => log(`    - ${m.field}: shows=${m.shows ?? m.showsCanonical} playbill=${m.playbill ?? m.playbillCanonical}${m.deltaDays ? ` (Δ${m.deltaDays}d)` : ''}`));
  return {
    id: show.id, title: show.title, venue: show.venue,
    result: 'mismatch', playbillUrl: urlResult.url, parsed, mismatches,
  };
}

async function main() {
  let targets;
  if (candidatesFile) {
    // Validate candidates from an external JSON file (no shows.json entry
    // required). Used by discover-ob-historical.js to surface authoritative
    // Playbill dates before promotion.
    const data = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
    const list = Array.isArray(data) ? data : (data.candidates || []);
    targets = list.map(c => ({
      id: c.id || (c.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-off-broadway-pending',
      title: c.title,
      venue: c.venue,
      category: 'off-broadway',
      openingDate: c.openingDate || c.firstDateSeen || null,
      closingDate: c.closingDate || c.lastDateSeen || null,
    }));
  } else if (showFilter) {
    const shows = loadShows();
    targets = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (!targets.length) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(2);
    }
  } else if (allProvisional) {
    const shows = loadShows();
    targets = shows.filter(isProvisional);
  } else {
    console.error('Pass --show=ID, --all-provisional, or --candidates-file=PATH');
    process.exit(2);
  }
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`validate-show-venue: ${targets.length} target(s)`);
  if (dryRun) console.log('[DRY RUN — audit file not written]');

  const log = verbose || targets.length <= 5 ? console.log : () => {};
  const results = [];
  for (const show of targets) {
    const r = await validateOne(show, log);
    results.push(r);
    await sleep(400);
  }

  const mismatches = results.filter(r => r.result === 'mismatch');
  const errors = results.filter(r => ['fetch-error', 'short-response', 'no-playbill-url'].includes(r.result));
  const matches = results.filter(r => r.result === 'match');

  console.log('');
  console.log(`Summary: ${matches.length} match / ${mismatches.length} mismatch / ${errors.length} unresolved`);
  if (mismatches.length) {
    console.log('Mismatches:');
    for (const r of mismatches) {
      console.log(`  ${r.id}`);
      for (const m of r.mismatches) {
        console.log(`    - ${m.field}: shows=${JSON.stringify(m.shows ?? m.showsCanonical)} playbill=${JSON.stringify(m.playbill ?? m.playbillCanonical)}${m.deltaDays ? ` (Δ${m.deltaDays}d)` : ''}`);
      }
      console.log(`    pb: ${r.playbillUrl}`);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    const out = {
      generatedAt: new Date().toISOString(),
      filter: showFilter ? { show: showFilter } : { allProvisional: true, limit: limit || null },
      counts: { total: results.length, match: matches.length, mismatch: mismatches.length, unresolved: errors.length },
      results,
    };
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(out, null, 2));
    console.log(`Wrote audit: ${AUDIT_PATH}`);
  }

  if (failOnMismatch && mismatches.length) {
    for (const r of mismatches) {
      for (const m of r.mismatches) {
        console.log(`::error::${r.id}: ${m.field} shows=${m.shows ?? m.showsCanonical} playbill=${m.playbill ?? m.playbillCanonical}`);
      }
    }
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(2); });
