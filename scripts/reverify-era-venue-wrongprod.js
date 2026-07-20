#!/usr/bin/env node
/**
 * One-shot: re-verify wrongProduction flags on pre-rename Broadway shows.
 *
 * Context (card 39c637c5-416f-8181-aa4c-cf10c56a02a1): 333 shows.json entries
 * carry a renamed theater's CURRENT name for runs that predate the rename, so
 * CV flagged genuine reviews naming the era-accurate venue ("Virginia
 * Theatre") as wrongProduction. venue-aliases.js now carries the 11 renamed
 * Broadway houses, so the CV prompt explains the rename — this script re-runs
 * verifyContent on the affected flagged files and clears the flag ONLY when
 * the fresh, alias-aware verdict says the review is valid and not
 * wrongProduction. Mirrors clear-we-longrunner-fps-2026-04-24.js (the WE
 * venue-rename precedent): sets wrongProductionOverride + reason/setAt/setBy,
 * preserves the old CV block in contentVerificationPrev.
 *
 * Input: a JSON array of {show, file} candidates (era-name probe output).
 *
 * Usage (from anywhere; data paths are absolute to the main repo):
 *   node scripts/reverify-era-venue-wrongprod.js --candidates=/path/to.json --limit=5          # dry-run
 *   node scripts/reverify-era-venue-wrongprod.js --candidates=/path/to.json --limit=5 --apply
 *   node scripts/reverify-era-venue-wrongprod.js --candidates=/path/to.json --apply            # full run
 *
 * Env: ANTHROPIC_API_KEY (content-verifier Haiku primary).
 */

const fs = require('fs');
const path = require('path');
const { verifyContent } = require('./lib/content-verifier');
const { safeWriteReview } = require('./lib/review-write-guard');

const MAIN_REPO = '/Users/tompryor/Broadwayscore';
const REVIEW_TEXTS_DIR = path.join(MAIN_REPO, 'data', 'review-texts');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CANDIDATES_PATH = (args.find(a => a.startsWith('--candidates=')) || '').split('=')[1];

if (!CANDIDATES_PATH) { console.error('--candidates=<path.json> required'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const candidates = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
const showsData = JSON.parse(fs.readFileSync(path.join(MAIN_REPO, 'data/shows.json'), 'utf8'));
const showsMap = new Map();
for (const s of (showsData.shows || showsData)) showsMap.set(s.id, s);

(async () => {
  let processed = 0, cleared = 0, upheld = 0, skipped = 0, errors = 0;
  const results = [];

  for (const c of candidates) {
    if (LIMIT && processed >= LIMIT) break;
    const fp = path.join(REVIEW_TEXTS_DIR, c.show, c.file);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { skipped++; continue; }

    // Only top-level wrongProduction drives exclusion (isIncludableForRebuild);
    // skip files already cleared or flagged some other way.
    if (d.wrongProduction !== true) { skipped++; continue; }
    if (d.wrongProductionOverride === true || d.wrongProductionManualClear === true
        || d.humanReviewedWrongProduction === false) { skipped++; continue; }
    if (!d.fullText || d.fullText.trim().length < 200) { skipped++; continue; }

    const show = showsMap.get(c.show);
    if (!show) { skipped++; continue; }
    processed++;

    let cv;
    try {
      cv = await verifyContent({
        scrapedText: d.fullText,
        showTitle: show.title,
        criticName: d.criticName || null,
        outletName: d.outlet || null,
        url: d.url || null,
        venue: show.venue || null,
        openingDate: show.openingDate || null,
        publishDate: d.publishDate || null,
        market: show.category || 'broadway',
      });
    } catch (e) {
      errors++;
      console.log(`[ERROR] ${c.show}/${c.file}: ${e.message}`);
      continue;
    }

    const clean = cv && cv.isValid === true && cv.wrongProduction !== true;
    console.log(`[${clean ? 'CLEAR-CANDIDATE' : 'UPHELD'}] ${c.show}/${c.file} — isValid=${cv?.isValid} wp=${cv?.wrongProduction} ${String(cv?.reasoning || '').slice(0, 120)}`);
    results.push({ show: c.show, file: c.file, clean, reasoning: cv?.reasoning || '' });

    if (!clean) { upheld++; continue; }
    if (!APPLY) { cleared++; continue; }

    const updated = {
      ...d,
      contentVerificationPrev: d.contentVerification || null,
      contentVerification: cv,
      wrongProductionOverride: true,
      wrongProductionOverrideReason: `FP: era-venue rename (${show.venue}); alias-aware CV re-verdict: ${String(cv.reasoning || '').slice(0, 300)}`,
      wrongProductionOverrideSetAt: new Date().toISOString(),
      wrongProductionOverrideSetBy: 'reverify-era-venue-wrongprod',
    };
    const res = safeWriteReview(fp, updated);
    if (res && res.wrote) {
      cleared++;
    } else {
      errors++;
      console.log(`[WRITE-FAILED] ${c.show}/${c.file}: ${JSON.stringify(res)}`);
    }
  }

  fs.writeFileSync('/tmp/reverify-era-venue-results.json', JSON.stringify(results, null, 2));
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: processed=${processed} clear=${cleared} upheld=${upheld} skipped=${skipped} errors=${errors}`);
  console.log('Per-file verdicts: /tmp/reverify-era-venue-results.json');
})();
