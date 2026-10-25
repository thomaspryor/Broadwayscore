#!/usr/bin/env node
'use strict';
/**
 * review-texts-file-history.js: read-only. Print the private review-texts
 * repo's commits that touched one review file, newest first, as
 * "<40-char sha> <ISO date> <subject>", so a review-file-op restore plan can
 * name its fromCommit (BRO-5373: a push gate dropped a moved review and the
 * source delete went through). Cloud sessions run it through
 *   node scripts/cloud-run-script.js --review-texts scripts/review-texts-file-history.js <show>/<file>.json
 * CI clones review-texts shallow, so the history is deepened first.
 *
 *   node scripts/review-texts-file-history.js <show>/<file>.json [--limit=N] [--deepen=N]
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);

const args = process.argv.slice(2);
const rel = args.find((a) => !a.startsWith('--'));
const num = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); const v = a ? parseInt(a.split('=')[1], 10) : d; return Number.isFinite(v) && v > 0 ? v : d; };
if (!rel || !/^[a-z0-9][a-z0-9-]*\/[^/]+\.json$/.test(rel)) {
  console.error('usage: review-texts-file-history.js <show>/<file>.json [--limit=N] [--deepen=N]');
  process.exit(2);
}
const dir = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const git = (a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
try { git(['fetch', '--quiet', `--deepen=${num('deepen', 2000)}`, 'origin']); } catch { /* full clone or offline: use what is local */ }
const out = git(['log', `-n${num('limit', 20)}`, '--format=%H %cI %s', '--', rel]).trim();
console.log(out || `no commits touch ${rel} in the fetched history`);
