#!/usr/bin/env node
/**
 * Post-build check (BRO-5811): the show page, its OG image, the embed and the
 * badge render at runtime (revalidate / dynamicParams / force-dynamic), so
 * their traced server files must carry
 * the coverage-floor snapshot, and must carry no data/audit/ file (that tree
 * is excluded from tracing for size; next.config.js).
 *
 * Usage: node scripts/lib/check-coverage-floor-trace.js [.next dir]
 * Exit 0 = ok, 1 = a route's trace is missing, lacks the snapshot or traces
 * an audit file, or the snapshot has no verdicts; 2 = no build output.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { COVERAGE_FLOOR_SNAPSHOT_FILE } = require('./coverage-floor-inputs');

// Every route that decides a show's TBD at request time (revalidate,
// dynamicParams or force-dynamic) via data-core.
const ROUTES = ['show/[slug]/page', 'show/[slug]/opengraph-image/route', 'embed/[slug]/route', 'api/badge/[slug]/route'];
const SNAPSHOT = `data/${COVERAGE_FLOOR_SNAPSHOT_FILE}`;

/**
 * @param {string} nftPath  a .nft.json written by next build
 * @param {string} repoRoot
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkNft(nftPath, repoRoot) {
  const nft = JSON.parse(fs.readFileSync(nftPath, 'utf8'));
  const files = (nft.files || []).map(f => path.relative(repoRoot, path.resolve(path.dirname(nftPath), f)).split(path.sep).join('/'));
  const problems = [];
  if (!files.includes(SNAPSHOT)) problems.push(`missing ${SNAPSHOT}`);
  const audit = files.filter(f => f.startsWith('data/audit/'));
  if (audit.length) problems.push(`traces ${audit.length} data/audit file(s): ${audit.slice(0, 3).join(', ')}`);
  const imgs = files.filter(f => f.startsWith('public/images/'));
  if (imgs.length) problems.push(`traces ${imgs.length} public/images file(s): ${imgs.slice(0, 3).join(', ')}`);
  return { ok: problems.length === 0, problems };
}

function readSnapshot(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main() {
  const nextDir = path.resolve(process.argv[2] || '.next');
  const repoRoot = path.dirname(nextDir);
  let failed = false;
  let checked = 0;
  for (const route of ROUTES) {
    const nftPath = path.join(nextDir, 'server', 'app', `${route}.js.nft.json`);
    if (!fs.existsSync(nftPath)) {
      // A renamed/moved trace must not pass silently (an unchecked route).
      console.log(`FAIL ${route}: no ${path.relative(repoRoot, nftPath)}`);
      failed = true;
      continue;
    }
    checked++;
    const { ok, problems } = checkNft(nftPath, repoRoot);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${route}${ok ? '' : ': ' + problems.join('; ')}`);
    if (!ok) failed = true;
  }
  if (!checked) { console.error('no show-route trace files found; did next build run?'); process.exit(2); }
  // BRO-6277: no function anywhere may trace show art (it broke prod deploys).
  const imageTracers = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.nft.json') && !checkNft(f, repoRoot).problems.every(p => !p.includes('public/images'))) imageTracers.push(path.relative(nextDir, f));
    }
  })(path.join(nextDir, 'server'));
  console.log(`${imageTracers.length ? 'FAIL' : 'ok  '} no server trace includes public/images${imageTracers.length ? ': ' + imageTracers.slice(0, 3).join(', ') : ''}`);
  if (imageTracers.length) failed = true;
  // The traced file must also carry verdicts: an empty snapshot is a floor
  // that can never hold a score.
  const snap = readSnapshot(path.join(repoRoot, SNAPSHOT));
  const verdicts = snap && snap.cov ? Object.keys(snap.cov).length : 0;
  console.log(`${verdicts ? 'ok  ' : 'FAIL'} ${SNAPSHOT}: ${verdicts} verdicts`);
  if (!verdicts) failed = true;
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkNft, ROUTES };
