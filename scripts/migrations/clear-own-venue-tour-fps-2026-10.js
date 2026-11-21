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
 * --reverify: also re-run verifyContent (with the carve-out) on the file's
 * text and clear only on a fully clean verdict (valid review, not a
 * feature/film, not wrong production), the reverify-era-venue-wrongprod.js
 * rule. Used for the wider own-venue sweep, where the stored objection is
 * not always about touring.
 *
 * Usage: node scripts/migrations/clear-own-venue-tour-fps-2026-10.js <candidates.json> <review-texts-dir> [--apply] [--reverify]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { applyOwnVenueTourCarveout } = require('../lib/tour-stop-carveout');
const { safeWriteReview } = require('../lib/review-write-guard');
const { contaminationAllowFields } = require('../lib/contamination-allow-signal');

const [candPath, rtDir] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
const REVERIFY = process.argv.includes('--reverify');
if (!candPath || !rtDir) { console.error('usage: <candidates.json> <review-texts-dir> [--apply]'); process.exit(2); }
const showsFile = path.join(__dirname, '..', '..', 'data', 'shows.json');
const raw = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
const shows = new Map((raw.shows || raw).map(s => [s.id, s]));

let cleared = 0, skipped = 0;
(async () => {
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
  // Re-check the stored flag (true here, checked above) with the carve-out; nothing is set.
  const v = applyOwnVenueTourCarveout({ wrongProduction: d.wrongProduction, reasoning: reason, reviewedVenue: c.reviewedVenue }, show, { publishDate: d.publishDate });
  if (!v.tourStopCarveoutApplied) { console.log(`[UPHELD] ${c.show}/${c.file}`); skipped++; continue; }
  let fresh = null;
  if (REVERIFY) {
    const text = d.fullText || d.wrongFullText || '';
    if (text.trim().length < 200) { console.log(`[SKIP] ${c.show}/${c.file}: no text to re-verify`); skipped++; continue; }
    try {
      // venue-write-guard-ok: the record's venue is passed to the verifier as context, never written
      fresh = await require('../lib/content-verifier').verifyContent({
        scrapedText: text, showTitle: show.title, criticName: d.criticName || null, outletName: d.outlet || null,
        url: d.url || null, venue: show.venue || null, openingDate: show.openingDate || null,
        publishDate: d.publishDate || null, market: show.category || 'west-end', show,
      });
    } catch (e) { console.log(`[ERROR] ${c.show}/${c.file}: ${e.message}`); skipped++; continue; }
    const clean = fresh && fresh.isValid === true && fresh.wrongProduction !== true && fresh.wrongArticle !== true
      && fresh.isFilmTv !== true && typeof fresh.verifiedBy === 'string' && fresh.verifiedBy.startsWith('llm');
    if (!clean) {
      console.log(`[UPHELD-REVERIFY] ${c.show}/${c.file} — valid=${fresh && fresh.isValid} wp=${fresh && fresh.wrongProduction} article=${fresh && fresh.wrongArticle} ${String((fresh && fresh.reasoning) || '').slice(0, 110)}`);
      skipped++; continue;
    }
  }
  const updated = {
    ...d,
    contentVerificationPrev: d.contentVerification || null,
    ...(fresh ? { contentVerification: fresh } : {}),
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
})();
