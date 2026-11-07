#!/usr/bin/env node
/**
 * audit-lookalike-images.js (BRO-6995)
 *
 * Lists every pair of unrelated shows whose image files look like the same
 * picture (re-encoded, resized or re-cropped copies that the byte-identical
 * and shared-source-URL guards miss). Rope (St. Clement's) served The Lost
 * Boys' poster this way. Read-only; each row means one show carries another
 * show's art. Fix: reject the wrong row's source in rejectedImageUrls and
 * re-fetch, or, when the pair is one production, allowlist it in
 * scripts/lib/duplicate-images.js DUPLICATE_IMAGE_ALLOWLIST after viewing it.
 *
 * Usage:
 *   node scripts/audit-lookalike-images.js [--min=0.97] [--keys=thumbnail,poster] [--json] [--strict]
 *     --min     correlation threshold (default LOOKALIKE_MIN_SIMILARITY)
 *     --strict  exit 1 when any pair is found (default: always exit 0)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { findLookalikeImageGroups, signatureShowImageFiles, LOOKALIKE_MIN_SIMILARITY } = require('./lib/duplicate-images');

const USAGE = `audit-lookalike-images.js — unrelated shows whose art looks like the same picture (read-only).

Usage:
  node scripts/audit-lookalike-images.js [--min=${LOOKALIKE_MIN_SIMILARITY}] [--keys=thumbnail,poster,hero] [--json] [--strict]
  node scripts/audit-lookalike-images.js --help, -h   print this usage and exit
`;

const argVal = (args, name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function main(args) {
  if (hasHelpFlag(args)) { process.stdout.write(USAGE); return 0; }
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const min = argVal(args, 'min') ? Number(argVal(args, 'min')) : LOOKALIKE_MIN_SIMILARITY;
  const keys = argVal(args, 'keys') ? argVal(args, 'keys').split(',') : null;
  const t0 = Date.now();
  const { entries, missing } = await signatureShowImageFiles(shows, path.join(__dirname, '..', 'public'), { keys });
  const pairs = findLookalikeImageGroups(entries, shows, { minSimilarity: min });
  if (args.includes('--json')) {
    console.log(JSON.stringify(pairs, null, 2));
  } else {
    const usable = entries.filter((e) => e.sig).length;
    console.log(`${pairs.length} lookalike pair(s) at correlation >= ${min} (${usable} of ${entries.length} image files comparable, ${missing.length} missing, ${Math.round((Date.now() - t0) / 1000)}s)`);
    for (const p of pairs) console.log(`  ${p.similarity.toFixed(3)}  ${p.files[0].showId}/${p.files[0].key}  <->  ${p.files[1].showId}/${p.files[1].key}`);
  }
  return args.includes('--strict') && pairs.length ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
