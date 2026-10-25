#!/usr/bin/env node
/**
 * BRO-5344: count aggregator excerpt fields whose leading 8 words are absent
 * from the row's complete stored fullText (paraphrase or another production),
 * by source field and outlet (rows per outlet). verifierExcerpt(data, {skipNonQuotes:true}) skips these.
 *
 *   node scripts/audit-non-quote-excerpts.js [--json] [--dir=<review-texts dir>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);
const { EXCERPT_FIELDS, isQuoteOfFullText } = require('./lib/excerpt-fields');

function scan(dir) {
  const byField = {};
  const byOutlet = {};
  const rows = [];
  let checked = 0;
  for (const show of fs.readdirSync(dir)) {
    const sd = path.join(dir, show);
    let files;
    try { files = fs.readdirSync(sd); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      if (!d || d.contentTier !== 'complete') continue;
      checked++;
      let rowBad = false;
      for (const field of EXCERPT_FIELDS) {
        if (d[field] && !isQuoteOfFullText(d[field], d)) {
          byField[field] = (byField[field] || 0) + 1;
          rowBad = true;
          rows.push({ showId: show, file: f, field });
        }
      }
      if (rowBad) byOutlet[d.outletId || '?'] = (byOutlet[d.outletId || '?'] || 0) + 1;
    }
  }
  return { checked, total: rows.length, byField, byOutlet, rows };
}

module.exports = { scan };

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--dir='));
  const dir = arg ? arg.slice(6) : path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(dir)) { console.error(`no review texts at ${dir}`); process.exit(2); }
  const r = scan(dir);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`complete rows checked: ${r.checked}; non-quote excerpts: ${r.total}`);
  console.log('by field:', JSON.stringify(r.byField));
  const top = Object.entries(r.byOutlet).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('top outlets:', JSON.stringify(top));
}
