#!/usr/bin/env node
/**
 * strip-leading-site-nav.js — cut site navigation menus (and the Stage and
 * Cinema share/donate footer) from stored review texts (BRO-5859). Rules live
 * in scripts/lib/text-cleaning.js (stripLeadingSiteNav, SITE_FOOTER_PATTERNS),
 * which every collector now applies at fetch time through stripTrailingJunk.
 *
 * A menu holds no verdict, so no rescore is queued; a pull quote that no longer
 * appears in the text is cleared. Runs in CI only (review texts are private):
 *   data/pending-fixes run-script action: args "--apply"
 *
 * Usage:
 *   node scripts/strip-leading-site-nav.js            dry run: rows it would change
 *   node scripts/strip-leading-site-nav.js --apply    write through safeWriteReview
 *     --files=a/x.json,b/y.json                        only these rows (show/file)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { stripRecord } = require('./lib/site-nav-record');
const { classifyContentTier } = require('./lib/content-quality');
const { safeWriteReview } = require('./lib/review-write-guard');

if (hasHelpFlag(process.argv)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 15).map(l => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}

const DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const filesArg = (process.argv.find(a => a.startsWith('--files=')) || '').slice(8);
const only = filesArg ? new Set(filesArg.split(',').filter(Boolean)) : null;

function main() {
  const at = new Date().toISOString();
  let changed = 0, failed = 0, tierShift = 0;
  const byHost = {};
  for (const showId of listShowDirs(DIR)) {
    const showDir = path.join(DIR, showId);
    for (const f of fs.readdirSync(showDir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const rel = `${showId}/${f}`;
      if (only && !only.has(rel)) continue;
      const file = path.join(showDir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const out = stripRecord(d, at);
      if (!out) continue;
      changed++;
      const host = (d.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || '?';
      byHost[host] = (byHost[host] || 0) + 1;
      const tierBefore = classifyContentTier(d).contentTier;
      const tierAfter = classifyContentTier(out).contentTier;
      const shift = tierBefore !== tierAfter ? ` tier ${tierBefore}→${tierAfter}` : '';
      if (shift) tierShift++;
      console.log(`  ${apply ? '✓' : '·'} ${rel}: ${d.fullText.length} → ${out.fullText.length} chars${shift}; starts ${JSON.stringify(out.fullText.slice(0, 60))}`);
      if (!apply) continue;
      const res = safeWriteReview(file, out, { force: true });
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((res && res.wrote === false) || after.fullText !== out.fullText) {
        failed++;
        console.log(`  ✗ ${rel}: write did not stick (${(res && (res.skipped || res.reason)) || 'text differs after write'})`);
      }
    }
  }
  console.log(`by host: ${JSON.stringify(byHost)}`);
  console.log(`${apply ? 'applied' : 'dry run'}: ${changed} row(s), ${tierShift} with a recomputed tier change, ${failed} failed`);
  return failed ? 1 : 0;
}

process.exit(main());
