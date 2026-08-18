import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMigratedScripts, findGaps } = require('./audit-review-texts-test-yml-coverage.js');

const SAMPLE_TEST_SOURCE = `
const MIGRATED_SCRIPTS = [
  'audit-review-url-clusters.js',
  'delete-misroute-orphans.js',
  // a comment mentioning 'not-a-real-entry.js' should NOT count as an entry
  'backfill-critic-name-truncation.js',
];

for (const name of MIGRATED_SCRIPTS) {
  test(\`placeholder \${name}\`, () => {});
}
`;

const SAMPLE_YML = `
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'scripts/audit-review-url-clusters.js'
      - 'scripts/delete-misroute-orphans.js'
  pull_request:
    branches: [main]
`;

test('parseMigratedScripts: extracts quoted entries, ignores comment text', () => {
  const entries = parseMigratedScripts(SAMPLE_TEST_SOURCE);
  assert.deepEqual(entries, [
    'audit-review-url-clusters.js',
    'delete-misroute-orphans.js',
    'backfill-critic-name-truncation.js',
  ]);
});

test('findGaps: a script present in MIGRATED_SCRIPTS but absent from the allow-list is flagged', () => {
  const gaps = findGaps({ testSource: SAMPLE_TEST_SOURCE, ymlSource: SAMPLE_YML });
  assert.deepEqual(gaps, ['scripts/backfill-critic-name-truncation.js']);
});

test('findGaps: a script present in both MIGRATED_SCRIPTS and the allow-list is not flagged', () => {
  const gaps = findGaps({ testSource: SAMPLE_TEST_SOURCE, ymlSource: SAMPLE_YML });
  assert.equal(gaps.includes('scripts/audit-review-url-clusters.js'), false);
  assert.equal(gaps.includes('scripts/delete-misroute-orphans.js'), false);
});

test('findGaps: a glob entry covering the script counts as coverage', () => {
  const ymlWithGlob = `
on:
  push:
    paths:
      - 'scripts/backfill-critic-name-truncation.js'
      - 'scripts/audit-review-url-clusters.js'
      - 'scripts/delete-misroute-orphans.js'
`;
  const gaps = findGaps({ testSource: SAMPLE_TEST_SOURCE, ymlSource: ymlWithGlob });
  assert.deepEqual(gaps, []);
});

test('findGaps: the real repo has zero gaps against the current test.yml and MIGRATED_SCRIPTS (regression floor)', () => {
  const gaps = findGaps();
  assert.deepEqual(gaps, []);
});

test('parseMigratedScripts: throws (not silently returns []) when the MIGRATED_SCRIPTS declaration is reformatted away — this is the exact failure main() must catch and degrade to a warning, not an uncaught crash', () => {
  assert.throws(() => parseMigratedScripts('const RENAMED = [\n  \'audit-foo.js\',\n];'), /could not find/);
});
