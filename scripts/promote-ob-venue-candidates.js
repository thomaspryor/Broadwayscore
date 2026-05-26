#!/usr/bin/env node
/**
 * Promote venue-discovered OB candidates from staging → shows.json.
 *
 * Pipeline:
 *   1. Load data/audit/ob-venue-candidates.json (written by discover-new-shows.js)
 *   2. For each candidate: cross-validate against Playbill OB + Lortel
 *      (isCandidateConfirmed from scripts/lib/ob-cross-validation.js)
 *   3. Confirmed candidates → build a shows.json entry with safe defaults
 *      (status:'announced', openingDate:null, previewsStartDate:null)
 *   4. De-dupe against existing shows.json by id/slug — skip if already present
 *   5. Atomic-write shows.json (via scripts/lib/atomic-shows-write.js)
 *   6. Append promotion log to data/audit/ob-promotion-log.jsonl
 *
 * Modes:
 *   default                — strict cross-validation; safe for cron
 *   --admin-promote-all    — bypass cross-validation, promote ALL staged
 *                            candidates. ONE-TIME launch use only.
 *   --admin-force=<title>  — promote a specific title without confirmation
 *   --dry-run              — show what would be promoted; don't write
 *
 * Safety:
 *   - Atomic write with 5% shrink gate prevents truncation
 *   - status:'announced' + openingDate:null ensures orchestrator skips
 *     these until they're enriched by a real opening date (V-T9 audit)
 *   - Promotion log is JSONL append-only for audit trail
 */

const fs = require('fs');
const path = require('path');
const { loadStaging, writeStagingCandidates } = require('./lib/venue-listing-discover');
const { isCandidateConfirmed } = require('./lib/ob-cross-validation');
const { atomicWriteShowsJson, AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { scrapePlaybillOBData } = require('./lib/playbill-ob-schedule');
const { scrapeLortel } = require('./enrich-off-broadway-dates');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'ob-promotion-log.jsonl');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const adminPromoteAll = args.includes('--admin-promote-all');
const adminForceArgs = args
  .filter(a => a.startsWith('--admin-force='))
  .map(a => a.split('=').slice(1).join('=').toLowerCase());

function logEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(PROMOTION_LOG), { recursive: true });
    fs.appendFileSync(PROMOTION_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

function buildShowEntry(candidate) {
  // Build a minimal show entry. openingDate intentionally null so the
  // opening-night orchestrator doesn't fire on a venue-only stub
  // (see V-T9 — orchestrator must skip null-openingDate).
  const year = new Date().getFullYear();
  const slugBase = candidate.slug || candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `${slugBase}-off-broadway-${year}`;
  return {
    id,
    title: candidate.title,
    slug: slugBase,
    venue: candidate.venue,
    openingDate: null,
    previewsStartDate: null,
    closingDate: null,
    status: 'announced',
    category: 'off-broadway',
    market: 'broadway',
    type: null,
    discoverySource: candidate.source,
    discoveredAt: candidate.discoveredAt,
    // Provisional — opening-night orchestrator + Lortel/IBDB enrichment
    // will fill in dates, cast, runtime once they appear in those sources.
    provisional: true,
  };
}

async function main() {
  const staged = loadStaging();
  if (staged.length === 0) {
    console.log('No staged candidates to promote.');
    return;
  }
  console.log(`Loaded ${staged.length} staged candidates from staging file.`);

  // Load existing shows.json for dedupe + atomic write base
  let showsData;
  try {
    showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  } catch (e) {
    console.error(`Failed to load ${SHOWS_FILE}: ${e.message}`);
    process.exit(1);
  }
  const existingIds = new Set(showsData.shows.map(s => s.id));
  const existingTitleVenue = new Set(showsData.shows.map(s => `${(s.title||'').toLowerCase()}|${(s.venue||'').toLowerCase()}`));

  // Fetch cross-validation sources unless --admin-promote-all
  let playbillEntries = [];
  let lortelEntries = [];
  if (!adminPromoteAll) {
    console.log('Fetching Playbill OB for cross-validation...');
    const pb = await scrapePlaybillOBData();
    playbillEntries = pb.entries;
    console.log(`  Playbill OB: ${playbillEntries.length} entries.`);
    console.log('Fetching Lortel currently-playing for cross-validation...');
    try {
      lortelEntries = await scrapeLortel();
      console.log(`  Lortel: ${lortelEntries.length} entries.`);
    } catch (e) {
      console.warn(`  Lortel scrape failed (${e.message}); proceeding with Playbill only.`);
    }
  }

  const promoted = [];
  const skipped = [];
  const remainingStaged = [];
  for (const c of staged) {
    const titleLower = (c.title || '').toLowerCase();
    const venueLower = (c.venue || '').toLowerCase();

    // Dedupe against existing shows
    if (existingTitleVenue.has(`${titleLower}|${venueLower}`)) {
      skipped.push({ candidate: c, reason: 'already in shows.json (title+venue match)' });
      logEntry({ kind: 'skip-duplicate', title: c.title, venue: c.venue });
      continue;
    }

    let confirmed = false;
    let reason = '';
    let source = null;
    if (adminPromoteAll) {
      confirmed = true; reason = '--admin-promote-all'; source = 'admin';
    } else if (adminForceArgs.includes(titleLower)) {
      confirmed = true; reason = `--admin-force="${c.title}"`; source = 'admin-force';
    } else {
      const r = isCandidateConfirmed(c, { playbillEntries, lortelEntries });
      confirmed = r.confirmed; reason = r.reason; source = r.source;
    }

    if (!confirmed) {
      skipped.push({ candidate: c, reason });
      remainingStaged.push(c); // keep in staging for next run
      logEntry({ kind: 'skip-unconfirmed', title: c.title, venue: c.venue, reason });
      continue;
    }

    // Build show entry + dedupe by ID
    const entry = buildShowEntry(c);
    if (existingIds.has(entry.id)) {
      skipped.push({ candidate: c, reason: `id ${entry.id} already exists` });
      logEntry({ kind: 'skip-id-collision', title: c.title, venue: c.venue, id: entry.id });
      continue;
    }
    promoted.push({ candidate: c, entry, confirmationSource: source, confirmationReason: reason });
    existingIds.add(entry.id);
    logEntry({ kind: 'promote', title: c.title, venue: c.venue, id: entry.id, confirmationSource: source });
  }

  console.log('');
  console.log(`Promotion summary: ${promoted.length} promote / ${skipped.length} skip (of ${staged.length} staged).`);
  if (promoted.length > 0) {
    console.log('Promoting:');
    for (const p of promoted) console.log(`  + ${p.entry.id} (via ${p.confirmationSource}: ${p.confirmationReason})`);
  }
  if (skipped.length > 0) {
    console.log('Skipping:');
    for (const s of skipped.slice(0, 20)) console.log(`  - ${s.candidate.title} (${s.candidate.venue}): ${s.reason}`);
    if (skipped.length > 20) console.log(`  ... +${skipped.length - 20} more`);
  }

  if (dryRun) {
    console.log('');
    console.log('(dry-run: no writes)');
    return;
  }

  if (promoted.length === 0) {
    console.log('Nothing to promote; shows.json unchanged.');
    return;
  }

  // Append to shows.json and atomic-write
  for (const p of promoted) showsData.shows.push(p.entry);
  try {
    const r = atomicWriteShowsJson(SHOWS_FILE, showsData);
    console.log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // Rewrite staging file with only the unpromoted candidates
  // (atomic write happens inside writeStagingCandidates — replace-by-hash)
  // We need to wipe staging and re-add the remaining ones.
  const stagingPath = path.join(__dirname, '..', 'data', 'audit', 'ob-venue-candidates.json');
  fs.writeFileSync(stagingPath + '.tmp.' + process.pid, JSON.stringify(remainingStaged, null, 2));
  fs.renameSync(stagingPath + '.tmp.' + process.pid, stagingPath);
  console.log(`Staging file: ${remainingStaged.length} unpromoted candidates remain.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { buildShowEntry };
