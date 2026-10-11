#!/usr/bin/env node
/**
 * One-shot (BRO-4884): clear wrongProduction flags that the content verifier
 * set on reviews of a touring production's stop at the record's OWN venue
 * (Curtains 2019 at Wyndham's, Two Halves of Guinness at Park Theatre, ...).
 * The verifier now decides this in code (lib/tour-stop-carveout.js); this
 * clears the flags written before that landed.
 *
 * Input: a hand-reviewed JSON array of {show, file, reviewedVenue}. Each file
 * is re-checked with the same carve-out against its stored reason before it
 * is touched. Sets wrongProductionOverride + reason/setAt/setBy (the
 * reverify-era-venue-wrongprod.js precedent) and allowTourSignal (the text
 * scan's own stand-down), keeps the old verdict in
 * contentVerificationPrev, and restores fullText from wrongFullText when the
 * flag had moved it aside.
 *
 * Usage: node scripts/migrations/clear-own-venue-tour-fps-2026-10.js <candidates.json> <review-texts-dir> [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { applyOwnVenueTourCarveout } = require('../lib/tour-stop-carveout');
const { safeWriteReview } = require('../lib/review-write-guard');
const { contaminationAllowFields } = require('../lib/contamination-allow-signal');

const [candPath, rtDir] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!candPath || !rtDir) { console.error('usage: <candidates.json> <review-texts-dir> [--apply]'); process.exit(2); }
const showsFile = path.join(__dirname, '..', '..', 'data', 'shows.json');
const raw = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
const shows = new Map((raw.shows || raw).map(s => [s.id, s]));

let cleared = 0, skipped = 0;
for (const c of JSON.parse(fs.readFileSync(candPath, 'utf8'))) {
  const fp = path.join(rtDir, c.show, c.file);
  const show = shows.get(c.show);
  let d;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { console.log(`[SKIP] ${c.show}/${c.file}: unreadable`); skipped++; continue; }
  const ours = d.wrongProductionOverrideSetBy === 'clear-own-venue-tour-fps-2026-10';
  if (ours && d.allowTourSignal !== true) {
    // First pass (2026-10-11) set the override but not the text-scan stand-down.
    const topped = { ...d, ...contaminationAllowFields('tour', d.wrongProductionOverrideReason) };
    console.log(`[${APPLY ? 'TOPPED-UP' : 'WOULD-TOP-UP'}] ${c.show}/${c.file}: allowTourSignal`);
    if (APPLY) safeWriteReview(fp, topped, { force: true });
    cleared++; continue;
  }
  if (d.wrongProduction !== true || d.wrongProductionOverride === true) { console.log(`[SKIP] ${c.show}/${c.file}: not flagged or already overridden`); skipped++; continue; }
  const reason = [d.wrongProductionReason, d.wrongProductionNote, d.contentTierReason].filter(Boolean).join(' ');
  if (/URL-path cross-market/i.test(reason)) { console.log(`[SKIP] ${c.show}/${c.file}: flag is a URL cross-market verdict, not a tour verdict`); skipped++; continue; }
  const v = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: reason, reviewedVenue: c.reviewedVenue }, show, { publishDate: d.publishDate });
  if (!v.tourStopCarveoutApplied) { console.log(`[UPHELD] ${c.show}/${c.file}`); skipped++; continue; }
  const updated = {
    ...d,
    contentVerificationPrev: d.contentVerification || null,
    wrongProductionOverride: true,
    wrongProductionOverrideReason: `FP: tour stop at this record's own venue (${show.venue}); critic attended "${c.reviewedVenue}" (BRO-4884)`,
    wrongProductionOverrideSetAt: new Date().toISOString(),
    wrongProductionOverrideSetBy: 'clear-own-venue-tour-fps-2026-10',
    // The fullText tour scan (review-guards explainExclusion) reads this, not the override.
    ...contaminationAllowFields('tour', `own-venue tour stop: critic attended "${c.reviewedVenue}" (BRO-4884)`),
  };
  if (!updated.fullText && typeof d.wrongFullText === 'string' && d.wrongFullText.trim().length >= 200) {
    updated.fullText = d.wrongFullText;
    delete updated.wrongFullText;
  }
  console.log(`[${APPLY ? 'CLEARED' : 'WOULD-CLEAR'}] ${c.show}/${c.file} (${c.reviewedVenue})${updated.fullText && !d.fullText ? ' +text restored' : ''}`);
  if (APPLY) {
    const res = safeWriteReview(fp, updated, { force: true });
    if (!res || res.wrote === false) { console.log(`  [WRITE-FAILED] ${JSON.stringify(res)}`); continue; }
  }
  cleared++;
}
console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: cleared=${cleared} skipped=${skipped}`);
