// BRO-6858: the press-night preflight fails only on keys the night needs, never on warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { preflightVerdict, REQUIRED } = require('../../scripts/lib/press-night-preflight.js');

const all = (over = {}) => REQUIRED.map((name) => ({ name, status: 'pass', message: '', ...(over[name] || {}) }));

test('all pass, warnings and unrelated failures: clean', () => {
  const r = all({ 'Bright Data': { status: 'warn' } }).concat([{ name: 'Dispatch PAT (submit-review)', status: 'fail' }, { name: 'Sentry', status: 'fail' }]);
  assert.equal(preflightVerdict({ results: r, sb: { ok: true, pctUsed: 50, remaining: 1000 } }).ok, true);
});

test('fail or skip on a needed key, missing results, low credits: problems', () => {
  const v = preflightVerdict({ results: all({ Anthropic: { status: 'fail', message: '401' }, Resend: { status: 'skip' } }).filter((x) => x.name !== 'Vercel'), sb: { ok: true, pctUsed: 93, remaining: 70 } });
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map((p) => p.key).sort(), ['Anthropic', 'Resend', 'ScrapingBee credits', 'Vercel']);
  assert.equal(v.resendDown, true);
});

test('unknown credit status does not fail on its own', () => {
  assert.equal(preflightVerdict({ results: all(), sb: { ok: false, reason: 'no-key' } }).ok, true);
});

test('a crashed check is matched by its function name and counts as a problem', () => {
  const r = all().filter((x) => x.name !== 'Bright Data' && x.name !== 'Private Repo PAT')
    .concat([{ name: 'BrightData', status: 'warn', message: 'Check threw error: boom' }, { name: 'PrivateRepoPAT', status: 'pass', message: 'ok' }]);
  const v = preflightVerdict({ results: r, sb: null });
  assert.deepEqual(v.problems.map((p) => p.key), ['Bright Data']);
  assert.match(v.problems[0].why, /check crashed/);
});
