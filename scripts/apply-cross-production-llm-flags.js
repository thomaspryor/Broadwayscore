#!/usr/bin/env node
/**
 * apply-cross-production-llm-flags.js
 *
 * Applies wrongProduction=true to review-text files based on the Opus verdicts
 * in data/audit/cross-production-classified.json (produced by
 * classify-wrong-production.js over the cross-production ambiguous bucket).
 *
 * CONSERVATIVE auto-apply rule — ONLY flags a review when ALL hold:
 *   - verdict === 'WRONG_PRODUCTION' && confidence === 'high'
 *   - targetShowId is set AND is a REAL existing show in shows.json
 *     (the review demonstrably belongs to another production we know about —
 *     the strongest, most verifiable signal)
 *
 * It HOLDS (reports, never auto-applies) every WRONG verdict with no concrete
 * target (targetShowId null). Those are a mix of genuine wrong-show / TV-broadcast
 * contamination AND continuous-run ambiguities (e.g. hamilton-west-end-2021,
 * whose Victoria Palace run has been continuous since 2017 — a 2017-origin review
 * there is debatable, not clearly misfiled). Those need a human eye.
 *
 * Never overrides a human clear (manualClear/override/humanReviewed/allowEarly
 * Date/allowCrossMarket) and is idempotent (skips already-wrongProduction).
 *
 * Flag shape mirrors the canonical durable setter: wrongProduction +
 * wrongProductionReason (the breadcrumb that survives rebuild auto-clear) + note.
 *
 * Usage:
 *   node scripts/apply-cross-production-llm-flags.js           # dry-run (default)
 *   node scripts/apply-cross-production-llm-flags.js --apply   # write flags
 *   node scripts/apply-cross-production-llm-flags.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const OUT_JSON = ARGS.includes('--json');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLASSIFIED = path.join(REPO_ROOT, 'data', 'audit', 'cross-production-classified.json');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const SUMMARY_PATH = path.join(REPO_ROOT, 'data', 'audit', 'apply-cross-production-llm-flags.json');

if (!fs.existsSync(CLASSIFIED)) {
  console.error(`ERROR: ${CLASSIFIED} not found — run classify-wrong-production.js over the cross-production input first.`);
  process.exit(1);
}

const validShowIds = new Set(require(path.join(REPO_ROOT, 'data', 'shows.json')).shows.map(s => s.id));
const verdicts = (require(CLASSIFIED).results || []);

const wrongHigh = verdicts.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'high');
const applicable = wrongHigh.filter(r => r.targetShowId && validShowIds.has(r.targetShowId));
const heldNoTarget = wrongHigh.filter(r => !r.targetShowId);
const heldBadTarget = wrongHigh.filter(r => r.targetShowId && !validShowIds.has(r.targetShowId));

const nowIso = new Date().toISOString();
const flagged = [], skipped = [], missing = [];

for (const r of applicable) {
  const filePath = path.join(REVIEW_TEXTS_DIR, r.showId, r.file);
  if (!fs.existsSync(filePath)) { missing.push(`${r.showId}/${r.file}`); continue; }

  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { skipped.push({ file: `${r.showId}/${r.file}`, reason: `parse-error` }); continue; }

  if (data.wrongProduction === true) { skipped.push({ file: `${r.showId}/${r.file}`, reason: 'already-wrongProduction' }); continue; }
  if (
    data.wrongProductionManualClear === true || data.wrongProductionOverride === true ||
    data.humanReviewedWrongProduction === false || data.allowEarlyDate === true || data.allowCrossMarket === true
  ) { skipped.push({ file: `${r.showId}/${r.file}`, reason: 'human-approved/cleared' }); continue; }

  data.wrongProduction = true;
  data.wrongProductionReason = 'cross-production-llm-verified';
  data.wrongProductionNote = `LLM (Opus) verified this review belongs to ${r.targetShowId}, not ${r.showId}. ${r.reasoning || ''}`.trim();
  data.wrongProductionTarget = r.targetShowId;
  data.wrongProductionDetectedBy = 'classify-wrong-production:opus';
  data.wrongProductionDetectedAt = nowIso;

  if (APPLY) fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  flagged.push({ file: `${r.showId}/${r.file}`, target: r.targetShowId, reasoning: r.reasoning });
}

const affectedShows = [...new Set(flagged.map(f => f.file.split('/')[0]))].sort();

if (OUT_JSON) {
  console.log(JSON.stringify({ apply: APPLY, flagged, skipped, missing, heldNoTarget: heldNoTarget.length, heldBadTarget: heldBadTarget.length, affectedShows }, null, 2));
} else {
  console.log(`WRONG-high verdicts: ${wrongHigh.length}  (applicable w/ real target: ${applicable.length}, held target=null: ${heldNoTarget.length}, held invalid target: ${heldBadTarget.length})\n`);
  console.log(`${APPLY ? 'FLAGGED' : 'WOULD FLAG'} ${flagged.length} review(s) across ${affectedShows.length} shows:\n`);
  for (const f of flagged) console.log(`  ${f.file}  ->  ${f.target}`);
  if (skipped.length) {
    const by = {}; for (const s of skipped) by[s.reason] = (by[s.reason] || 0) + 1;
    console.log(`\nSkipped ${skipped.length}: ${JSON.stringify(by)}`);
  }
  if (missing.length) console.log(`\nMissing files: ${missing.length}`);
  console.log(`\nHELD for human review (${heldNoTarget.length} target=null — wrong-show/TV/continuous-run mix). See summary JSON.`);
}

fs.writeFileSync(SUMMARY_PATH, JSON.stringify({
  generatedAt: nowIso, apply: APPLY,
  counts: { wrongHigh: wrongHigh.length, applicable: applicable.length, flagged: flagged.length,
    skipped: skipped.length, missing: missing.length, heldNoTarget: heldNoTarget.length, heldBadTarget: heldBadTarget.length },
  affectedShows, flagged, skipped, missing,
  held: heldNoTarget.map(r => ({ file: `${r.showId}/${r.file}`, reasoning: r.reasoning })),
}, null, 2) + '\n');
console.log(`\nWrote ${path.relative(REPO_ROOT, SUMMARY_PATH)}`);
if (!APPLY) console.log('Dry-run only — no files modified. Re-run with --apply to write.');
