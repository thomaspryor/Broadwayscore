#!/usr/bin/env node
/**
 * auto-triage-cross-production.js
 *
 * Conservative auto-triage of cross-production misattributions surfaced by
 * scripts/audit-cross-production.js (data/audit/cross-production-audit.json).
 *
 * Sets wrongProduction=true ONLY on items that have a concrete reassignment
 * target (closerTo) AND a positive signal (matchReason !== 'ambiguous'). The
 * audit identified a DIFFERENT production whose opening date / URL year the
 * review clearly belongs to, so excluding it from the production it is filed
 * under is safe and correct.
 *
 * It NEVER touches the "ambiguous" bucket (confidence:low, closerTo:null) —
 * those reviews have NO positive signal of misattribution (no parseable date,
 * no URL-year match, no venue match). Auto-flagging them would corrupt the
 * corpus by excluding legitimate reviews. The audit's own author deliberately
 * records but does not claim them. By default we also exclude medium-confidence
 * (venue-only) items, which are dominated by same-staging transfer cases (e.g.
 * Royal Court → West End) that need human eyes; pass --include-medium to flag
 * those too.
 *
 * NOTE on the prompt's "8 protection fields": those (wrongProductionManualClear,
 * allowEarlyDate, etc.) are for CLEARING a review and protecting it from being
 * re-flagged. Here we do the OPPOSITE — we SET wrongProduction=true. The
 * canonical durable shape for SETTING it (mirrored from the date-based setter
 * in rebuild-all-reviews.js:2319) is:
 *     wrongProduction       = true
 *     wrongProductionReason = '<breadcrumb>'   // hasManualReason gate keeps the
 *                                              // flag through rebuild auto-clear
 *                                              // passes (rebuild:1932/2154)
 *     wrongProductionNote   = '<human detail>'
 * We also stamp wrongProductionDetectedBy / At for provenance.
 *
 * We refuse to flag any review a human has explicitly approved
 * (wrongProductionManualClear / wrongProductionOverride /
 * humanReviewedWrongProduction===false / allowEarlyDate / allowCrossMarket) so
 * this can never override a manual decision.
 *
 * Usage:
 *   node scripts/auto-triage-cross-production.js            # dry-run (default, no writes)
 *   node scripts/auto-triage-cross-production.js --apply    # write the flags
 *   node scripts/auto-triage-cross-production.js --include-medium
 *   node scripts/auto-triage-cross-production.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const INCLUDE_MEDIUM = ARGS.includes('--include-medium');
const OUT_JSON = ARGS.includes('--json');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'cross-production-audit.json');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const SUMMARY_PATH = path.join(REPO_ROOT, 'data', 'audit', 'auto-triage-cross-production.json');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(AUDIT_PATH)) {
  fail(`audit file not found: ${AUDIT_PATH}\n  Run: node scripts/audit-cross-production.js first.`);
}

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
const issues = Array.isArray(audit.issues) ? audit.issues : [];

// ── Conservative auto-fixable filter ─────────────────────────────────────────
// A real reassignment target (closerTo) AND a positive signal (not ambiguous).
// confidence:high always qualifies; medium (venue-only) is opt-in via flag.
const allowedConfidence = INCLUDE_MEDIUM ? new Set(['high', 'medium']) : new Set(['high']);
const candidates = issues.filter(i =>
  i.closerTo &&
  i.matchReason && i.matchReason !== 'ambiguous' &&
  allowedConfidence.has(i.confidence)
);

console.log(`Audit: ${issues.length} total issues, ${issues.filter(i => i.closerTo).length} with a reassignment target.`);
console.log(`Auto-fixable under filter (closerTo + matchReason!=ambiguous + confidence in {${[...allowedConfidence].join(',')}}): ${candidates.length}\n`);

const nowIso = new Date().toISOString();

const flagged = [];
const skipped = [];
const missing = [];

for (const issue of candidates) {
  const filePath = path.join(REVIEW_TEXTS_DIR, issue.file);
  if (!fs.existsSync(filePath)) {
    missing.push(issue.file);
    continue;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    skipped.push({ file: issue.file, reason: `parse-error: ${e.message}` });
    continue;
  }

  // Already flagged — idempotent no-op.
  if (data.wrongProduction === true) {
    skipped.push({ file: issue.file, reason: 'already-wrongProduction' });
    continue;
  }

  // NEVER override an explicit human approval / clear.
  if (
    data.wrongProductionManualClear === true ||
    data.wrongProductionOverride === true ||
    data.humanReviewedWrongProduction === false ||
    data.allowEarlyDate === true ||
    data.allowCrossMarket === true
  ) {
    skipped.push({ file: issue.file, reason: 'human-approved/cleared' });
    continue;
  }

  const note =
    `Auto-triage: ${issue.matchReason} (${issue.confidence}) signal — review belongs to ${issue.closerTo}` +
    `${issue.closerToOpening ? ` (opened ${issue.closerToOpening})` : ''}` +
    `, not ${issue.filedUnder}` +
    `${issue.filedUnderOpening ? ` (opened ${issue.filedUnderOpening})` : ''}.` +
    `${issue.publishDate ? ` publishDate=${issue.publishDate}.` : ''}` +
    `${issue.urlYear != null ? ` urlYear=${issue.urlYear}.` : ''}` +
    `${issue.hasDupeInCorrectDir ? ' Duplicate already filed in target dir.' : ''}`;

  data.wrongProduction = true;
  data.wrongProductionReason = 'cross-production-audit';
  data.wrongProductionNote = note;
  data.wrongProductionDetectedBy = 'auto-triage-cross-production';
  data.wrongProductionDetectedAt = nowIso;

  if (APPLY) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  flagged.push({
    file: issue.file,
    filedUnder: issue.filedUnder,
    closerTo: issue.closerTo,
    matchReason: issue.matchReason,
    confidence: issue.confidence,
    hasDupeInCorrectDir: !!issue.hasDupeInCorrectDir,
  });
}

const affectedShows = [...new Set(flagged.map(f => f.filedUnder))].sort();

// ── Report ───────────────────────────────────────────────────────────────────
if (OUT_JSON) {
  console.log(JSON.stringify({
    apply: APPLY, includeMedium: INCLUDE_MEDIUM,
    flagged: flagged.length, skipped: skipped.length, missing: missing.length,
    affectedShows, flaggedItems: flagged,
  }, null, 2));
} else {
  console.log(`${APPLY ? 'FLAGGED' : 'WOULD FLAG'} ${flagged.length} review(s):\n`);
  for (const f of flagged) {
    console.log(`  ${f.file}`);
    console.log(`    -> belongs to ${f.closerTo}  [${f.confidence}/${f.matchReason}]${f.hasDupeInCorrectDir ? ' (dupe in target dir)' : ''}`);
  }
  console.log(`\nAffected shows (${affectedShows.length}): ${affectedShows.join(', ')}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    const byReason = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    for (const [r, n] of Object.entries(byReason)) console.log(`  ${n}  ${r}`);
  }
  if (missing.length) console.log(`\nMissing files (${missing.length}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
}

// Always write a machine-readable summary (audit trail + feeds the rebuild step).
const summary = {
  generatedAt: nowIso,
  apply: APPLY,
  includeMedium: INCLUDE_MEDIUM,
  auditTimestamp: audit.timestamp || null,
  counts: { flagged: flagged.length, skipped: skipped.length, missing: missing.length },
  affectedShows,
  flagged,
  skipped,
  missing,
};
fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n');
console.log(`\nWrote ${path.relative(REPO_ROOT, SUMMARY_PATH)}`);

if (!APPLY) {
  console.log('\nDry-run only — no review files modified. Re-run with --apply to write flags.');
}
