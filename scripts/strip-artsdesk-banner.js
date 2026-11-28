#!/usr/bin/env node
/**
 * strip-artsdesk-banner.js: cut the theartsdesk.com support banner and the trailing
 * "Image" label from stored Arts Desk review texts, including the _pending folders
 * the collector does not read (BRO-7061). Rules: scripts/lib/artsdesk-chrome.js.
 * A banner holds no verdict, so no rescore is queued. Runs in CI only (review texts
 * are private); data/pending-fixes run-script action: args "--apply --expect=N".
 *
 * Usage:
 *   node scripts/strip-artsdesk-banner.js                        dry run: rows it would change
 *   node scripts/strip-artsdesk-banner.js --apply --expect=N     write through safeWriteReview
 *     --expect=N  refuse to write unless exactly N rows change
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { scan } = require('./audit-artsdesk-banner');
const { stripArtsDeskChrome } = require('./lib/artsdesk-chrome');
const { safeWriteReview } = require('./lib/review-write-guard');

if (hasHelpFlag(process.argv)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}

const DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const expectArg = (process.argv.find((a) => a.startsWith('--expect=')) || '').slice(9);
const expect = expectArg === '' ? null : Number(expectArg);
const TRIM_REASON = 'theartsdesk support banner / trailing Image removed (BRO-7061)';

function main() {
  if (apply && expect === null) { console.log('✗ --apply requires --expect=N (run the dry run first)'); return 1; }
  const at = new Date().toISOString();
  const plan = [];
  for (const row of scan(DIR, {})) {
    if (!row.banner && !row.endsImage) continue;
    const file = path.join(DIR, row.show, row.file);
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (d._locked === true) continue;
    const text = stripArtsDeskChrome(d.fullText);
    if (!text || text === d.fullText) continue;
    const out = { ...d, fullText: text };
    const words = text.split(/\s+/).filter(Boolean).length;
    for (const f of ['textWordCount', 'wordCount']) if (typeof out[f] === 'number') out[f] = words;
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    if (out.llmPullQuote && norm(d.fullText).includes(norm(out.llmPullQuote)) && !norm(text).includes(norm(out.llmPullQuote))) out.llmPullQuote = null;
    out.fullTextTrimmed = { reason: TRIM_REASON, fromLength: d.fullText.length, toLength: text.length, at };
    plan.push({ rel: `${row.show}/${row.file}`, file, out, before: d.fullText.length });
  }
  for (const p of plan) console.log(`  ${apply ? '✓' : '·'} ${p.rel}: ${p.before} → ${p.out.fullText.length} chars`);
  if (expect !== null && plan.length !== expect) {
    console.log(`✗ expected ${expect} row(s) to change, found ${plan.length}; nothing written`);
    return 1;
  }
  let failed = 0;
  if (apply) {
    for (const p of plan) {
      const res = safeWriteReview(p.file, p.out, { force: true });
      const after = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      if ((res && res.wrote === false) || after.fullText !== p.out.fullText) {
        failed++;
        console.log(`  ✗ ${p.rel}: write did not stick (${(res && (res.skipped || res.reason)) || 'text differs after write'})`);
      }
    }
  }
  console.log(`${apply ? 'applied' : 'dry run'}: ${plan.length} row(s), ${failed} failed`);
  return failed ? 1 : 0;
}

process.exit(main());
