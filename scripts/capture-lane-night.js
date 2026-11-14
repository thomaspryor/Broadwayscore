#!/usr/bin/env node
/**
 * Capture the West End aggregator pages for a lane fixture (BRO-5956).
 *
 * Runs the lane's West End adapters (WET, theatre.reviews, Stagedoor, The Stage, London Box Office) once against the
 * live sites through fetchPage, records every page they read with its fetch time, and writes the recording in the
 * private lane-recordings layout (<archive>/<show>/<night>/recording/), which tests/unit/west-end-fixture-replay.test.mjs
 * replays. Pages are copyrighted: --archive must be the private review-texts clone's lane-recordings dir, a dir outside
 * this repo, or the git-ignored data/lane-recordings (recording-import.assertPrivateDest refuses anything else).
 * Prints urls, counts and statuses only, never page text.
 *
 * Usage:
 *   node scripts/capture-lane-night.js --archive=DIR
 *     (today: The Lives of Others, night 2026-10-29, the one night with a fixture module)
 */
const { hasHelpFlag } = require('./lib/cli-help.js');

if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/capture-lane-night.js --archive=DIR\n'
    + 'Records the West End aggregator pages for The Lives of Others (2026-10-29) into DIR/<show>/<night>/recording/.');
  process.exit(0);
}

async function main(argv = process.argv.slice(2)) {
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const archive = arg('archive');
  if (!archive) { console.error('--archive=DIR is required'); return 1; }
  const night = require('./lib/lane-recorded-nights/west-end-lives-of-others-2026');
  const { fetchPage } = require('./lib/scraper');
  const out = await night.captureWestEndNight({ root: archive, fetchPage });
  const p = out.pass;
  console.log(`import: ${out.import.status}${out.import.pages != null ? ` (${out.import.pages} pages)` : ''} -> ${out.dir}`);
  console.log(`admitted ${p.admitted.length}, rejected ${p.rejected.length}, errors ${p.errors.length}`);
  for (const a of p.admitted) console.log(`  + ${a.adapter} ${a.key}`);
  for (const e of p.errors) console.log(`  ! ${e.adapter}: ${e.error}`);
  return out.import.status === 'imported' ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}

module.exports = { main };
