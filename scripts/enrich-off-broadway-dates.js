#!/usr/bin/env node
/**
 * Off-Broadway Date Enrichment Script
 *
 * Sibling of scripts/enrich-west-end-dates.js. Same shape, OB-specific sources.
 *
 * Why this exists:
 *   IBDB (our default date source for new shows added by update-show-status.yml)
 *   conflates first-preview date with opening date for off-Broadway productions.
 *   23 of 30 recent open OB shows had openingDate === previewsStartDate as a
 *   result. The opening-night-orchestrator's 2-day lookback window then
 *   silently skipped real press nights weeks later. KENREX 2026-04-26 lost
 *   ~7 critic reviews this way before manual recovery.
 *
 *   See memory/feedback_off_broadway_opening_date_gap.md.
 *
 * Sources:
 *   1. Playbill "Schedule of Upcoming Off-Broadway Shows" article (primary).
 *      The article lists First Preview / Opens / Closes for each show, parsed
 *      via the same shape as the WE script's Playbill London handling.
 *   2. Lortel.org currently-playing page (secondary, only for shows at the
 *      Lucille Lortel Theatre — these have authoritative dates from the venue).
 *
 *   Two-source agreement = high-confidence auto-mutation.
 *   Single-source = audit-only entry (no shows.json write).
 *
 * Usage:
 *   node scripts/enrich-off-broadway-dates.js [options]
 *
 * Options:
 *   --dry-run            Report changes without writing shows.json
 *   --show=ID            Only process a specific show by id or slug
 *   --verify             Compare dates vs shows.json (no writes, no API calls
 *                        beyond fetch — same as a forced dry-run)
 *   --force              Overwrite existing dates even when source is trusted
 *   --fix-unconfirmed    Process shows with unconfirmed openingDateSource
 *                        (todaytix, showscore, unknown, ibdb-for-OB) — daily cron
 *   --initial-backfill   Bypass the change-stability guard once (first run only)
 *
 * Audit output: data/audit/date-enrichment-corrections.json (per-script entries
 * appended each run; uniform schema across WE + OB scripts).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { fetchPage } = require('./lib/scraper');
const { matchTitleToShow } = require('./lib/show-matching');
const { isUnconfirmedDateSource } = require('./lib/date-source-confidence');
const { validateChangeStability } = require('./lib/change-stability-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PLAYBILL_OB_URL = 'https://playbill.com/article/schedule-of-upcoming-off-broadway-shows-2';
const LORTEL_URL = 'https://lortel.org/currently-playing/';
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'date-enrichment-corrections.json');
const ABORT_SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'audit', 'enrich-off-broadway-dates-aborted.json');

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const force = args.includes('--force');
const fixUnconfirmed = args.includes('--fix-unconfirmed');
const initialBackfill = args.includes('--initial-backfill');
const missingOnly = !force && !fixUnconfirmed;
const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;

// =========================================================
// PARSE HELPERS
// =========================================================

/**
 * Parse a date like "April 26, 2026" or "Apr 26" → ISO yyyy-mm-dd. Returns
 * null on parse failure.
 */
function parseUSDate(text, defaultYear) {
  if (!text) return null;
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = m[2].padStart(2, '0');
  const year = m[3] || String(defaultYear || new Date().getFullYear());
  if (!month) return null;
  const y = parseInt(year, 10);
  if (y < 2020 || y > 2030) return null; // sanity-bound
  return `${year}-${month}-${day}`;
}

/**
 * Page-content validation: refuse to extract dates from a response whose
 * <title> doesn't match the expected page. Catches Cloudflare challenge
 * pages, soft 404s, and Show-Score-style upgrade banners that return 200
 * but render no real content.
 */
function validatePageTitle(html, expectedTitleSubstring) {
  if (!html) return false;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return false;
  return m[1].toLowerCase().includes(expectedTitleSubstring.toLowerCase());
}

