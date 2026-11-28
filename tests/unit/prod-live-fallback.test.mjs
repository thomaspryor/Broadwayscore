import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveUnknownLiveness, liveFromCompareStatus } = require('../../scripts/lib/prod-live-fallback.js');

test('BRO-6730: compare status maps to live / not live / unknown', () => {
  assert.equal(liveFromCompareStatus('ahead'), true);
  assert.equal(liveFromCompareStatus('identical'), true);
  assert.equal(liveFromCompareStatus('behind'), false);
  assert.equal(liveFromCompareStatus('diverged'), false);
  assert.equal(liveFromCompareStatus(undefined), null);
});

test('BRO-6730: UNKNOWN local ancestry resolves through the compare API', () => {
  const calls = [];
  const compare = (full, dep) => { calls.push([full, dep]); return 'ahead'; };
  assert.equal(resolveUnknownLiveness({ fullSha: 'a'.repeat(40), deployedSha: 'b'.repeat(40), compare }), true);
  assert.deepEqual(calls, [['a'.repeat(40), 'b'.repeat(40)]]);
  assert.equal(resolveUnknownLiveness({ fullSha: 'a', deployedSha: 'b', compare: () => 'behind' }), false);
});

test('BRO-6730: a failing or missing compare stays unknown (null), never a false live', () => {
  const logs = [];
  assert.equal(resolveUnknownLiveness({ fullSha: 'a', deployedSha: 'b', compare: () => { throw new Error('HTTP 403'); }, log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /403/);
  assert.equal(resolveUnknownLiveness({ fullSha: 'a', deployedSha: '', compare: () => 'ahead' }), null);
  assert.equal(resolveUnknownLiveness({ fullSha: 'a', deployedSha: 'b' }), null);
});

test('BRO-6730: check-prod-deploy isLive consults the fallback before returning unknown', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../scripts/check-prod-deploy.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function isLive('), src.indexOf('function isLiveViaGithub'));
  assert.ok(body.indexOf('resolveUnknownLiveness(') > body.indexOf("verdict === 'UNKNOWN'"), 'fallback must run inside the UNKNOWN branch');
  assert.ok(body.indexOf('resolveUnknownLiveness(') < body.indexOf('return null'), 'fallback must run before giving up');
});
