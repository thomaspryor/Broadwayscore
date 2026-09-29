#!/usr/bin/env node
/**
 * BRO-4385 one-shot corpus sweep: move every automated ("Auto...") wrongProduction
 * clear off wrongProductionManualClear. See lib/automated-clear-not-manual.js.
 *
 *   node scripts/sweep-automated-manual-clears-bro4385.js --dir=<review-texts> [--verdicts=<json>] [--apply]
 *
 * verdicts.json: { "showId/file.json": { "v": "GENUINE"|"OTHER"|"UNSURE", "c": "high|med|low", "ev": "..." } }
 *  - GENUINE (high/med) and flagged  -> real clear via clearWrongProductionFlags (wrongProductionOverride)
 *  - flagged otherwise (or no verdict) -> flag stands (wrongProduction:true), ManualClear removed
 *  - not flagged -> ManualClear demoted to wrongProductionAutoCleared breadcrumb
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { isAutomatedClearStoredAsManual, demoteAutomatedManualClear } = require('./lib/automated-clear-not-manual');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const dir = arg('dir');
const APPLY = process.argv.includes('--apply');
const verdicts = arg('verdicts') ? JSON.parse(fs.readFileSync(arg('verdicts'), 'utf8')) : {};
if (!dir) { console.error('--dir required'); process.exit(1); }
const today = new Date().toISOString().slice(0, 10);
const tally = { demoted: 0, cleared: 0, stays: 0 };

for (const show of fs.readdirSync(dir)) {
  if (show.startsWith('.') || show.startsWith('_')) continue;
  let files; try { files = fs.readdirSync(path.join(dir, show)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, show, f);
    const raw = fs.readFileSync(fp, 'utf8');
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (!isAutomatedClearStoredAsManual(d)) continue;
    const key = `${show}/${f}`;
    const flagged = d.wrongProduction === true || d.contentVerification?.wrongProduction === true;
    const fixO = d.wrongProductionClearReason;
    const vd = verdicts[key];
    if (!flagged) {
      demoteAutomatedManualClear(d, { at: today });
      tally.demoted++;
    } else if (vd && vd.v === 'GENUINE' && vd.c !== 'low') {
      delete d.wrongProductionManualClear; delete d.wrongProductionClearReason;
      clearWrongProductionFlags(d, { source: 'BRO-4385-adjudication', reason: vd.ev });
      d.wrongProductionFixOReason = fixO;
      tally.cleared++;
    } else {
      delete d.wrongProductionManualClear; delete d.wrongProductionClearReason;
      d.wrongProduction = true;
      d.wrongProductionFixOReason = fixO; // history only; not a clear breadcrumb
      d.wrongProductionReviewNote = `BRO-${4385} ${today}: automated Fix O clear revoked${vd ? ` (${vd.v}/${vd.c}: ${vd.ev})` : ''}`;
      tally.stays++;
    }
    if (APPLY) fs.writeFileSync(fp, JSON.stringify(d, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
}
console.log(APPLY ? 'APPLIED' : 'DRY RUN', JSON.stringify(tally));
