#!/usr/bin/env node
/**
 * BRO-7957: move persisted syndication flags to the market-aware primacy for Chris Jones.
 * On a NYC-era show (syndication-pairs.js marketPrimacyOverride) with a SAME-TEXT pair, the NY Daily News file ships
 * and the Chicago Tribune file is the flagged duplicate. A pair whose text or publish date differs is left alone
 * (pre-2024 differing-text pairs, e.g. downstate-2026's 2018 Tribune file, are different reviews).
 *
 * Usage: node scripts/migrate-chris-jones-nyc-primacy.js [--apply] [--show=ID]   (default: dry run)
 */
const fs = require('fs');
const path = require('path');
const { marketPrimacyOverride } = require('./lib/syndication-pairs');
const { trigramSimilarity } = require('./lib/trigram-similarity');

const SIM_MIN = 50;
const _day = (d) => { const t = Date.parse(String(d || '')); return Number.isNaN(t) ? null : Math.floor(t / 864e5); };

/**
 * Decide the flag move for one (Daily News, Tribune) pair. Pure.
 * @returns {{action:'flip'|'skip', reason:string, sim:number}}
 */
function planPair(ny, tr, show, trFile) {
  const ovr = marketPrimacyOverride('Chris Jones', show);
  if (!ovr) return { action: 'skip', reason: 'not a NYC-era show', sim: 0 };
  const sim = trigramSimilarity(ny.fullText, tr.fullText);
  // The detector flagged this Daily News file as the copy of THIS Tribune file (it measured >= 50% then): a primacy
  // artifact the new rule reverses, even if a later re-extraction moved the similarity.
  const flaggedAsCopyOfThis = !!ny.isSyndicatedDuplicate && !!trFile && String(ny.syndicatedPrimaryFile || '').endsWith(`/${trFile}`) ;
  if (sim < SIM_MIN && !flaggedAsCopyOfThis) return { action: 'skip', reason: `different text (sim ${sim})`, sim };
  const dn = _day(ny.publishDate), dt = _day(tr.publishDate);
  if (dn !== null && dt !== null && Math.abs(dn - dt) > 3) return { action: 'skip', reason: 'publish dates differ', sim };
  return { action: 'flip', reason: flaggedAsCopyOfThis ? 'flagged copy of this file' : 'same text', sim };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const only = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1];
  const root = path.join(__dirname, '..');
  const { safeWriteReview } = require('./lib/review-write-guard');
  const { executeReviewFieldEditIn } = require('./lib/review-field-edit');
  const shows = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
  const byId = Object.fromEntries((shows.shows || shows).map((s) => [s.id, s]));
  const R = path.join(root, 'data/review-texts');
  const tally = { flip: 0, skip: 0, written: 0 };
  for (const id of fs.readdirSync(R)) {
    if (only && id !== only) continue;
    let files; try { files = fs.readdirSync(path.join(R, id)); } catch { continue; }
    const nyF = files.filter((f) => /^nydailynews--chris-jones(-\d+)?\.json$/.test(f));
    const trF = files.filter((f) => /^chicagotribune--chris-jones(-[a-z0-9-]+)?\.json$/.test(f));
    if (!nyF.length || !trF.length || !marketPrimacyOverride('Chris Jones', byId[id])) continue;
    for (const nf of nyF) {
      const nPath = path.join(R, id, nf);
      const ny = JSON.parse(fs.readFileSync(nPath, 'utf8'));
      // One-shot and idempotent: only a Daily News file still flagged as the copy is reversed. An unflagged pair is the
      // runtime rule's (and the detector's) to handle; re-flagging here could undo a later heal.
      if (!ny.isSyndicatedDuplicate) continue;
      // the Tribune file that is the same article (a show can hold several Jones files: previews, re-reviews)
      let best = null;
      for (const tf of trF) {
        const tPath = path.join(R, id, tf);
        const tr = JSON.parse(fs.readFileSync(tPath, 'utf8'));
        const plan = planPair(ny, tr, byId[id], tf);
        if (plan.action === 'flip' && (!best || plan.sim > best.plan.sim)) best = { tf, tPath, tr, plan };
      }
      if (!best) { tally.skip++; console.log(`SKIP ${id}/${nf}: no same-text Tribune pair`); continue; }
      // The Daily News file must itself survive the gates once its flag is gone, or flagging the Tribune copy drops both.
      const { explainExclusion } = require('./lib/review-guards');
      const why = explainExclusion({ ...ny, isSyndicatedDuplicate: false, syndicatedPrimaryFile: undefined }, byId[id], path.join(R, id, nf), { ignoreKnownSyndication: true });
      if (why) { tally.skip++; console.log(`SKIP ${id}/${nf}: Daily News copy would not ship (${why})`); continue; }
      tally.flip++;
      console.log(`${apply ? 'FLIP' : 'WOULD FLIP'} ${id}: ${nf} primary, ${best.tf} duplicate (sim ${best.plan.sim}, was-flagged ${!!ny.isSyndicatedDuplicate})`);
      if (!apply) continue;
      // The Daily News flag is protected: it clears only through the sanctioned field edit (review-field-edit.js
      // syndicationPrimacyFlip), not a plain write (the merge restores it).
      if (ny.isSyndicatedDuplicate || ny.syndicatedPrimaryFile) {
        const stamp = { fixId: 'bro-7957', at: new Date().toISOString() };
        const edits = [['isSyndicatedDuplicate', true, false], ['syndicatedPrimaryFile', ny.syndicatedPrimaryFile, null]]
          .filter(([f, o]) => (f === 'isSyndicatedDuplicate' ? ny.isSyndicatedDuplicate : typeof o === 'string'));
        let failed = false;
        for (const [field, oldValue, newValue] of edits) {
          const r = executeReviewFieldEditIn(R, { file: `${id}/${nf}`, field, oldValue, newValue }, stamp);
          if (!r.ok) { console.log(`  FAILED ${id}/${nf} ${field}: ${r.reason}`); tally.failed = (tally.failed || 0) + 1; failed = true; }
        }
        if (failed) continue; // never leave BOTH copies flagged (both would drop off the site)
      }
      best.tr.isSyndicatedDuplicate = true;
      best.tr.syndicatedPrimaryFile = `${id}/${nf}`;
      best.tr.syndicationSimilarity = best.plan.sim;
      safeWriteReview(best.tPath, best.tr);
      tally.written += 2;
    }
  }
  console.log(JSON.stringify(tally));
}

if (require.main === module) main();
module.exports = { planPair };
