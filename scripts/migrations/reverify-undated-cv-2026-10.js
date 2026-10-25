#!/usr/bin/env node
/**
 * One-shot (BRO-4884): re-verify reviews the collector's content verifier
 * flagged wrong production while it was shown TODAY as the review's date.
 *
 * collect-review-texts.js passed `publishDate || textFetchedAt || today` to
 * verifyContent and only read the page's own date afterwards, when saving. For
 * historical link-only stubs (Theatre Record batches) Haiku was told a 2018
 * review was written in 2026 and flagged it ("8 years after the production
 * closed"); the own-venue carve-out then refused it as dated outside the run.
 * lib/verification-publish-date.js fixes the call; this re-runs the verifier
 * on files flagged that way, now with the stored (page-derived) date.
 *
 * Input: JSON array of {file: "<show>/<name>.json"}. A file is touched only
 * when its flag came from the collector LLM, it carries no override, it has
 * text to re-check, and the fresh verdict is fully clean (valid review, not
 * a feature/film, not wrong production; the reverify-era-venue-wrongprod.js
 * rule). Sets wrongProductionOverride + reason/setAt/setBy, keeps the old
 * verdict in contentVerificationPrev, restores fullText from wrongFullText,
 * and adds the tour stand-down when the fresh verdict used the own-venue
 * carve-out (as the collector does).
 *
 * Usage: node scripts/migrations/reverify-undated-cv-2026-10.js <candidates.json> <review-texts-dir> [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { verifyContent, resolveCvMarket } = require('../lib/content-verifier');
const { safeWriteReview } = require('../lib/review-write-guard');
const { tourStopAllowFields } = require('../lib/tour-stop-carveout');

const [candPath, rtDir] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!candPath || !rtDir) { console.error('usage: <candidates.json> <review-texts-dir> [--apply]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
const shows = new Map((raw.shows || raw).map(s => [s.id, s]));
const SET_BY = 'reverify-undated-cv-2026-10';

let cleared = 0, upheld = 0, skipped = 0;
(async () => {
  for (const c of JSON.parse(fs.readFileSync(candPath, 'utf8'))) {
    const [showId] = c.file.split('/');
    const fp = path.join(rtDir, c.file);
    const show = shows.get(showId);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { console.log(`[SKIP] ${c.file}: unreadable`); skipped++; continue; }
    if (!show) { console.log(`[SKIP] ${c.file}: no show row`); skipped++; continue; }
    if (d.wrongProduction !== true || d.wrongProductionOverride === true) { console.log(`[SKIP] ${c.file}: not flagged or already overridden`); skipped++; continue; }
    if (!/^Collector LLM: wrong production/.test(String(d.wrongProductionReason || ''))) { console.log(`[SKIP] ${c.file}: flag is not the collector verifier's`); skipped++; continue; }
    const text = d.fullText || d.wrongFullText || '';
    if (text.trim().length < 200) { console.log(`[SKIP] ${c.file}: no text to re-verify`); skipped++; continue; }
    let fresh;
    try {
      // venue-write-guard-ok: the record's venue is passed to the verifier as context, never written
      fresh = await verifyContent({
        scrapedText: text, showTitle: show.title, criticName: d.criticName || null, outletName: d.outlet || null,
        url: d.url || null, venue: show.venue || null, openingDate: show.openingDate || null,
        publishDate: d.publishDate || null, market: resolveCvMarket(show), show,
      });
    } catch (e) { console.log(`[ERROR] ${c.file}: ${e.message}`); skipped++; continue; }
    const clean = fresh && fresh.isValid === true && fresh.wrongProduction !== true && fresh.wrongArticle !== true
      && fresh.isFilmTv !== true && typeof fresh.verifiedBy === 'string' && fresh.verifiedBy.startsWith('llm');
    if (!clean) {
      console.log(`[UPHELD] ${c.file} (${d.publishDate || 'undated'}) — valid=${fresh && fresh.isValid} wp=${fresh && fresh.wrongProduction} article=${fresh && fresh.wrongArticle} ${String((fresh && fresh.reasoning) || '').slice(0, 140)}`);
      upheld++; continue;
    }
    const updated = {
      ...d,
      contentVerificationPrev: d.contentVerification || null,
      contentVerification: fresh,
      wrongProductionOverride: true,
      wrongProductionOverrideReason: `FP: verifier was shown today's date for an undated stub; re-verified clean with publishDate ${d.publishDate || 'unknown'} (BRO-4884)`,
      wrongProductionOverrideSetAt: new Date().toISOString(),
      wrongProductionOverrideSetBy: SET_BY,
      ...tourStopAllowFields(fresh, d),
    };
    if (!updated.fullText && typeof d.wrongFullText === 'string' && d.wrongFullText.trim().length >= 200) {
      updated.fullText = d.wrongFullText;
      delete updated.wrongFullText;
    }
    console.log(`[${APPLY ? 'CLEARED' : 'WOULD-CLEAR'}] ${c.file} (${d.publishDate || 'undated'})${updated.fullText && !d.fullText ? ' +text restored' : ''}${fresh.tourStopCarveoutApplied ? ' [own-venue]' : ''}`);
    if (APPLY) {
      const res = safeWriteReview(fp, updated, { force: true });
      if (!res || res.wrote === false) { console.log(`  [WRITE-FAILED] ${JSON.stringify(res)}`); continue; }
    }
    cleared++;
  }
  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: cleared=${cleared} upheld=${upheld} skipped=${skipped}`);
})();
