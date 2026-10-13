#!/usr/bin/env node
'use strict';
/**
 * inspect-review-files.js — read-only: print the metadata of review-text files
 * for one or more shows (file, outlet, critic, publishDate, dateSource, url,
 * verdict flags, 160 chars of text). Built for cloud sessions that have no
 * data/review-texts clone and read it through cloud-run-script.js (BRO-5239).
 *
 *   node scripts/inspect-review-files.js --show=a,b [--outlet=x,y] [--file=sub]
 */
const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);

const ARGV = process.argv.slice(2);
const val = (n) => { const a = ARGV.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3).split(',') : null; };
const shows = val('show');
const outlets = val('outlet');
const fileSub = val('file');
if (!shows) { console.error('usage: inspect-review-files.js --show=a,b [--outlet=x] [--file=sub]'); process.exit(2); }

const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.error('data/review-texts missing'); process.exit(3); }
const FLAGS = ['wrongProduction', 'wrongProductionReason', 'wrongProductionManualClear', 'wrongProductionOverride', 'allowEarlyDate', 'isRoundupArticle', 'isNonReview', 'wrongShow', 'dateSource', 'duplicateOf'];
for (const show of shows) {
  const dir = path.join(root, show);
  if (!fs.existsSync(dir)) { console.log(`## ${show}: no directory`); continue; }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    if (fileSub && !fileSub.some((s) => f.includes(s))) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (outlets && !outlets.includes(r.outletId)) continue;
    const flags = {};
    for (const k of FLAGS) if (r[k] !== undefined && r[k] !== null && r[k] !== false) flags[k] = r[k];
    console.log(JSON.stringify({
      show, file: f, outletId: r.outletId, critic: r.criticName, pub: r.publishDate,
      url: r.url, flags, text: String(r.fullText || '').replace(/\s+/g, ' ').slice(0, 160),
    }));
  }
}
