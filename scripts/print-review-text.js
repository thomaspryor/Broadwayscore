#!/usr/bin/env node
/**
 * print-review-text.js — print review-text records for triage (read-only).
 *
 * Cloud sessions have no data/review-texts checkout, so reading a flagged
 * review in full means running this through
 *   node scripts/cloud-run-script.js --review-texts scripts/print-review-text.js ...
 * whose output comes back encrypted to the calling session (BRO-305). Never
 * pass review text as an argument: only show ids and file names.
 *
 * USAGE:
 *   node scripts/print-review-text.js <showId>/<file.json> [more...] [--max=N]
 *   node scripts/print-review-text.js --star-mismatch-new [--max=N]
 *     (every NEW finding of scripts/audit-star-score-mismatch.js)
 *
 * Prints each record's short fields (strings under 300 chars, numbers,
 * booleans), then fullText up to --max characters (default 12000).
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

function parseArgs(argv) {
  const out = { keys: [], max: 12000, starMismatchNew: false };
  for (const a of argv) {
    if (a.startsWith('--max=')) out.max = parseInt(a.slice(6), 10) || out.max;
    else if (a === '--star-mismatch-new') out.starMismatchNew = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.keys.push(a);
  }
  return out;
}

function shortFields(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'fullText') continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string' && v.length < 300) out[k] = v;
    else if (typeof v === 'object' && JSON.stringify(v).length < 400) out[k] = v;
  }
  return out;
}

function printOne(key, max) {
  const [showId, file] = key.split('/');
  if (!showId || !file || key.includes('..')) { console.log(`=== ${key}: bad key (want <showId>/<file.json>)`); return false; }
  const p = path.join(ROOT, showId, file);
  if (!fs.existsSync(p)) { console.log(`=== ${key}: not found`); return false; }
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  const text = String(rec.fullText || '');
  console.log(`=== ${key}`);
  console.log(JSON.stringify(shortFields(rec), null, 1));
  console.log(`--- fullText (${text.length} chars${text.length > max ? `, first ${max}` : ''})`);
  console.log(text.slice(0, max));
  console.log('');
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let keys = args.keys;
  if (args.starMismatchNew) {
    const { scanReviewTexts } = require('./lib/star-score-mismatch');
    let baselineKeys = new Set();
    try {
      const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'audit', 'star-score-mismatch-baseline.json'), 'utf8'));
      baselineKeys = new Set(b.keys || []);
    } catch { /* no baseline: everything is new */ }
    const { findings } = scanReviewTexts(ROOT, { baselineKeys });
    keys = keys.concat(findings.map(f => `${f.showId}/${f.file}`));
  }
  if (keys.length === 0) { console.error('usage: print-review-text.js <showId>/<file.json> [...] [--max=N] | --star-mismatch-new'); process.exit(2); }
  let ok = 0;
  for (const k of keys) if (printOne(k, args.max)) ok++;
  process.exit(ok === keys.length ? 0 : 1);
}

if (require.main === module) main();
module.exports = { parseArgs, shortFields };
