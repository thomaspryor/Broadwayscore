#!/usr/bin/env node
/**
 * Apply Commercial Pending Data
 *
 * Merges data from commercial-pending-review.json into commercial.json
 * after human review. Runs validation after applying.
 *
 * Usage:
 *   node scripts/apply-commercial-pending.js [options]
 *
 * Options:
 *   --all              Apply all pending entries
 *   --show=SLUG        Apply a single show by slug/ID
 *   --dry-run          Preview without writing
 *   --exclude=SLUG,... Skip specific shows
 *   --min-confidence=LEVEL  Only apply entries with this confidence or higher (high, medium, all)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeSources } = require('./lib/commercial-sources');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');

// CLI args
const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const APPLY_ALL = flags['all'] === true;
const SINGLE_SHOW = flags['show'] || null;
const EXCLUDES = flags['exclude'] ? flags['exclude'].split(',') : [];
const MIN_CONFIDENCE = flags['min-confidence'] || 'all';
// Comma-separated list of detectedBy sources whose recouped-claim entries may
// auto-apply without --show=SLUG, IF confidence === 'high' AND sourceHost is in
// the trusted-recoupment-domains list. Used by the Friday scraper pipeline.
const AUTO_APPLY_CLAIMS_FROM = flags['auto-apply-claims-from']
  ? flags['auto-apply-claims-from'].split(',').map(s => s.trim()).filter(Boolean)
  : [];

const gate = require('./lib/commercial-apply-gate');
const meetsConfidenceThreshold = (entry) => gate.meetsConfidenceThreshold(entry, MIN_CONFIDENCE);
const hasRecoupedClaim = gate.hasRecoupedClaim;
const isAutoApplyableClaim = (entry) => gate.isAutoApplyableClaim(entry, AUTO_APPLY_CLAIMS_FROM);

function main() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.log('No pending file found at', PENDING_PATH);
    process.exit(1);
  }

  // Fail loudly on malformed JSON (don't silently produce empty results)
  let pending, commercial;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch (e) {
    console.error(`FATAL: Malformed pending JSON: ${e.message}`);
    process.exit(1);
  }
  try {
    commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
  } catch (e) {
    console.error(`FATAL: Malformed commercial.json: ${e.message}`);
    process.exit(1);
  }

  if (!pending.shows || Object.keys(pending.shows).length === 0) {
    console.log('No pending shows to apply.');
    return;
  }

  console.log(`📋 Pending file has ${Object.keys(pending.shows).length} shows`);
  console.log(`💰 Commercial.json has ${Object.keys(commercial.shows || {}).length} shows`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  // Filter to target shows
  let showIds;
  if (SINGLE_SHOW) {
    showIds = [SINGLE_SHOW].filter(id => pending.shows[id]);
    if (showIds.length === 0) {
      console.log(`❌ Show "${SINGLE_SHOW}" not found in pending file`);
      process.exit(1);
    }
  } else if (APPLY_ALL) {
    showIds = Object.keys(pending.shows).filter(id => !EXCLUDES.includes(id));
  } else {
    console.log('Specify --all to apply all, or --show=SLUG for a single show.');
    console.log('');
    console.log('Pending shows:');
    for (const [id, data] of Object.entries(pending.shows)) {
      const inCommercial = commercial.shows?.[id] ? ' (ALREADY IN commercial.json)' : '';
      console.log(`  ${id}: ${data.designation || 'TBD'} | Cap: ${data.capitalization ? '$' + (data.capitalization / 1e6).toFixed(1) + 'M' : '?'} | Conf: ${data.confidence || '?'}${inCommercial}`);
    }
    return;
  }

  let applied = 0;
  let skipped = 0;

  // Track keys that were ACTUALLY applied this run. The cleanup loop below
  // must delete only these — key-existence in commercial.json is NOT a proxy
  // for "was applied": review-hold entries are deliberately keyed to existing
  // commercial entries and were being deleted unreviewed (ship-check P0,
  // Sprint 2 2026-07-13).
  const appliedIds = new Set();

  // Scope lookup — pending keys can be show IDs while entries carry slugs.
  let showsBySlug = {};
  try {
    const allShows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || [];
    for (const s of allShows) {
      if (s.slug) showsBySlug[s.slug] = s;
      if (s.id) showsBySlug[s.id] = s;
    }
  } catch {
    // shows.json unavailable — scope guard degrades to no-op rather than
    // blocking the apply pipeline.
  }

  for (const showId of showIds) {
    const entry = pending.shows[showId];
    if (!entry) continue;

    // Scope guard — Off-Broadway / West End entries must never land in
    // commercial.json (Broadway-only feature). Unresolved shows pass: adding
    // a commercial row ahead of the shows-list update is a supported flow.
    const scopeShow = resolveScopeShow(showsBySlug, showId, entry);
    if (scopeShow && !isCommercialScope(scopeShow)) {
      console.log(`  ⛔ "${showId}" — out of commercial scope (${scopeShow.category}), skipping`);
      skipped++;
      continue;
    }

    // Review holds are never appliable — see gate.isReviewHold rationale.
    if (gate.isReviewHold(entry)) {
      console.log(`  🛑 "${showId}" — review hold, never appliable. See entry.notes; edit commercial.json directly.`);
      skipped++;
      continue;
    }

    // Confidence filter
    if (!meetsConfidenceThreshold(entry)) {
      console.log(`  ⏭️  "${showId}" — confidence ${entry.confidence || 'unknown'} below threshold ${MIN_CONFIDENCE}`);
      skipped++;
      continue;
    }

    // Safety: never auto-apply recouped:true without human review, EXCEPT when
    // a trusted scraper source + high confidence + trusted publisher domain all
    // line up (see isAutoApplyableClaim). This is the Friday-pipeline hot path.
    if (hasRecoupedClaim(entry) && !SINGLE_SHOW && !isAutoApplyableClaim(entry)) {
      console.log(`  🛡️  "${showId}" — has recouped claim, requires manual review (use --show=${showId})`);
      skipped++;
      continue;
    }
    const isClaimAutoApply = hasRecoupedClaim(entry) && isAutoApplyableClaim(entry);
    if (isClaimAutoApply) {
      console.log(`  ✅ "${showId}" — auto-applying recouped claim from trusted source ${entry.detectedBy} @ ${entry.sourceHost}`);
    }

    // Honor human review: humanReviewedDesignation:true means an operator
    // explicitly set the designation via Notion-card review and the apply
    // pipeline must never overwrite it. Same convention as humanCorrected-
    // ClosingDate in scripts/lib/closing-date-guard.js. Without this guard,
    // a manual "Ragtime is enhancement-deal recouped" correction can be
    // clobbered the next Saturday when deep-research returns a 'low'-conf
    // contradicting result.
    // commercial.json is keyed by SLUG (memory: feedback_commercial_slug_keys)
    // while pending entries are keyed by show ID. Resolve via entry.slug so an
    // ID-keyed pending entry (e.g. appropriate-2023) updates the existing
    // slug-keyed commercial entry (appropriate) instead of creating an
    // unsourced duplicate that the strict gate would then fail on.
    const commercialKey = entry.slug || showId;
    const existing = commercial.shows[commercialKey];
    if (existing && existing.humanReviewedDesignation === true && !SINGLE_SHOW) {
      console.log(`  🔒 "${showId}" — humanReviewedDesignation:true, skipping auto-apply`);
      skipped++;
      continue;
    }

    // If already exists, update rather than skip (merge new findings).
    // EXCEPT: auto-apply recoupment claims MUST be allowed through here —
    // those entries only carry recoupment fields, and the show ALREADY having a
    // designation is the common case (every show that recouped after first
    // deep-research already has 'TBD' bumped to something like 'Easy Winner').
    // Without this exception the Friday pipeline is a no-op for the very
    // shows it's designed to catch. Ship-check P0 finding.
    if (existing && existing.designation && existing.designation !== 'TBD' && !SINGLE_SHOW && !isClaimAutoApply) {
      console.log(`  "${showId}" already has designation "${existing.designation}" — skipping`);
      skipped++;
      continue;
    }

    // Build entry via shared lib (tested in commercial-apply-gate.test.mjs).
    // For auto-apply claims, the lib starts from `existing` and overlays the
    // scraper's recoupment fields — preserving designation/cap/cost/notes
    // that the scraper doesn't carry.
    const commercialEntry = gate.buildCommercialEntry(entry, existing, {
      isClaimAutoApply,
      normalizeSources,
    });

    commercialEntry.lastUpdated = new Date().toISOString();
    commercialEntry.firstAdded = existing?.firstAdded || new Date().toISOString();

    // Preserve research tracking metadata from existing entry
    if (existing) {
      if (existing.researchAttempts != null) commercialEntry.researchAttempts = existing.researchAttempts;
      if (existing.lastResearchedAt != null) commercialEntry.lastResearchedAt = existing.lastResearchedAt;
      if (existing.researchTrigger != null) commercialEntry.researchTrigger = existing.researchTrigger;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would apply "${showId}" → ${JSON.stringify(commercialEntry, null, 2).slice(0, 200)}...`);
    } else {
      commercial.shows[commercialKey] = commercialEntry;
      console.log(`  ✅ Applied "${showId}" → commercial.shows["${commercialKey}"] (${commercialEntry.designation || 'TBD'})`);
    }
    appliedIds.add(showId);
    applied++;
  }

  if (!DRY_RUN && applied > 0) {
    // Bump top-level freshness field. health-check.js line 221 reads
    // commercial.json's _meta.lastUpdated to decide whether to flag staleness
    // in the daily digest; without this bump it stayed frozen at the last
    // full-catchup date even though shows were merging cleanly each run.
    commercial._meta = commercial._meta || {};
    commercial._meta.lastUpdated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');
    console.log(`\n✅ Applied ${applied} shows, ${skipped} skipped`);

    // Run validation
    console.log('\n🔍 Running validation...');
    try {
      execSync('node scripts/validate-data.js', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
      });
      console.log('✅ Validation passed');
    } catch {
      console.error('❌ Validation FAILED — review commercial.json for issues');
      process.exit(1);
    }

    // Remove applied shows from pending — ONLY the ones actually applied this
    // run (appliedIds). The old key-existence check deleted review-hold and
    // skipped entries whose keys happened to exist in commercial.json.
    for (const showId of appliedIds) {
      delete pending.shows[showId];
    }
    if (Object.keys(pending.shows).length > 0) {
      // Stamp the deletion (/what-else follow-up, 2026-07-19): mergePendingReview
      // in push-with-retry.sh's conflict path uses this field as a logical
      // clock to decide whether a slug missing from "remote" was deleted
      // (respect it) or never seen yet (keep a concurrent producer's copy).
      // Without this stamp, an applied show could be silently resurrected by
      // a stale concurrent write on the next push conflict.
      pending.lastUpdated = new Date().toISOString();
      fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
      console.log(`📋 ${Object.keys(pending.shows).length} shows remaining in pending file`);
    } else {
      fs.unlinkSync(PENDING_PATH);
      console.log('📋 Pending file cleared');
    }
  } else if (DRY_RUN) {
    console.log(`\n🏁 Dry run: would apply ${applied}, skip ${skipped}`);
  }
}

main();
