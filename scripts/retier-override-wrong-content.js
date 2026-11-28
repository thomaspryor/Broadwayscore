#!/usr/bin/env node
'use strict';
/**
 * BRO-7944: retier review files whose wrongProduction/wrongShow flag is neutralised by
 * a permanent override (wrongProductionOverride / wrongShowOverride) but still carry
 * contentTier 'invalid' ('Wrong production'/'Wrong show'). Dry-run by default.
 *   node scripts/retier-override-wrong-content.js [--apply] [--dir=data/review-texts]
 */
const fs = require('fs');
const path = require('path');
const { retierStaleWrongContentTier } = require('./lib/stale-wrong-content-tier');
const { readReviewForUpdate } = require('./lib/persist-review-snapshot');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dirArg = (args.find((a) => a.startsWith('--dir=')) || '').slice(6) || path.join(__dirname, '..', 'data', 'review-texts');
const root = fs.realpathSync(dirArg);
const counts = { scanned: 0, candidates: 0, retiered: 0, stillInvalid: 0, byTier: {} };
const touched = [];
for (const show of fs.readdirSync(root)) {
  const sd = path.join(root, show);
  let st; try { st = fs.statSync(sd); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(sd)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const fp = path.join(sd, f);
    let d; try { d = readReviewForUpdate(fp); } catch { continue; } // carries the read snapshot persistReviewSnapshot requires
    counts.scanned++;
    if (d.contentTier !== 'invalid') continue;
    if (!((d.wrongProduction && d.wrongProductionOverride) || (d.wrongShow && d.wrongShowOverride))) continue;
    counts.candidates++;
    const changed = retierStaleWrongContentTier(d);
    if (!changed.length) { counts.stillInvalid++; continue; }
    counts.retiered++;
    counts.byTier[d.contentTier] = (counts.byTier[d.contentTier] || 0) + 1;
    touched.push(`${show}/${f}`);
    if (apply) {
      const { withReviewTextsLock } = require('./lib/review-texts-lock');
      const { persistReviewSnapshot } = require('./lib/persist-review-snapshot');
      withReviewTextsLock(`retier-override:${show}/${f}`, () => persistReviewSnapshot({ filePath: fp, data: d, trailingNewline: true }));
    }
  }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts }, null, 1));
if (process.env.LIST) console.log(touched.join('\n'));