// =========================================================
// SOURCE 1: PLAYBILL OFF-BROADWAY SCHEDULE
// =========================================================

/**
 * Parse Playbill's OB schedule article into entries:
 *   [{ title, firstPreview, opening, source: 'playbill' }, ...]
 *
 * The article structure: each show is a paragraph or list-item containing
 * the show title (often in <strong> or <a>) followed by lines like
 * "First Preview: April 16, 2026" / "Opens: April 26, 2026".
 */
function parsePlaybillOBSchedule(html) {
  if (!validatePageTitle(html, 'Off-Broadway')) {
    console.warn('  WARNING: Playbill OB schedule page title did not match — refusing to parse');
    return [];
  }

  // Playbill's OB schedule article structure:
  //   <strong><a href="...">SHOW TITLE</a></strong><br>
  //   • Venue Name<br>
  //   • First Preview: April 15, 2026<br>
  //   • Opening: April 26, 2026<br>
  //   ... (more bullet lines)
  //   <strong><a href="...">NEXT SHOW TITLE</a></strong><br>
  //
  // The whole show block lives inside one <p>, with <br>-separated lines.
  // Splitting on the <strong>...<a>TITLE</a>...</strong> marker lets us
  // chunk the document into per-show segments.
  const titleRe = /<strong>\s*<a[^>]*>([^<]{2,160})<\/a>\s*<\/strong>/g;
  const titleMatches = [];
  let tm;
  while ((tm = titleRe.exec(html)) !== null) {
    titleMatches.push({ title: tm[1].trim(), index: tm.index });
  }
  const entries = [];
  for (let i = 0; i < titleMatches.length; i++) {
    const { title, index } = titleMatches[i];
    const nextIndex = titleMatches[i + 1]?.index ?? Math.min(index + 5000, html.length);
    const segment = html.slice(index, nextIndex);
    // Strip tags to plain text for the date lines.
    const plain = segment.replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<[^>]+>/g, ' ');
    const fpMatch = plain.match(/First Preview[s]?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    const openMatch = plain.match(/Open(?:s|ing)?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) continue;
    entries.push({
      title,
      firstPreview: fpMatch ? parseUSDate(fpMatch[1]) : null,
      opening: openMatch ? parseUSDate(openMatch[1]) : null,
      source: 'playbill',
    });
  }
  return entries.filter(e => e.firstPreview || e.opening);
}

async function scrapePlaybillOB() {
  console.log('--- PLAYBILL OFF-BROADWAY SCHEDULE ---');
  console.log(`Fetching: ${PLAYBILL_OB_URL}`);
  const result = await fetchPage(PLAYBILL_OB_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch Playbill OB schedule');
    return [];
  }
  const entries = parsePlaybillOBSchedule(html);
  console.log(`Parsed ${entries.length} show entries from Playbill`);
  if (entries.length === 0 && html.length > 5000) {
    console.error('⚠️  WARNING: Playbill page loaded but 0 entries parsed — HTML structure may have changed');
  }
  return entries;
}

// =========================================================
// SOURCE 2: LORTEL.ORG CURRENTLY-PLAYING
// =========================================================

/**
 * Parse lortel.org/currently-playing/ — Lortel publishes their own shows'
 * dates authoritatively. Shape:
 *   <div class="show-card">
 *     <h3>{title}</h3>
 *     <p>{First Preview: ...}</p>
 *     <p>{Opening Night: ...}</p>
 *   </div>
 * (Approximation — selectors validated at test-time.)
 */
