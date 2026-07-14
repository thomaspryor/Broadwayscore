import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifierArgvFor } = require('./autonomous-data-verify.js');

test('missing-show maps to validate-show-venue with --data-dir + --fail-on-mismatch', () => {
  const checks = verifierArgvFor('missing-show', { dataDir: '/tmp/scratch/data', showIds: [] });
  assert.equal(checks.length, 1);
  assert.match(checks[0].name, /validate-show-venue/);
  assert.ok(checks[0].argv.some(a => a.includes('validate-show-venue.js')));
  assert.ok(checks[0].argv.includes('--all-provisional'));
  assert.ok(checks[0].argv.includes('--fail-on-mismatch'));
  assert.ok(checks[0].argv.includes('--data-dir=/tmp/scratch/data'));
});

test('re-gather/byline-recovery/cluster-cleanup map to one verify-review-recovery call per show, --pre-merge', () => {
  for (const cls of ['re-gather', 'byline-recovery', 'cluster-cleanup']) {
    const checks = verifierArgvFor(cls, { dataDir: '/tmp/x', showIds: ['hamilton-2015', 'kyoto-off-broadway-2025'] });
    assert.equal(checks.length, 2, `class ${cls}`);
    for (const [i, id] of ['hamilton-2015', 'kyoto-off-broadway-2025'].entries()) {
      assert.ok(checks[i].argv.some(a => a.includes('verify-review-recovery.js')));
      assert.ok(checks[i].argv.includes(`--show=${id}`));
      assert.ok(checks[i].argv.includes('--pre-merge'));
      // No --production: the branch isn't live yet, that check would always fail.
      assert.ok(!checks[i].argv.includes('--production'));
    }
  }
});

test('no showIds for a review-texts class produces zero checks (nothing to verify)', () => {
  assert.deepEqual(verifierArgvFor('byline-recovery', { dataDir: '/tmp/x', showIds: [] }), []);
  assert.deepEqual(verifierArgvFor('byline-recovery', { dataDir: '/tmp/x', showIds: undefined }), []);
});

test('unknown class returns no verifier commands (default-deny — caller must refuse, not skip)', () => {
  assert.deepEqual(verifierArgvFor('some-unknown-class', { dataDir: '/tmp/x', showIds: ['a'] }), []);
  assert.deepEqual(verifierArgvFor(null, { dataDir: '/tmp/x' }), []);
});
