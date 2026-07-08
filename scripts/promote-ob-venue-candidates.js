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
  // Build a per-venue index of existing OB shows so cross-source dedup can
  // do TOKEN-SET (jaccard) comparison instead of exact normalized-string.
  // Exact-string match misses word-order variants:
  //   "Heated Rivalry: The Unauthorized Musical Parody" (TodayTix)
  //   "HEATED RIVALRY: THE UNAUTHORIZED PARODY MUSICAL" (Playbill)
  // → same tokens, different word order, different normalized strings.
  // The bug: this exact pair shipped a duplicate to production on 2026-05-27.
  // Fix: jaccard >= DEDUP_JACCARD_THRESHOLD on titleTokens collapses them.
  const { normalizeTitle, canonicalVenue, titleTokens, jaccard } = require('./lib/title-match');
  // 0.80 (not 0.85) because normalizeTitle's trailing-"musical" strip can
  // unbalance token sets — "Heated Rivalry: The Unauthorized Musical Parody"
  // keeps "musical" + "parody" but "...PARODY MUSICAL" loses trailing
  // "musical" → jaccard 0.8, not 1.0. 0.8 still requires 80% token overlap.
  const DEDUP_JACCARD_THRESHOLD = 0.80;
  const existingByVenue = new Map(); // canonicalVenue → [{ id, title, tokens, normalized }]
  // Include 'regional' alongside 'off-broadway': regional candidates are added
  // to shows.json manually (runbook), and without them in this index a staged
  // regional entry never matches → never drops → re-hits validation weekly
  // forever (Black Swan sat staged 3 weeks after shipping, 2026-07-08).
  for (const s of showsData.shows.filter(s => s.category === 'off-broadway' || s.category === 'regional')) {
    const venueKey = canonicalVenue(s.venue);
    if (!existingByVenue.has(venueKey)) existingByVenue.set(venueKey, []);
    existingByVenue.get(venueKey).push({
      id: s.id, title: s.title,
      tokens: titleTokens(s.title),
      normalized: normalizeTitle(s.title),
    });
  }

  /** Return the existing show that matches `c` by canonical venue +
   *  (normalized title OR jaccard ≥ threshold). Else null. */
  function findExistingMatch(c) {
    const venueKey = canonicalVenue(c.venue);
    const cands = existingByVenue.get(venueKey) || [];
    if (cands.length === 0) return null;
    const cNorm = normalizeTitle(c.title);
    const cTokens = titleTokens(c.title);
    for (const e of cands) {
      if (e.normalized === cNorm) return { match: e, reason: 'normalized-equal' };
      if (cTokens.size > 0 && e.tokens.size > 0) {
        const sim = jaccard(cTokens, e.tokens);
        if (sim >= DEDUP_JACCARD_THRESHOLD) return { match: e, reason: `jaccard=${sim.toFixed(2)}` };
      }
    }
    return null;
  }

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

    // Dedupe via per-venue jaccard match. Catches: cross-year duplicates,
    // venue-string variants ("Atlantic Theater Company - Linda Gross" vs
    // "Atlantic Theater"), cross-source same-venue (TNG → Signature Center),
    // AND word-order variants ("Musical Parody" vs "Parody Musical").
    const existingMatch = findExistingMatch(c);
    if (existingMatch) {
      skipped.push({ candidate: c, reason: `already in shows.json as ${existingMatch.match.id} (${existingMatch.reason})` });
      logEntry({ kind: 'skip-duplicate', title: c.title, venue: c.venue, matchedTo: existingMatch.match.id, matchReason: existingMatch.reason });
      continue;
    }

    // Regional feeder-venue candidates (category set by aggregator-candidate-
    // extract.js) can never be confirmed by Playbill-OB/Lortel — don't burn
    // cross-validation on them. They stay staged; the extractor's --email
    // alert is their surfacing path, and the human adds them per
    // memory/feedback_regional_show_add_runbook.md.
    if (c.category === 'regional' && !adminPromoteAll && !adminForceArgs.includes(titleLower)) {
      skipped.push({ candidate: c, reason: 'regional feeder venue — manual add via runbook (alert emailed)' });
      remainingStaged.push(c);
      logEntry({ kind: 'skip-regional', title: c.title, venue: c.venue });
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
  // Tag each line with the candidate's discovery source (venue-page:* vs
  // playbill-verdict / bww-roundup) so the operator knows whether a row came
  // from a direct venue scrape or an aggregator-article extraction (the latter
  // warrants extra scrutiny — venue was parsed from prose). See plan-review.
  if (promoted.length > 0) {
    console.log('Promoting:');
    for (const p of promoted) console.log(`  + [${p.candidate.source || 'unknown'}] ${p.entry.id} (via ${p.confirmationSource}: ${p.confirmationReason})`);
  }
  if (skipped.length > 0) {
    console.log('Skipping:');
    for (const s of skipped.slice(0, 20)) console.log(`  - [${s.candidate.source || 'unknown'}] ${s.candidate.title} (${s.candidate.venue}): ${s.reason}`);
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
