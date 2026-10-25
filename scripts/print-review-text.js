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
 *   --fields=llmScore,ensembleData  print these fields whole, whatever their
 *     size (shortFields drops big objects such as llmScore)
 *   <showId>/   a trailing slash prints every file in that show's folder
 *   --no-text   print short fields only, no fullText (folder triage)
 *   --core=ID[,ID...]  also print the shows.json entry and the reviews.json rows
 *     for these shows from the run's core data (cloud sessions hold a stale copy)
 *
 * Prints each record's short fields (strings under 300 chars, numbers,
 * booleans), then fullText up to --max characters (default 12000).
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

function parseArgs(argv) {
  const out = { keys: [], max: 12000, starMismatchNew: false, fields: [], noText: false, core: [] };
  for (const a of argv) {
    if (a.startsWith('--max=')) out.max = parseInt(a.slice(6), 10) || out.max;
    else if (a === '--star-mismatch-new') out.starMismatchNew = true;
    else if (a.startsWith('--fields=')) out.fields = a.slice(9).split(',').map(f => f.trim()).filter(Boolean);
    else if (a === '--no-text') out.noText = true;
    else if (a.startsWith('--core=')) out.core = a.slice(7).split(',').map(f => f.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.keys.push(a);
  }
  return out;
}

function shortFields(rec, fields = []) {
  const out = {};
  for (const f of fields) if (f !== 'fullText' && f in rec) out[f] = rec[f];
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'fullText' || k in out) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string' && v.length < 300) out[k] = v;
    else if (typeof v === 'object' && JSON.stringify(v).length < 400) out[k] = v;
  }
  return out;
}

// '<showId>/' expands to every .json file in that folder, sorted.
function expandKeys(keys, root = ROOT) {
  const out = [];
  for (const k of keys) {
    if (!k.endsWith('/') || k.includes('..')) { out.push(k); continue; }
    const dir = path.join(root, k.slice(0, -1));
    if (!fs.existsSync(dir)) { out.push(k); continue; }
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) out.push(k + f);
  }
  return out;
}

function printCore(ids) {
  const dataDir = path.join(__dirname, '..', 'data');
  const shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
  const list = Array.isArray(shows) ? shows : (shows.shows || []);
  const rv = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
  const rows = Array.isArray(rv) ? rv : (rv.reviews || []);
  for (const id of ids) {
    const s = list.find(x => x.id === id);
    console.log(`=== core ${id}`);
    console.log(s ? JSON.stringify(s) : 'no shows.json entry');
    for (const r of rows.filter(x => x.showId === id)) {
      console.log(`  rv ${r.outletId} | ${r.outlet} | ${r.criticName} | ${r.assignedScore} | ${r.publishDate} | ${r.url}`);
    }
    console.log('');
  }
}

function printOne(key, max, fields, noText = false) {
  const [showId, file] = key.split('/');
  if (!showId || !file || key.includes('..')) { console.log(`=== ${key}: bad key (want <showId>/<file.json>)`); return false; }
  const p = path.join(ROOT, showId, file);
  if (!fs.existsSync(p)) { console.log(`=== ${key}: not found`); return false; }
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  const text = String(rec.fullText || '');
  console.log(`=== ${key}`);
  console.log(JSON.stringify(shortFields(rec, fields), null, 1));
  if (noText) { console.log(`--- fullText ${text.length} chars (not printed)`); console.log(''); return true; }
  console.log(`--- fullText (${text.length} chars${text.length > max ? `, first ${max}` : ''})`);
  console.log(text.slice(0, max));
  console.log('');
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let keys = expandKeys(args.keys);
  if (args.core.length) printCore(args.core);
  if (args.starMismatchNew) {
    const { scanReviewTexts } = require('./lib/star-score-mismatch');
    let baselineKeys = new Set();
    try {
      const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'audit', 'star-score-mismatch-baseline.json'), 'utf8'));
      baselineKeys = require('./lib/baseline-ttl').activeBaselineKeys(b); // BRO-3364: expired acks count as new
    } catch { /* no baseline: everything is new */ }
    const { findings } = scanReviewTexts(ROOT, { baselineKeys });
    keys = keys.concat(findings.map(f => `${f.showId}/${f.file}`));
  }
  if (keys.length === 0 && args.core.length) process.exit(0);
  if (keys.length === 0) { console.error('usage: print-review-text.js <showId>/<file.json> [...] [--max=N] | --star-mismatch-new'); process.exit(2); }
  let ok = 0;
  for (const k of keys) if (printOne(k, args.max, args.fields, args.noText)) ok++;
  process.exit(ok === keys.length ? 0 : 1);
}

if (require.main === module) main();
module.exports = { parseArgs, shortFields, expandKeys };
