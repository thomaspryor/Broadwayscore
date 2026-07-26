import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shallowFetchArgs, DEFAULT_SLACK_SEC, DEFAULT_FALLBACK_DEPTH } = require('./shallow-fetch-args.js');

const EPOCH = 1_753_500_000; // fixed; no wall-clock in assertions

test('complete clone gets NO depth bound (never shallow-ify a full checkout)', () => {
  assert.deepEqual(shallowFetchArgs({ isShallow: false, oldestCommitEpoch: EPOCH }), []);
});

test('shallow clone gets --shallow-since anchored slack-seconds before the boundary commit', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: 1800 }),
    [`--shallow-since=@${EPOCH - 1800}`]
  );
});

test('default slack is applied when none is passed', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH }),
    [`--shallow-since=@${EPOCH - DEFAULT_SLACK_SEC}`]
  );
});

test('epoch may arrive as a string (git log output is text)', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: String(EPOCH), slackSec: 60 }),
    [`--shallow-since=@${EPOCH - 60}`]
  );
});

test('unusable epoch falls back to a relative deepen — bounded, and never SHORTENS history', () => {
  for (const bad of ['', undefined, null, 'not-a-number', 0, -5, NaN]) {
    assert.deepEqual(
      shallowFetchArgs({ isShallow: true, oldestCommitEpoch: bad }),
      [`--deepen=${DEFAULT_FALLBACK_DEPTH}`],
      `epoch ${JSON.stringify(bad)} should fall back to a relative deepen`
    );
  }
});

test('THE REGRESSION: a shallow repo must never receive an empty arg list', () => {
  // An empty list means push-with-retry.sh issues an unbounded fetch, which is
  // exactly the task-#466 pathology: upload-pack answers a shallow client with
  // the entire 165k-commit / ~2.1 GB history and the fetch dies at rc=124 on
  // every retry. Measured 2026-07-26: bare AND explicit-refspec forms both hit
  // a 300 s wall; --depth-bounded finished in 8 s.
  for (const epoch of [EPOCH, String(EPOCH), '', null]) {
    const args = shallowFetchArgs({ isShallow: true, oldestCommitEpoch: epoch });
    assert.ok(args.length > 0, `shallow repo with epoch ${JSON.stringify(epoch)} got an unbounded fetch`);
  }
});

test('since-anchor never goes non-positive even with absurd slack', () => {
  const [arg] = shallowFetchArgs({ isShallow: true, oldestCommitEpoch: 10, slackSec: 10_000 });
  assert.equal(arg, '--shallow-since=@1');
});

test('negative or non-numeric slack is treated as zero, not NaN', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: -100 }),
    [`--shallow-since=@${EPOCH}`]
  );
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: 'abc' }),
    [`--shallow-since=@${EPOCH}`]
  );
});

test('emitted args contain no whitespace (the shell word-splits them)', () => {
  const cases = [
    { isShallow: true, oldestCommitEpoch: EPOCH },
    { isShallow: true, oldestCommitEpoch: '' },
  ];
  for (const c of cases) {
    for (const arg of shallowFetchArgs(c)) {
      assert.ok(!/\s/.test(arg), `arg ${JSON.stringify(arg)} contains whitespace`);
    }
  }
});

test('no-argument call is safe (treated as a complete clone)', () => {
  assert.deepEqual(shallowFetchArgs(), []);
});
