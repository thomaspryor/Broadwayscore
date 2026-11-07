// BRO-6872: Node's happy-eyeballs 250 ms per-address timer turned event-loop pauses into "fetch failed (ETIMEDOUT)"
// on GitHub runners (the IPv4 attempt is cut off, the unreachable IPv6 fallback fails at once). scripts/lib/ipv4-connections.js
// turns the timer off. Each case runs in its own process because the setting is process-wide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lib = (f) => JSON.stringify(path.join(ROOT, 'scripts/lib', f));

function runChild(code, env = {}) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NET_AUTOSELECT_FAMILY: '', GITHUB_ACTIONS: 'true', ...env }, timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// A server on 127.0.0.1 only and a host that resolves to [127.0.0.1, ::1]; ::1 fails at once (refused, or no IPv6 at
// all) on Linux and macOS, as IPv6 does on a runner. The loop pauses 400 ms right after the first attempt starts, as a large page parse would.
const STALLED_CONNECT = (requireLine) => `
${requireLine}
const net = require('net'); const http = require('http');
const lookup = (host, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; }
  const all = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  setImmediate(() => (opts && opts.all ? cb(null, all) : cb(null, all[0].address, 4))); }; // async, like real DNS
const srv = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => {
  const s = net.connect({ host: 'two-address.test', port: srv.address().port, lookup });
  let paused = false;
  s.on('connectionAttempt', () => { if (paused) return; paused = true; process.nextTick(() => { const end = Date.now() + 400; while (Date.now() < end); }); });
  const done = (o) => { s.destroy(); srv.close(); console.log(JSON.stringify(o)); };
  s.on('connect', () => done({ ok: true }));
  s.on('error', (e) => done({ ok: false, code: e.code }));
});`;

test('without the module a 400 ms pause kills a connection the server answered (the CI failure)', () => {
  const r = runChild(STALLED_CONNECT(''), { NET_AUTOSELECT_FAMILY: 'on' });
  assert.deepEqual(r, { ok: false, code: 'ETIMEDOUT' });
});

test('with the module the same paused connection succeeds', () => {
  const r = runChild(STALLED_CONNECT(`require(${lib('ipv4-connections.js')});`));
  assert.deepEqual(r, { ok: true });
});

test('scraper.js and rss-discovery.js each switch the process to one IPv4-first attempt', () => {
  for (const f of ['scraper.js', 'rss-discovery.js']) {
    const r = runChild(`require(${lib(f)}); console.log(JSON.stringify({ auto: require('net').getDefaultAutoSelectFamily(), order: require('dns').getDefaultResultOrder() }));`);
    assert.deepEqual(r, { auto: false, order: 'ipv4first' }, f);
  }
});

test('NET_AUTOSELECT_FAMILY=on leaves Node defaults alone', () => {
  const r = runChild(`require(${lib('ipv4-connections.js')}); console.log(JSON.stringify({ auto: require('net').getDefaultAutoSelectFamily() }));`, { NET_AUTOSELECT_FAMILY: 'on' });
  assert.deepEqual(r, { auto: true });
});

test('off GitHub Actions (the Mac, cloud sessions) Node defaults stay', () => {
  const r = runChild(`require(${lib('ipv4-connections.js')}); console.log(JSON.stringify({ auto: require('net').getDefaultAutoSelectFamily() }));`, { GITHUB_ACTIONS: '' });
  assert.deepEqual(r, { auto: true });
});
