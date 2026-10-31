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
 *   --no-source-verify Fetch no pages; leave entries with figures pending for the verified pass (RSS poll)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeSources } = require('./lib/commercial-sources');
const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
let PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
let SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');
const { buildShowKeyIndex, resolveCommercialSlug } = require('./lib/commercial-slug-key');

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
// Alternative inputs are read-only fixture support, never live write targets.
if (flags['pending-file'] || flags['shows-file'] || flags['commercial-file']) {
  if (!DRY_RUN) throw new Error('Fixture input overrides require --dry-run');
  if (flags['pending-file']) PENDING_PATH = path.resolve(flags['pending-file']);
  if (flags['shows-file']) SHOWS_PATH = path.resolve(flags['shows-file']);
}
const APPLY_ALL = flags['all'] === true;
const SINGLE_SHOW = flags['show'] || null;
// BRO-5041: comma-separated held (requiresHumanReview) rows to release in one run, with one validation and one
// pending write. The only path that applies a held row: it refuses records a person or a verified pass already
// labelled, merges onto the existing record and never publishes the row's "recouped" claim (gate.heldReleaseRefusal).
const RELEASE_HELD = typeof flags['release-held'] === 'string'
  ? flags['release-held'].split(',').map(s => s.trim()).filter(Boolean)
  : null;
const EXCLUDES = flags['exclude'] ? flags['exclude'].split(',') : [];
const MIN_CONFIDENCE = flags['min-confidence'] || 'all';
// Skip page verification and leave every entry that carries a capitalization or weekly cost pending for the
// verified weekly/Friday pass. Used by the hourly RSS poll, which only auto-applies recoupment claims: it must
// neither fetch pages every hour nor apply unverified figures as estimates ahead of the verified pass.
const NO_SOURCE_VERIFY = flags['no-source-verify'] === true;
// BRO-6336: apply any entry (whatever its confidence) whose figures a fetched trusted page confirms. An entry the
// pages do not confirm moves to the archive with the reason; one a person must settle is stamped autoApplyBlocked
// and stays pending for a worker (health-check "Commercial: rows held for a person"). Needs --all and page verification.
const VERIFIED_ONLY = flags['verified-only'] === true;
if (VERIFIED_ONLY && (!APPLY_ALL || NO_SOURCE_VERIFY || SINGLE_SHOW || RELEASE_HELD)) {
  console.log('❌ --verified-only needs --all and cannot be combined with --no-source-verify, --show or --release-held');
  process.exit(1);
}
// Comma-separated list of detectedBy sources whose recouped-claim entries may
// auto-apply without --show=SLUG, IF confidence === 'high' AND sourceHost is in
// the trusted-recoupment-domains list. Used by the Friday scraper pipeline.
const AUTO_APPLY_CLAIMS_FROM = flags['auto-apply-claims-from']
  ? flags['auto-apply-claims-from'].split(',').map(s => s.trim()).filter(Boolean)
  : [];

const { carriedClearedGuard } = require('./lib/cleared-field-guard');
const gate = require('./lib/commercial-apply-gate');
const { sanitizeForPublicRecord, commercialRecordErrors } = require('./lib/commercial-record-checks');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { createRunBudget } = require('./lib/run-budget');

