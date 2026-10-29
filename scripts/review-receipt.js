#!/usr/bin/env node
// scripts/review-receipt.js (BRO-5411)
//   stamp   After a complete /ship-check, before landing: amend HEAD with the
//           Review-Receipt trailer (evidence from review-coverage.mjs --json).
//   check   land.yml (checks job, advisory): --base=<sha> --tip=<sha>; prints a
//           ::warning:: when a gated diff over 30 lines has no receipt and
//           writes receipt=present|missing|... to $GITHUB_OUTPUT. Always exit 0.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { formatReceipt, evaluateReceipt } = require('./lib/review-receipt.js');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...o });

async function check() {
  const base = arg('base');
  const tip = arg('tip') || 'HEAD';
  try {
    const { gatedDiffStats } = await import('./lib/review-gate.mjs');
    const stats = gatedDiffStats(process.cwd(), base, tip);
    if (stats.error) throw new Error(stats.error);
    const messages = sh('git', ['log', '--format=%B%x00', `${base}..${tip}`]).split('\0');
    const r = evaluateReceipt({ gatedLines: stats.totalLines, messages });
    console.log(`review-receipt: ${r.status} (${r.reason})`);
    if (r.status === 'missing' || r.status === 'malformed') console.log(`::warning title=BRO-5411 review receipt ${r.status}::${r.reason}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${r.status}\n`);
  } catch (e) {
    console.log(`review-receipt: could not evaluate (${e.message}); advisory, continuing`);
  }
  return 0;
}

function stamp() {
  let cov;
  try {
    cov = JSON.parse(sh('node', [path.join(__dirname, 'lib', 'review-coverage.mjs'), '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]);
  } catch (e) {
    const out = e.stdout ? String(e.stdout).split('\n')[0] : '';
    try { cov = JSON.parse(out); } catch { /* fall through */ }
  }
  const line = cov && cov.complete && formatReceipt(cov.evidence);
  if (!line) {
    console.error(`review-receipt: no receipt to stamp (${cov ? (cov.missing || []).join('; ') || 'coverage has no evidence (/code-review runs carry none)' : 'coverage could not be read'})`);
    return 3;
  }
  const msg = sh('git', ['log', '-1', '--format=%B']).trimEnd();
  if (/^Review-Receipt:/m.test(msg)) { console.log('review-receipt: HEAD already carries a receipt'); return 0; }
  sh('git', ['commit', '--amend', '--no-verify', '-m', `${msg}\n\n${line}`]);
  console.log(`review-receipt: stamped HEAD\n${line}`);
  return 0;
}

const cmd = process.argv[2];
Promise.resolve(cmd === 'stamp' ? stamp() : cmd === 'check' ? check() : (console.error('usage: review-receipt.js stamp | check --base=<sha> --tip=<sha>'), 2)).then((c) => process.exit(c));
