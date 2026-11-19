import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitReady, allPaths } from './cloud-visual-qa.mjs';
import { devServerReachable } from './lib/dev-server-reachable.mjs';

const html = '<html>' + 'x'.repeat(1100) + '</html>';
const ok = () => ({ ok: true, status: 200, text: async () => html });

test('waitReady probes "/" with the shared check, then warms each requested path', async () => {
  const probed = []; const warmed = [];
  const r = await waitReady('http://h', ['/my-shows', '/show/hamilton'], { exitCode: null }, {
    reachable: async (u) => { probed.push(u); return { ok: true }; },
    fetchImpl: async (u) => { warmed.push(u); return ok(); },
  });
  assert.equal(r, true);
  assert.deepEqual(probed, ['http://h/']);
  assert.deepEqual(warmed, ['http://h/my-shows', 'http://h/show/hamilton']);
});

test('waitReady is false (and warms nothing) when "/" never comes up or the server exited', async () => {
  const warmed = [];
  assert.equal(await waitReady('http://h', ['/a'], { exitCode: null }, { reachable: async () => ({ ok: false }), fetchImpl: async (u) => { warmed.push(u); } }), false);
  assert.deepEqual(warmed, []);
});

test('devServerReachable retries through a slow cold compile instead of failing on the first miss', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; if (calls < 3) throw new Error('timeout'); return ok(); };
  const r = await devServerReachable('http://h/', { totalMs: 5000, pauseMs: 5, fetchImpl });
  assert.equal(r.ok, true); assert.equal(calls, 3);
});

test('devServerReachable still rejects a blank or non-HTML page once the deadline passes', async () => {
  const small = async () => ({ ok: true, status: 200, text: async () => '<html></html>' });
  const r = await devServerReachable('http://h/', { totalMs: 30, pauseMs: 5, fetchImpl: small });
  assert.equal(r.ok, false); assert.match(r.reason, /too small/);
  const err = await devServerReachable('http://h/', { totalMs: 30, pauseMs: 5, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.match(err.reason, /HTTP 500/);
});

test('devServerReachable gives up at once when the dev server process died', async () => {
  const r = await devServerReachable('http://h/', { totalMs: 5000, shouldAbort: () => true, fetchImpl: ok });
  assert.equal(r.ok, false);
});

test('allPaths reads --paths= and --paths forms', () => {
  assert.deepEqual(allPaths(['--paths=/a,/b']), ['/a', '/b']);
  assert.deepEqual(allPaths(['--paths', '/a']), ['/a']);
  assert.deepEqual(allPaths([]), ['/']);
});