const USAGE = `apply-commercial-pending.js — Apply Commercial Pending Data.

Usage:
  node scripts/apply-commercial-pending.js [options]
  node scripts/apply-commercial-pending.js --release-held=SLUG[,SLUG...] [--dry-run]
      release held backfill rows by name (never overwrites a non-TBD or human-reviewed record;
      never publishes the row's "recouped" claim)
  node scripts/apply-commercial-pending.js --help, -h    print this usage and exit
`;
const meetsConfidenceThreshold = (entry) => gate.meetsConfidenceThreshold(entry, MIN_CONFIDENCE);
const hasRecoupedClaim = gate.hasRecoupedClaim;
const isAutoApplyableClaim = (entry, show) => gate.isAutoApplyableClaim(entry, AUTO_APPLY_CLAIMS_FROM, show);

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
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
    commercial = flags['commercial-file'] ? JSON.parse(fs.readFileSync(path.resolve(flags['commercial-file']), 'utf8')) : loadCommercial();
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
  if (flags['release-held'] !== undefined && (!RELEASE_HELD || RELEASE_HELD.length === 0)) {
    console.log('❌ --release-held needs a comma-separated list of slugs');
    process.exit(1);
  }
  if (RELEASE_HELD && (SINGLE_SHOW || APPLY_ALL)) {
    console.log('❌ --release-held cannot be combined with --show or --all');
    process.exit(1);
  }
  if (RELEASE_HELD) {
    showIds = RELEASE_HELD.filter(id => pending.shows[id]);
    const missing = RELEASE_HELD.filter(id => !pending.shows[id]);
    if (missing.length) console.log(`⚠️  Not in pending file (already applied or never researched): ${missing.join(', ')}`);
  } else if (SINGLE_SHOW) {
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
  let pendingDirty = false; // a pending entry's verify-attempt counter changed and must be saved

  // Track keys that were ACTUALLY applied this run. The cleanup loop below
  // must delete only these — key-existence in commercial.json is NOT a proxy
  // for "was applied": review-hold entries are deliberately keyed to existing
  // commercial entries and were being deleted unreviewed (ship-check P0,
  // Sprint 2 2026-07-13).
  const appliedIds = new Set();
  // --verified-only: entries moved to the archive this run ({reason, archivedReason, prefix}). Rows only a person can
  // settle stay pending instead (noteBlocked).
  const rejectedIds = new Map();
  const noteBlocked = (showId, reason) => {
    if (!VERIFIED_ONLY || DRY_RUN || !pending.shows[showId]) return;
    if (pending.shows[showId].autoApplyBlocked !== reason) { pending.shows[showId].autoApplyBlocked = reason; pending.shows[showId].autoApplyBlockedAt = new Date().toISOString(); pendingDirty = true; }
  };

  // Scope lookup — pending keys can be show IDs while entries carry slugs.
  let showsBySlug = {};
  let showKeyIndex = buildShowKeyIndex([]);
  try {
    const allShows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || [];
    for (const s of allShows) {
      if (s.slug) showsBySlug[s.slug] = s;
      if (s.id) showsBySlug[s.id] = s;
    }
    showKeyIndex = buildShowKeyIndex(allShows);
  } catch {
    // shows.json unavailable — scope guard degrades to no-op rather than
    // blocking the apply pipeline.
  }

  const { createSourceVerifier, nextVerifyAttempt, SOURCE_VERIFY_MAX_ATTEMPTS } = require('./lib/commercial-source-verify');
  const { verifiedOutcome, UNVERIFIED_REASON, OUT_OF_SCOPE_REASON } = require('./lib/pending-verify-policy');
  // Page verification can be slow (provider fallbacks run tens of seconds per page). The jobs that run this script
  // have a 30 minute timeout shared with the commit and push that follow, so stop starting new verifications after
  // 12 minutes and leave the rest pending for the next run (scripts/audit-run-budget-coverage.js).
  const verifyBudget = createRunBudget(12);
  const verifyEntry = createSourceVerifier({}, verifyBudget);
  for (const showId of showIds) {
    const entry = pending.shows[showId];
    if (!entry) continue;

    // Scope guard — Off-Broadway / West End entries must never land in
    // commercial.json (Broadway-only feature). An explicitly named manual
    // apply can precede the shows-list update; bulk automation cannot.
    const scopeShow = resolveScopeShow(showsBySlug, showId, entry);
    if (scopeShow && !isCommercialScope(scopeShow)) {
      console.log(`  ⛔ "${showId}" — out of commercial scope (${scopeShow.category}), skipping`);
      if (VERIFIED_ONLY && !DRY_RUN) rejectedIds.set(showId, { reason: `out of commercial scope (${scopeShow.category})`, archivedReason: OUT_OF_SCOPE_REASON, prefix: 'out-of-scope' });
      skipped++;
      continue;
    }

    // Review holds are never appliable — see gate.isReviewHold rationale.
    if (gate.isReviewHold(entry)) {
      console.log(`  🛑 "${showId}" — review hold, never appliable. See entry.notes; edit commercial.json directly.`);
      noteBlocked(showId, 'held for review: needs a person to edit commercial.json');
      skipped++;
      continue;
    }

    if (gate.requiresHumanReview(entry) && !RELEASE_HELD) {
      console.log(`  👀 "${showId}" — backfill research, needs human review (release with --release-held=${showId})`);
      noteBlocked(showId, 'backfill research row: needs a person to release it');
      skipped++;
      continue;
    }
    if (RELEASE_HELD && !gate.requiresHumanReview(entry)) {
      console.log(`  ⏭️  "${showId}" — not a held row; --release-held only releases held rows`);
      skipped++;
      continue;
    }
    // What gets applied: a released held row loses any "recouped" claim. `entry` stays the stored pending row
    // (its verify-attempt counter is written back below).
    let row = RELEASE_HELD ? gate.withoutRecoupmentClaim(entry) : entry;

    // Confidence filter
    if (!VERIFIED_ONLY && !meetsConfidenceThreshold(row)) {
      console.log(`  ⏭️  "${showId}" — confidence ${entry.confidence || 'unknown'} below threshold ${MIN_CONFIDENCE}`);
      skipped++;
      continue;
    }

    // Verified-only mode drops the confidence filter, but only the figures get checked against a page. A row below
    // the confidence bar therefore publishes its figures alone: its label, recoupment and notes were never confirmed.
    if (VERIFIED_ONLY && !meetsConfidenceThreshold(row) && !hasRecoupedClaim(row)) {
      if (row.capitalization == null && row.weeklyRunningCost == null) {
        const reason = `research confidence ${entry.confidence || 'unknown'} and no capitalization or weekly cost a page could confirm`;
        console.log(`  🚫 "${showId}" — ${reason}; moving to the rejected log`);
        if (!DRY_RUN) rejectedIds.set(showId, { reason, archivedReason: UNVERIFIED_REASON, prefix: 'unverified' });
        skipped++;
        continue;
      }
      row = { ...row };
      for (const f of ['designation', 'recouped', 'recoupedDate', 'recoupedSource', 'estimatedRecoupmentPct', 'notes']) delete row[f];
    }

    // commercial.json is keyed by SLUG (memory: feedback_commercial_slug_keys)
    // while pending entries are keyed by show ID. Resolve via entry.slug so an
    // ID-keyed pending entry (e.g. appropriate-2023) updates the existing
    // slug-keyed commercial entry (appropriate) instead of creating an
    // unsourced duplicate that the strict gate would then fail on.
    // entry.slug is often absent — resolve the canonical slug from shows.json
    // before falling back to showId. The bare `entry.slug || showId` fallback
    // created 13 ID-keyed duplicate entries (doubt-2024 next to doubt, ...)
    // that were invisible on /biz and had to be hand-merged (2026-07-19).
    // BRO-4623: entry.slug is NOT trusted either. deep-research wrote show
    // IDs into it (queue -> target -> analysis.slug), and this line's old
    // `entry.slug || ...` form published the-balusters-2026 and
    // school-girls-or-the-african-mean-girls-play-2026 next to their slug
    // entries (RSS-poll runs 2026-09-26 / 2026-09-28). The shared resolver
    // only accepts a real slug, or maps a show ID to its slug.
    const { slug: commercialKey, show: keyShow, resolved } = resolveCommercialSlug(showId, entry, showKeyIndex);
    // BRO-4623: stale pending keys such as "860" survive a show rename. A
    // bulk apply must not recreate the orphan after its approved cleanup.
    // Keep the row pending until it resolves, or an operator names it.
    if (!resolved && !SINGLE_SHOW && !RELEASE_HELD) {
      console.log(`  Skipping "${showId}": no show resolves in shows.json; left pending for manual review`);
      noteBlocked(showId, 'no show in shows.json matches this entry');
      skipped++;
      continue;
    }

    // Safety: never auto-apply recouped:true without human review, EXCEPT when
    // a trusted scraper source + high confidence + trusted publisher domain all
    // line up (see isAutoApplyableClaim). This is the Friday-pipeline hot path.
    // The production check runs against keyShow, the show whose commercial.json
    // key the claim is written to, not scopeShow (resolveScopeShow trusts
    // entry.slug and strips -YYYY, so it can name a different production).
    const claimAutoApplyable = hasRecoupedClaim(row) && isAutoApplyableClaim(row, keyShow);
    if (hasRecoupedClaim(row) && !SINGLE_SHOW && !claimAutoApplyable) {
      console.log(`  🛡️  "${showId}" — has recouped claim, requires manual review (${RELEASE_HELD ? 'settle it on the review page' : `use --show=${showId}`})`);
      noteBlocked(showId, 'recoupment claim: a person must confirm it against the cited source');
      skipped++;
      continue;
    }
    const isClaimAutoApply = claimAutoApplyable;
    if (isClaimAutoApply) {
      console.log(`  ✅ "${showId}" — auto-applying recouped claim from trusted source ${entry.detectedBy} @ ${entry.sourceHost}`);
    }

    if (!resolved) {
      console.warn(`  ⚠️ "${showId}" — no slug resolvable from shows.json; keying by "${commercialKey}" (validate-data will flag)`);
    }

    // Honor human review: humanReviewedDesignation:true means an operator
    // explicitly set the designation via Notion-card review and the apply
    // pipeline must never overwrite it. Same convention as humanCorrected-
    // ClosingDate in scripts/lib/closing-date-guard.js. Without this guard,
    // a manual "Ragtime is enhancement-deal recouped" correction can be
    // clobbered the next Saturday when deep-research returns a 'low'-conf
    // contradicting result.
    const existing = commercial.shows[commercialKey];
    const releaseRefusal = RELEASE_HELD ? gate.heldReleaseRefusal(existing, row) : null;
    if (releaseRefusal) {
      console.log(`  🔒 "${showId}" — not released: ${releaseRefusal}; left pending for review`);
      skipped++;
      continue;
    }
    // Every apply onto an existing record overlays it (BRO-5639): a research row
    // never carries costHistory, analyst*, estimatedRecoupment*, model* fields,
    // and a from-scratch rebuild would drop them.
    const mergeExisting = Boolean(RELEASE_HELD || (existing && !SINGLE_SHOW));
    // --show onto an existing record keeps its research-replaces-record meaning.
    if (existing && existing.humanReviewedDesignation === true && !SINGLE_SHOW) {
      console.log(`  🔒 "${showId}" — humanReviewedDesignation:true, skipping auto-apply`);
      noteBlocked(showId, 'the record carries a human-reviewed designation: a person must decide');
      skipped++;
      continue;
    }
    // A verified recoupment contradicts a loss designation. An inferred
    // classify-stale-closures Fizzle is reset to TBD by buildCommercialEntry;
    // any other Fizzle/Flop stays for a human (BRO-4623 item 5).
    if (isClaimAutoApply && gate.recoupClaimDesignationAction(existing) === 'block') {
      console.log(`  🔒 "${showId}" — recoupment claim contradicts "${existing.designation}" (not a label inferred from silence), requires manual review`);
      noteBlocked(showId, 'the claim contradicts the record designation: a person must decide');
      skipped++;
      continue;
    }
    if (isClaimAutoApply && gate.recoupClaimDesignationAction(existing) === 'reset') {
      console.log(`  ↺ "${showId}" — inferred "${existing.designation}" (no recoupment announced) contradicted by recoupment; resetting designation to TBD`);
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
      // A research row never overwrites a labelled record, so it can only sit here: archive it quietly.
      if (VERIFIED_ONLY && !DRY_RUN) rejectedIds.set(showId, { reason: `the record already carries the designation "${existing.designation}"; a research row does not overwrite it`, archivedReason: 'record-already-designated', prefix: 'superseded' });
      skipped++;
      continue;
    }

    // Build entry via shared lib (tested in commercial-apply-gate.test.mjs).
    // For auto-apply claims, the lib starts from `existing` and overlays the
    // scraper's recoupment fields — preserving designation/cap/cost/notes
    // that the scraper doesn't carry.
    // Then clear research wording and premature loss labels, which the
    // validate-data run below would otherwise reject, aborting every entry.
    // The show record comes from keyShow (resolveCommercialSlug above): the show
    // whose slug IS the key, the record validate-data checks it against.
    // Entries that would be held for review are held before any page is fetched: an entry stuck on a hold would
    // otherwise be re-verified (up to the per-run fetch cap) on every run.
    const keyShowRecord = keyShow && keyShow.slug === commercialKey ? keyShow : undefined;
    const publicRecordOptions = { ownerApproved: Boolean(RELEASE_HELD && row.ownerApproved === true) };
    const heldBeforeFetch = sanitizeForPublicRecord(gate.buildCommercialEntry(row, existing, { isClaimAutoApply, mergeExisting, normalizeSources }), keyShowRecord, publicRecordOptions).holdReason;
    if (heldBeforeFetch) {
      console.log(`  🛑 "${showId}" — left pending for review: ${heldBeforeFetch}`);
      noteBlocked(showId, `held before checking: ${heldBeforeFetch}`);
      skipped++;
      continue;
    }
    if (NO_SOURCE_VERIFY && !isClaimAutoApply && (entry.capitalization != null || entry.weeklyRunningCost != null)) {
      console.log(`  ⏭  "${showId}" — has figures that need page verification; left pending for the verified pass (--no-source-verify)`);
      skipped++;
      continue;
    }
    if (!NO_SOURCE_VERIFY && verifyBudget.exceeded()) {
      console.log(`  ⏳ "${showId}" — page-verification time budget used up; left pending for the next run`);
      skipped++;
      continue;
    }
    const figureEvidence = NO_SOURCE_VERIFY ? {} : await verifyEntry(row, keyShow);
    if (figureEvidence.capped) {
      console.log(`  ⏳ "${showId}" — cited pages not checked (per-run fetch cap reached); left pending for the next run`);
      skipped++;
      continue;
    }
    if (VERIFIED_ONLY && !isClaimAutoApply) {
      const outcome = verifiedOutcome(entry, figureEvidence);
      if (outcome.action === 'defer') {
        console.log(`  ⏳ "${showId}" — page-check cap reached; left pending for the next run`);
        skipped++;
        continue;
      }
      if (outcome.action === 'retry') {
        console.log(`  ⏳ "${showId}" — a cited page could not be fetched (attempt ${outcome.attempts} of ${SOURCE_VERIFY_MAX_ATTEMPTS}); left pending`);
        if (!DRY_RUN) { entry.sourceVerifyAttempts = outcome.attempts; pendingDirty = true; }
        skipped++;
        continue;
      }
      if (outcome.action === 'reject') {
        console.log(`  🚫 "${showId}" — not confirmed by a cited page (${outcome.reason}); moving to the rejected log`);
        if (!DRY_RUN) rejectedIds.set(showId, { reason: outcome.reason, archivedReason: UNVERIFIED_REASON, prefix: 'unverified' });
        skipped++;
        continue;
      }
    }
    // A cited page that could not be FETCHED (network, credentials, 4xx/5xx) is not "the page does not confirm
    // the figure": leave the entry pending for a few runs instead of downgrading a figure nobody checked.
    if (figureEvidence.fetchFailed) {
      const { attempts, leavePending } = nextVerifyAttempt(entry);
      if (leavePending) {
        console.log(`  ⏳ "${showId}" — a cited page could not be fetched (attempt ${attempts} of ${SOURCE_VERIFY_MAX_ATTEMPTS}); left pending`);
        if (!DRY_RUN) { entry.sourceVerifyAttempts = attempts; pendingDirty = true; }
        skipped++;
        continue;
      }
      console.log(`  ⚠️  "${showId}" — a cited page could not be fetched on ${attempts} runs; applying its figures as estimates`);
    }
    const { entry: commercialEntry, changed, holdReason } = sanitizeForPublicRecord(
      gate.buildCommercialEntry(row, existing, { isClaimAutoApply, mergeExisting, normalizeSources, figureEvidence }),
      keyShowRecord,
      publicRecordOptions,
    );
    if (holdReason) {
      console.log(`  🛑 "${showId}" — left pending for review: ${holdReason}`);
      noteBlocked(showId, `held after checking: ${holdReason}`);
      skipped++;
      continue;
    }
    if (changed.length) console.log(`  ✂️  "${showId}" — cleared for the public page: ${changed.join(', ')}`);
    if (RELEASE_HELD) {
      // A release fills gaps on the record; it never replaces the record's
      // own public text with research prose (or with nothing, when the
      // research notes were all stripped).
      gate.keepExistingPublicText(commercialEntry, existing);
      // One bad row must not fail validate-data for the whole batch.
      const rowErrors = commercialRecordErrors(commercialKey, commercialEntry, {
        showRecord: keyShowRecord,
        allRecords: commercial.shows,
      });
      if (rowErrors.length) {
        console.log(`  🛑 "${showId}" — left pending for review: ${rowErrors[0]}`);
        skipped++;
        continue;
      }
    }

    commercialEntry.lastUpdated = new Date().toISOString();
    commercialEntry.firstAdded = existing?.firstAdded || new Date().toISOString();

    // Preserve research tracking metadata from existing entry
    if (existing) {
      if (existing.researchAttempts != null) commercialEntry.researchAttempts = existing.researchAttempts;
      if (existing.lastResearchedAt != null) commercialEntry.lastResearchedAt = existing.lastResearchedAt;
      if (existing.researchTrigger != null) commercialEntry.researchTrigger = existing.researchTrigger;
      // BRO-6191: a --show rebuild starts from {}; carry the cleared-field guard's inputs across.
      Object.assign(commercialEntry, carriedClearedGuard(existing, commercialEntry));
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would apply "${showId}" → ${JSON.stringify(commercialEntry)}`);
    } else {
      commercial.shows[commercialKey] = commercialEntry;
      console.log(`  ✅ Applied "${showId}" → commercial.shows["${commercialKey}"] (${commercialEntry.designation || 'TBD'})`);
    }
    appliedIds.add(showId);
    applied++;
  }

  // --verified-only: entries no cited page confirms leave the queue for the archive (written first: a crash between
  // the two writes leaves the entry in both files, and the next run repeats the move).
  if (VERIFIED_ONLY && !DRY_RUN && rejectedIds.size) {
    const { writeArchiveRecord } = require('./lib/commercial-claim-triage');
    const ARCHIVE_PATH = path.join(DATA_DIR, 'commercial-pending-archive.json');
    let archive = { shows: {} };
    try { archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8')); } catch { /* first record */ }
    const nowIso = new Date().toISOString();
    for (const [showId, info] of rejectedIds) {
      writeArchiveRecord(archive, `${info.prefix}:${showId}`, {
        ...pending.shows[showId],
        pendingKey: showId,
        archivedAt: nowIso,
        archivedReason: info.archivedReason,
        archivedDetail: info.reason,
        ownerDigestSentAt: undefined, // leftover stamp of the digest BRO-6471 retired; JSON.stringify drops it
      });
      delete pending.shows[showId];
    }
    archive.lastUpdated = nowIso;
    fs.writeFileSync(ARCHIVE_PATH + '.tmp', JSON.stringify(archive, null, 2) + '\n');
    fs.renameSync(ARCHIVE_PATH + '.tmp', ARCHIVE_PATH);
    pending.lastUpdated = nowIso;
    pendingDirty = true;
    console.log(`📦 Moved ${rejectedIds.size} unconfirmed entr${rejectedIds.size === 1 ? 'y' : 'ies'} to the rejected log`);
  }

  if (!DRY_RUN && applied > 0) {
    // Bump top-level freshness field. health-check.js line 221 reads
    // commercial.json's _meta.lastUpdated to decide whether to flag staleness
    // in the daily digest; without this bump it stayed frozen at the last
    // full-catchup date even though shows were merging cleanly each run.
    commercial._meta = commercial._meta || {};
    commercial._meta.lastUpdated = new Date().toISOString().slice(0, 10);
    saveCommercial(commercial);
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
  } else if (pendingDirty) {
    // Nothing applied, but entries left pending on a fetch failure carry a bumped attempt counter: save it, or
    // the cap would never be reached and every run would retry the same unreachable pages.
    pending.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
    console.log(`📋 Recorded fetch attempts on ${skipped} pending entr${skipped === 1 ? 'y' : 'ies'}; nothing applied`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
