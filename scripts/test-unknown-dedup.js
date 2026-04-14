#!/usr/bin/env node
/**
 * Test --unknown dedup: find all cases in review-texts where a named-critic
 * file coexists with an --unknown file for the same outlet. Each is a case
 * our guard WOULD HAVE prevented.
 */

const fs = require('fs');
const path = require('path');

function main() {
  const dir = fs.existsSync('data/review-texts')
    ? 'data/review-texts'
    : '/Users/tompryor/Broadwayscore/data/review-texts';

  let totalCollisions = 0;
  const examples = [];

  for (const showDir of fs.readdirSync(dir)) {
    const fullDir = path.join(dir, showDir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json'));

    // Group by outlet slug
    const byOutlet = {};
    for (const f of files) {
      const match = f.match(/^(.+?)--(.+)\.json$/);
      if (!match) continue;
      const [, outlet, critic] = match;
      if (!byOutlet[outlet]) byOutlet[outlet] = [];
      byOutlet[outlet].push({ file: f, critic });
    }

    for (const [outlet, entries] of Object.entries(byOutlet)) {
      const hasUnknown = entries.some(e => e.critic === 'unknown' || e.critic.toLowerCase() === 'unknown');
      const namedCritics = entries.filter(e => !['unknown', 'Unknown'].includes(e.critic.toLowerCase()));
      if (hasUnknown && namedCritics.length > 0) {
        totalCollisions++;
        if (examples.length < 10) {
          examples.push({
            show: showDir,
            outlet,
            files: entries.map(e => e.file),
          });
        }
      }
    }
  }

  console.log(`Total outlet collisions (named + unknown coexist): ${totalCollisions}\n`);
  console.log('Example collisions:');
  examples.forEach(e => {
    console.log(`  ${e.show} / ${e.outlet}:`);
    e.files.forEach(f => console.log(`    - ${f}`));
  });

  // Now test the guard logic against a synthetic example.
  // This is the logic from opening-night-poller.js processDiscoveredReviews:
  const { normalizeOutlet } = require('./lib/review-normalization');
  function wouldSkipUnknown(review, existingFiles) {
    const criticName = review.criticName || '';
    const isUnknownCritic = !criticName || criticName.toLowerCase() === 'unknown';
    if (isUnknownCritic && review.outletId) {
      const outletSlug = normalizeOutlet(review.outletId);
      const hasNamedFile = existingFiles.some(f =>
        f.startsWith(outletSlug + '--') && !f.includes('--unknown') && f.endsWith('.json')
      );
      if (hasNamedFile) return true;
    }
    return false;
  }

  console.log('\nGuard logic tests (5 synthetic cases):');
  const tests = [
    // (name, review, existingFiles, expected)
    ['unknown + named exists → SKIP', { outletId: 'nytimes', criticName: 'Unknown' }, ['nytimes--ben-brantley.json'], true],
    ['unknown + no files → CREATE', { outletId: 'nytimes', criticName: 'Unknown' }, [], false],
    ['named + named exists (different) → CREATE', { outletId: 'nytimes', criticName: 'Jesse Green' }, ['nytimes--ben-brantley.json'], false],
    ['unknown + only unknown exists → CREATE', { outletId: 'nytimes', criticName: '' }, ['nytimes--unknown.json'], false],
    // Real-data style: hyphenated outlet slug
    ['nyt-theater unknown + named exists → SKIP', { outletId: 'nyt-theater', criticName: null }, ['nyt-theater--jonathan-mandell.json'], true],
    ['ap unknown + named exists → SKIP', { outletId: 'ap', criticName: 'Unknown' }, ['ap--michael-kuchwara.json', 'ap--unknown.json'], true],
    ['theatermania unknown + named exists → SKIP', { outletId: 'theatermania', criticName: '' }, ['theatermania--david-finkle.json'], true],
  ];
  let tPass = 0, tFail = 0;
  for (const [name, review, files, expected] of tests) {
    const got = wouldSkipUnknown(review, files);
    const ok = got === expected;
    if (ok) tPass++; else tFail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: got ${got}, expected ${expected}`);
  }

  console.log(`\nGuard tests: PASS ${tPass}/${tests.length}`);
  process.exit(tFail > 0 ? 1 : 0);
}

main();
