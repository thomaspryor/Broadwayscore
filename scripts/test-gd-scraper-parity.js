#!/usr/bin/env node
/**
 * test-gd-scraper-parity.js — Regression gate for the GD scraper refactor.
 *
 * Runs `scrape-gold-derby-tonys.js --season=2026 --dry-run` and compares the
 * JSON output against `tests/fixtures/gd-scraper-parity/season-2026.before.json`
 * captured pre-refactor.
 *
 * Output is normalized by replacing `_meta.lastUpdated` (which changes on every
 * run) with a sentinel before comparison. Any other diff fails the test.
 *
 * Used to gate the S2-T2 lib extract and any future change to the GD scraper.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASELINE = path.join(__dirname, '..', 'tests', 'fixtures', 'gd-scraper-parity', 'season-2026.before.json');
const SCRAPER = path.join(__dirname, 'scrape-gold-derby-tonys.js');

function normalize(jsonText) {
  // Use a reviver to replace volatile fields with sentinels.
  return JSON.parse(jsonText, (key, value) => key === 'lastUpdated' ? '<ts>' : value);
}

function firstDiffLocation(a, b) {
  const aStr = JSON.stringify(a, null, 2).split('\n');
  const bStr = JSON.stringify(b, null, 2).split('\n');
  for (let i = 0; i < Math.min(aStr.length, bStr.length); i++) {
    if (aStr[i] !== bStr[i]) return { line: i, baseline: aStr[i], current: bStr[i] };
  }
  if (aStr.length !== bStr.length) return { line: Math.min(aStr.length, bStr.length), baseline: aStr[aStr.length-1], current: bStr[bStr.length-1] };
  return null;
}

(async () => {
  if (!fs.existsSync(BASELINE)) {
    console.error(`FAIL: baseline not found at ${BASELINE}`);
    process.exit(1);
  }

  console.error('Running scrape-gold-derby-tonys.js --season=2026 --dry-run...');
  const stdout = execFileSync('node', [SCRAPER, '--season=2026', '--dry-run'], { encoding: 'utf8' });

  const baselineNorm = normalize(fs.readFileSync(BASELINE, 'utf8'));
  const currentNorm = normalize(stdout);

  const ok = JSON.stringify(baselineNorm) === JSON.stringify(currentNorm);
  if (ok) {
    console.log('✅ PARITY PASS — current output is timestamp-normalized-equal to baseline.');
    process.exit(0);
  }

  const diff = firstDiffLocation(baselineNorm, currentNorm);
  console.error('❌ PARITY FAIL');
  if (diff) {
    console.error(`First diff at line ${diff.line}:`);
    console.error(`  baseline: ${diff.baseline}`);
    console.error(`  current:  ${diff.current}`);
  }
  process.exit(1);
})().catch(e => {
  console.error('test-gd-scraper-parity.js error:', e.message);
  process.exit(1);
});
