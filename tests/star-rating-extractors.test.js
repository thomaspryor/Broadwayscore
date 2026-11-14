#!/usr/bin/env node
/**
 * Star Rating Extractor Test Suite
 *
 * Tests each outlet-specific star extractor against saved HTML fixtures.
 * When an outlet redesigns their page, the test fails immediately.
 *
 * Run: node tests/star-rating-extractors.test.js
 * In CI: part of test.yml
 *
 * To update a fixture after a confirmed outlet redesign:
 *   node tests/star-rating-extractors.test.js --update <outlet-id>
 */

const fs = require('fs');
const path = require('path');
const { extractScore } = require('../scripts/lib/score-extractors');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'star-ratings');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

const UPDATE_OUTLET = process.argv.includes('--update') ? process.argv[process.argv.indexOf('--update') + 1] : null;

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

for (const entry of manifest) {
  const fixturePath = path.join(FIXTURE_DIR, entry.id + '.html');

  if (!fs.existsSync(fixturePath)) {
    console.log(`SKIP ${entry.id} — no fixture file`);
    skip++;
    continue;
  }

  const html = fs.readFileSync(fixturePath, 'utf8');
  // For negative tests (NO-STARS-*), use the outlet name after the prefix
  const outletId = entry.id.startsWith('NO-STARS-') ? entry.id.replace('NO-STARS-', '') : entry.id;
  const result = extractScore(html, '', outletId);

  // Negative test: expected null (outlet doesn't use stars)
  if (entry.expected === null) {
    if (!result) {
      console.log(`PASS ${entry.id} — correctly returned null (no stars expected)`);
      pass++;
    } else {
      console.log(`FAIL ${entry.id} — false positive! Got ${result.originalScore} [${result.source}] but expected no stars`);
      fail++;
      failures.push({ outlet: entry.id, expected: 'null', got: result.originalScore, source: result.source });
    }
    continue;
  }

  if (!result) {
    console.log(`FAIL ${entry.id} — extractScore returned null (expected ${entry.expected})`);
    fail++;
    failures.push({ outlet: entry.id, expected: entry.expected, got: 'null', source: 'none' });
    continue;
  }

  // Normalize for comparison: "4/5 stars" → "4/5", "5/5" → "5/5"
  const normalize = (s) => {
    const m = String(s).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
    return m ? `${m[1]}/${m[2]}` : String(s);
  };

  const got = normalize(result.originalScore);
  const expected = normalize(entry.expected);

  if (got === expected) {
    // Also verify the source tag
    if (entry.source && result.source !== entry.source) {
      console.log(`WARN ${entry.id} — rating correct (${got}) but source changed: expected ${entry.source}, got ${result.source}`);
    }
    console.log(`PASS ${entry.id} — ${result.originalScore} [${result.source}]`);
    pass++;
  } else {
    console.log(`FAIL ${entry.id} — expected ${entry.expected}, got ${result.originalScore} [${result.source}]`);
    fail++;
    failures.push({ outlet: entry.id, expected: entry.expected, got: result.originalScore, source: result.source });
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Star Rating Extractor Tests: ${pass} PASS, ${fail} FAIL, ${skip} SKIP`);

if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  ${f.outlet}: expected ${f.expected}, got ${f.got} [${f.source}]`));
  console.log('\nTo investigate a failure:');
  console.log('  1. Check if the outlet redesigned: open the URL in manifest.json');
  console.log('  2. If redesigned: update the extractor, then run:');
  console.log('     node tests/star-rating-extractors.test.js --update <outlet-id>');
  process.exit(1);
}

if (pass > 0 && fail === 0) {
  console.log('\nAll extractors working correctly.');
}