function parseLortelCurrentlyPlaying(html) {
  if (!validatePageTitle(html, 'Lortel')) {
    console.warn('  WARNING: Lortel page title did not match — refusing to parse');
    return [];
  }
  const $ = cheerio.load(html);
  const entries = [];
  // Lortel's currently-playing section uses semantic markup but the exact
  // selector has shifted historically. Walk all blocks and look for
  // title + date pairs. Restrict to text-near-keyword matches.
  $('h2, h3, h4').each((_, el) => {
    const titleEl = $(el);
    const title = titleEl.text().trim();
    if (!title || title.length > 120) return;
    // Search the next ~500 chars for First Preview / Opening Night markers.
    const block = titleEl.parent();
    const blockText = block.text().slice(0, 1500);
    const fpMatch = blockText.match(/First\s+Preview[s]?:?\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    const openMatch = blockText.match(/Opening\s+Night:?\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) return;
    entries.push({
      title,
      firstPreview: fpMatch ? parseUSDate(fpMatch[1]) : null,
      opening: openMatch ? parseUSDate(openMatch[1]) : null,
      source: 'lortel',
    });
  });
  return entries.filter(e => e.firstPreview || e.opening);
}

async function scrapeLortel() {
  console.log('--- LORTEL.ORG CURRENTLY PLAYING ---');
  console.log(`Fetching: ${LORTEL_URL}`);
  const result = await fetchPage(LORTEL_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch lortel.org');
    return [];
  }
  const entries = parseLortelCurrentlyPlaying(html);
  console.log(`Parsed ${entries.length} show entries from Lortel`);
  return entries;
}

// =========================================================
// MERGE + APPLY
// =========================================================

/**
 * Two-source agreement merge. For each (title-matched) show:
 *   - If both sources have a date that agrees within ±1 day → high confidence.
 *   - If exactly one source has the date → low confidence, audit-only.
 *   - If sources disagree → low confidence, audit-only with discrepancy note.
 */
function mergeSources(playbill, lortel) {
  // Index by lowercased-title for matching.
  const byTitle = new Map();
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  for (const e of playbill) {
    const k = norm(e.title);
    if (!byTitle.has(k)) byTitle.set(k, { titles: new Set([e.title]), playbill: e, lortel: null });
    else {
      byTitle.get(k).titles.add(e.title);
      byTitle.get(k).playbill = e;
    }
  }
  for (const e of lortel) {
    const k = norm(e.title);
    if (!byTitle.has(k)) byTitle.set(k, { titles: new Set([e.title]), playbill: null, lortel: e });
    else {
      byTitle.get(k).titles.add(e.title);
      byTitle.get(k).lortel = e;
    }
  }
  const merged = [];
  for (const { titles, playbill: pb, lortel: lt } of byTitle.values()) {
    const title = [...titles][0];
    const fpPb = pb?.firstPreview;
    const fpLt = lt?.firstPreview;
    const opPb = pb?.opening;
    const opLt = lt?.opening;
    const sources = [pb, lt].filter(Boolean).map(s => s.source);

    // Agreement check (within ±1 day for typical timezone-rollover noise).
    const datesAgree = (a, b) => {
      if (!a || !b) return null; // can't compare
      const aMs = new Date(a).getTime();
      const bMs = new Date(b).getTime();
      if (Number.isNaN(aMs) || Number.isNaN(bMs)) return null;
      return Math.abs(aMs - bMs) <= 86400000;
    };

    const fpAgreement = datesAgree(fpPb, fpLt);
    const opAgreement = datesAgree(opPb, opLt);
    const bothPresent = pb && lt;

    let confidence;
    if (bothPresent && fpAgreement === true && opAgreement === true) {
      confidence = 'high';
    } else if (bothPresent && (fpAgreement === false || opAgreement === false)) {
      confidence = 'discrepancy';
    } else {
      confidence = 'single-source';
    }

    merged.push({
      title,
      firstPreview: fpPb || fpLt || null,
      opening: opPb || opLt || null,
      sources,
      confidence,
      raw: { playbill: pb, lortel: lt },
    });
  }
  return merged;
}

// =========================================================
// MAIN
// =========================================================

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function appendAudit(entries) {
  if (entries.length === 0) return;
  let existing = { _meta: { schema: 'date-enrichment-corrections v1' }, runs: [] };
  if (fs.existsSync(AUDIT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
      if (!existing.runs) existing.runs = [];
    } catch {
      // corrupt audit — start fresh.
    }
  }
  existing.runs.push({
    runAt: new Date().toISOString(),
    script: 'enrich-off-broadway-dates',
    mode: { dryRun, verify, force, fixUnconfirmed, initialBackfill, showFilter },
    entries,
  });
  // Keep last 50 runs.
  if (existing.runs.length > 50) existing.runs = existing.runs.slice(-50);
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(existing, null, 2));
}

