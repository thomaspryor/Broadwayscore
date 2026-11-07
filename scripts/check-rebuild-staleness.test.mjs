import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldRetryForStaleCheckout,
  findMissingScoreableShows,
  formatMissingShowsFile,
} = require('./lib/rebuild-staleness-guard.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);

// CLAUDE.md rule 15: require() the real functions, never copy their logic
// into the test. check-rebuild-staleness.js itself just wires these up to
// fs/process — the decisions live here in scripts/lib/rebuild-staleness-guard.js.

test('findMissingScoreableShows: scopes correctly — only genuinely-missing shows, never the whole corpus', () => {
  // The BRO-3127 incident's actual shape: sylvia drifted and is missing;
  // jane-eyre also drifted but landed fine. The guard must flag ONLY sylvia.
  const scoreable = ['sylvia-off-west-end-2026', 'jane-eyre-off-west-end-2026'];
  const reviewsShowIds = ['jane-eyre-off-west-end-2026', 'some-other-unrelated-show'];
  assert.deepEqual(findMissingScoreableShows(scoreable, reviewsShowIds), ['sylvia-off-west-end-2026']);
});

test('findMissingScoreableShows: empty when every scoreable show is present', () => {
  assert.deepEqual(findMissingScoreableShows(['a', 'b'], ['a', 'b', 'c']), []);
});

test('findMissingScoreableShows: dedupes and sorts', () => {
  assert.deepEqual(findMissingScoreableShows(['b', 'a', 'b'], []), ['a', 'b']);
});

test('shouldRetryForStaleCheckout: true only when both SHAs present and differ', () => {
  assert.equal(shouldRetryForStaleCheckout('sha1', 'sha2'), true);
  assert.equal(shouldRetryForStaleCheckout('sha1', 'sha1'), false);
  assert.equal(shouldRetryForStaleCheckout('', 'sha2'), false);
  assert.equal(shouldRetryForStaleCheckout('sha1', ''), false);
});

// BRO-3127: formatMissingShowsFile() is what rebuild-fast.yml/rebuild-reviews.yml's
// "Revert public data for shows flagged by staleness guard" step reads
// (one show id per line) to know which public/data/shows/{id}.json files to
// revert to last-committed state instead of letting the now-unblocked
// regeneration step republish them from the incomplete reviews.json state
// this guard just flagged.
test('formatMissingShowsFile: one show id per line, trailing newline', () => {
  assert.equal(
    formatMissingShowsFile(['sylvia-off-west-end-2026']),
    'sylvia-off-west-end-2026\n'
  );
  assert.equal(
    formatMissingShowsFile(['a', 'b', 'c']),
    'a\nb\nc\n'
  );
});

test('formatMissingShowsFile: empty list still produces a trailing newline (never undefined/crash)', () => {
  assert.equal(formatMissingShowsFile([]), '\n');
  assert.equal(formatMissingShowsFile(undefined), '\n');
});

test('check-rebuild-staleness.js writes the missing-shows file via formatMissingShowsFile whenever a show is missing', () => {
  const src = fs.readFileSync(path.join(HERE, 'check-rebuild-staleness.js'), 'utf-8');
  assert.match(
    src,
    /formatMissingShowsFile\(missing\)/,
    'check-rebuild-staleness.js should format the missing-shows file via the shared, tested formatMissingShowsFile() ' +
      'helper — not a bespoke inline .join() that would drift from what this test verifies'
  );
  assert.match(
    src,
    /MISSING_SHOWS_FILE\s*=\s*path\.join\(process\.env\.RUNNER_TEMP.*staleness-missing-shows\.txt/,
    'check-rebuild-staleness.js should write to $RUNNER_TEMP/staleness-missing-shows.txt (falling back to /tmp) — ' +
      'the exact path rebuild-fast.yml/rebuild-reviews.yml\'s revert step reads'
  );
});
