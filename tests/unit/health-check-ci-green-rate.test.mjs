/**
 * health-check.js "Main: green rate" row wiring (checkCiGreenRate).
 *
 * The measurement itself is pinned by scripts/lib/ci-green-rate.test.mjs.
 * This covers the piece in between: does the health-check row actually
 * shell out to scripts/ci-green-rate.js with --days 7 --json (and --record
 * ONLY in CI), read a FAIL reading off exit 1 instead of treating it as an
 * error, and degrade to a 'warn' row that says "no reading" on exit 2 or
 * garbage output — never a 'pass'. Same mock-before-require pattern as
 * tests/unit/health-check-main-red-streak-alert.test.mjs.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ghApiCache = require('../../scripts/lib/gh-api-cache.js');
let lowHeadroom = false;
mock.method(ghApiCache, 'hasLowHeadroom', () => lowHeadroom);

process.env.GH_TOKEN = process.env.GH_TOKEN || 'test-token';
const { checkCiGreenRate } = require('../../scripts/health-check.js');
const core = require('../../scripts/lib/ci-green-rate.js');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const greens = (n) => Array.from({ length: n }, (_, i) => ({ databaseId: i, headSha: `s${i}`, conclusion: 'success', status: 'completed', createdAt: new Date(NOW - (i + 1) * 3600e3).toISOString() }));
const resultFor = (rows) => core.computeGreenRate(rows, { now: NOW, repo: 'thomaspryor/Broadwayscore' });

test('PASS reading → pass row; args are --days 7 --json, with --record only in CI', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, args]); return JSON.stringify(resultFor(greens(12))); };
  const [row] = checkCiGreenRate(true, { exec });
  assert.equal(row.name, 'Main: green rate');
  assert.equal(row.status, 'pass');
  assert.match(row.message, /^rate 100% \(green 12 \/ red 0, 12 runs\), 7d trend from n\/a, day 1 of 14 at ≥80% → PASS$/);
  assert.equal(calls[0][0], 'node');
  assert.match(calls[0][1][0], /scripts\/ci-green-rate\.js$/);
  assert.deepEqual(calls[0][1].slice(1), ['--days', '7', '--json', '--record']);

  checkCiGreenRate(false, { exec });
  assert.deepEqual(calls[1][1].slice(1), ['--days', '7', '--json'], 'local runs never write the ledger');
});

test('FAIL reading arrives as exit 1 with stdout — it is a warn row WITH the numbers, not an error', () => {
  const exec = () => { const e = new Error('exit 1'); e.status = 1; e.stdout = JSON.stringify(resultFor([...greens(3), ...greens(9).map((r, i) => ({ ...r, databaseId: 100 + i, headSha: `f${i}`, conclusion: 'failure' }))])); throw e; };
  const [row] = checkCiGreenRate(true, { exec });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /^rate 25% \(green 3 \/ red 9, 12 runs\), 7d trend from n\/a, day 0 of 14 at ≥80% → FAIL$/);
});

test('exit 2 (gh failure) and unparseable output are warn rows that say "no reading" — never pass', () => {
  const boom = () => { const e = new Error('spawn failed'); e.status = 2; e.stderr = 'ci-green-rate: gh api fetch failed (rate-limited)\nmore'; throw e; };
  const [row] = checkCiGreenRate(true, { exec: boom });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /^ci-green-rate\.js failed \(exit 2\) — no reading: ci-green-rate: gh api fetch failed \(rate-limited\)$/);

  const [garbage] = checkCiGreenRate(true, { exec: () => 'not json' });
  assert.equal(garbage.status, 'warn');
  assert.match(garbage.message, /unparseable output — no reading/);
});

test('skips (warn) without a GH token or under low rate-limit headroom, without spawning', () => {
  const never = () => { throw new Error('must not spawn'); };
  lowHeadroom = true;
  assert.match(checkCiGreenRate(true, { exec: never })[0].message, /low rate-limit headroom/);
  lowHeadroom = false;
  const saved = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  assert.match(checkCiGreenRate(true, { exec: never })[0].message, /no GH_TOKEN/);
  process.env.GH_TOKEN = saved;
});