async function main() {
  console.log('=== Off-Broadway Date Enrichment ===');
  console.log(`Mode: ${verify ? 'verify' : dryRun ? 'dry-run' : 'apply'}${fixUnconfirmed ? ' +fix-unconfirmed' : ''}${force ? ' +force' : ''}${initialBackfill ? ' +initial-backfill' : ''}${showFilter ? ` (show=${showFilter})` : ''}`);
  console.log('');

  const data = loadShows();
  const allShows = data.shows || data;

  // Filter to off-broadway shows.
  let obShows = allShows.filter(s => s.category === 'off-broadway');
  console.log(`Off-Broadway shows in shows.json: ${obShows.length}`);
  if (showFilter) {
    obShows = obShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (obShows.length === 0) {
      console.error(`No OB show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
  }

  // Candidates: same idiom as the WE script.
  const candidateShows = verify || showFilter
    ? obShows
    : fixUnconfirmed
      ? obShows.filter(s => !s.previewsStartDate || isUnconfirmedDateSource(s))
      : missingOnly
        ? obShows.filter(s => !s.previewsStartDate)
        : obShows;
  console.log(`Candidate shows for enrichment: ${candidateShows.length}`);
  console.log('');

  // Phase 1: Playbill OB schedule (primary source).
  const playbillEntries = await scrapePlaybillOB();

  // Phase 2: Lortel currently-playing (secondary source).
  // Only fetched once per run; cheap on the hosting side.
  const lortelEntries = await scrapeLortel();

  // Phase 3: Merge two sources by title.
  console.log('');
  console.log('--- MERGING SOURCES ---');
  const merged = mergeSources(playbillEntries, lortelEntries);
  const highConfidence = merged.filter(e => e.confidence === 'high').length;
  const singleSource = merged.filter(e => e.confidence === 'single-source').length;
  const discrepancy = merged.filter(e => e.confidence === 'discrepancy').length;
  console.log(`Merged: ${merged.length} unique entries (${highConfidence} two-source agree, ${singleSource} single-source, ${discrepancy} discrepancy)`);
  console.log('');

  if (merged.length === 0) {
    console.warn('WARNING: 0 merged entries — both sources returned empty');
    process.exit(0);
  }

  // Phase 4: Match to shows.json and compute changes.
  const changes = [];
  const auditEntries = [];

  for (const entry of merged) {
    if (!entry.opening) continue; // skip entries without an opening date
    const result = matchTitleToShow(entry.title, obShows, { market: 'broadway' });
    if (!result || result.confidence !== 'high' || result.show.category !== 'off-broadway') continue;
    const show = result.show;
    const isCandidate = candidateShows.some(s => s.id === show.id);

    // Data integrity: previews must be before opening.
    if (entry.firstPreview && entry.opening && entry.firstPreview >= entry.opening) {
      console.warn(`  SKIP ${show.title}: preview ${entry.firstPreview} >= opening ${entry.opening} (bad data)`);
      continue;
    }

    // Sources resolved during merge — pick the more authoritative for the
    // openingDateSource field.
    const entryDateSource = entry.confidence === 'high'
      ? 'playbill+lortel'
      : (entry.sources[0] || 'playbill');

    // Same-date fix: openingDate === previewsStartDate AND we have a distinct
    // press-night date from external source. This is the KENREX class — the
    // existing data is provably wrong (IBDB shipped both fields with the
    // previews-start value), so single-source correction is safe. The change-
    // stability guard still gates against mass-corruption from a Playbill
    // format change.
    const sameDateFix = show.openingDate && show.previewsStartDate &&
      show.openingDate === show.previewsStartDate &&
      entry.opening !== show.openingDate &&
      isUnconfirmedDateSource(show);

    // For NON-same-date-fix changes, require two-source agreement OR --force.
    // This protects the bulk of OB shows (where the existing date may already
    // be correct) from being silently overwritten by a single-source error.
    if (!sameDateFix && entry.confidence !== 'high' && !force) {
      auditEntries.push({
        showId: show.id,
        title: show.title,
        confidence: entry.confidence,
        sources: entry.sources,
        currentOpening: show.openingDate,
        currentPreviews: show.previewsStartDate,
        currentSource: show.openingDateSource,
        proposedOpening: entry.opening,
        proposedPreviews: entry.firstPreview,
        reason: 'single-source-and-not-same-date-fix',
        raw: entry.raw,
      });
      continue;
    }

    if (sameDateFix && isCandidate) {
      const showChanges = [
        { field: 'openingDate', old: show.openingDate, new: entry.opening },
        { field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource },
      ];
      if (entry.firstPreview && entry.firstPreview !== show.previewsStartDate) {
        showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      }
      changes.push({ id: show.id, title: show.title, slug: show.slug, changes: showChanges });
      console.log(`  FIX ${show.title}: same-date ${show.openingDate} → preview=${entry.firstPreview || show.previewsStartDate}, opening=${entry.opening} [${entryDateSource}]`);
    } else if (force && isCandidate) {
      const showChanges = [];
      if (entry.firstPreview && entry.firstPreview !== show.previewsStartDate) {
        showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      }
      if (entry.opening !== show.openingDate) {
        showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      }
      if (showChanges.length) {
        showChanges.push({ field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource });
        changes.push({ id: show.id, title: show.title, slug: show.slug, changes: showChanges });
      }
    }
  }

  console.log('');
  console.log(`Proposed changes: ${changes.length} | Audit-only: ${auditEntries.length}`);

  // Stability guard: prevent mass-corruption from a parser regression.
  const guardResult = validateChangeStability({
    name: 'enrich-off-broadway-dates',
    changes,
    candidateCount: candidateShows.length,
    thresholds: { absoluteChanges: 50, changePercent: 0.5 },
    forceFlag: force,
    initialBackfillFlag: initialBackfill,
    snapshotPath: ABORT_SNAPSHOT_PATH,
  });
  if (!guardResult.ok) {
    console.error(`Stability guard aborted run. See snapshot: ${guardResult.snapshotPath || ABORT_SNAPSHOT_PATH}`);
    process.exit(1);
  }

  // Print proposed changes
  if (changes.length > 0) {
    console.log('');
    console.log('CHANGES:');
    for (const c of changes) {
      console.log(`  ${c.title} (${c.slug || c.id}):`);
      for (const ch of c.changes) console.log(`    ${ch.field}: ${ch.old} -> ${ch.new}`);
    }
  }

  // Apply (unless dry-run/verify).
  if (!verify && !dryRun && changes.length > 0) {
    for (const c of changes) {
      const show = allShows.find(s => s.id === c.id);
      if (!show) continue;
      for (const ch of c.changes) show[ch.field] = ch.new;
    }
    saveShows(data);
    console.log('');
    console.log(`Wrote ${changes.length} change(s) to shows.json`);
  } else if (changes.length > 0) {
    console.log('');
    console.log(`(${verify ? 'verify' : 'dry-run'} mode — no writes)`);
  }

  // Always append audit (even on dry-run, so operators can review).
  appendAudit([
    ...changes.map(c => ({ kind: 'applied', ...c })),
    ...auditEntries.map(e => ({ kind: 'audit-only', ...e })),
  ]);

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
