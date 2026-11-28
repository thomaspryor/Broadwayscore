import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { shouldProxy, withProxyAgent } = require('../../scripts/lib/cloud-proxy.js');

const cloud = { CLAUDE_CODE_REMOTE: 'true', HTTPS_PROXY: 'http://127.0.0.1:40223' };

test('shouldProxy: only ScrapingBee hosts, only in a cloud session with a proxy', () => {
  assert.equal(shouldProxy('app.scrapingbee.com', cloud), true);
  assert.equal(shouldProxy('scrapingbee.com', cloud), true);
  assert.equal(shouldProxy('api.scrapingdog.com', cloud), false);
  assert.equal(shouldProxy('evilscrapingbee.com', cloud), false);
  assert.equal(shouldProxy('app.scrapingbee.com', { HTTPS_PROXY: cloud.HTTPS_PROXY }), false);
  assert.equal(shouldProxy('app.scrapingbee.com', { CLAUDE_CODE_REMOTE: 'true' }), false);
});

test('withProxyAgent: injects an agent for (url, opts, cb), (url, cb) and (opts)', () => {
  const cb = () => {};
  const u = 'https://app.scrapingbee.com/api/v1/?x=1';
  const a = withProxyAgent([u, { timeout: 5 }, cb], cloud);
  assert.ok(a[1].agent); assert.equal(a[1].timeout, 5); assert.equal(a[2], cb);
  const b = withProxyAgent([u, cb], cloud);
  assert.ok(b[1].agent); assert.equal(b[2], cb);
  const c = withProxyAgent([{ hostname: 'app.scrapingbee.com', path: '/' }], cloud);
  assert.ok(c[0].agent);
});

test('withProxyAgent: leaves other hosts and explicit agents alone', () => {
  const other = ['https://api.resend.com/emails', {}];
  assert.deepEqual(withProxyAgent(other, cloud), other);
  const mine = {};
  const r = withProxyAgent(['https://app.scrapingbee.com/', { agent: mine }], cloud);
  assert.equal(r[1].agent, mine);
  const off = ['https://app.scrapingbee.com/', {}];
  assert.deepEqual(withProxyAgent(off, {}), off);
});

test('withProxyAgent: URL object and explicit agent:false', () => {
  const a = withProxyAgent([new URL('https://app.scrapingbee.com/api/v1/usage')], cloud);
  assert.ok(a[1].agent);
  const f = withProxyAgent(['https://app.scrapingbee.com/', { agent: false }], cloud);
  assert.equal(f[1].agent, false);
});

test('install: wraps an existing https.get instead of rebuilding it on https.request', () => {
  const https = require('https');
  const saved = { request: https.request, get: https.get };
  const calls = [];
  try {
    https.request = (...a) => { calls.push(['request', a[0]]); return { end() {} }; };
    https.get = (...a) => { calls.push(['get', a[0]]); return { end() {} }; };
    require('../../scripts/lib/cloud-proxy.js').install();
    https.get('https://api.scrapingdog.com/scrape');
    assert.deepEqual(calls, [['get', 'https://api.scrapingdog.com/scrape']]);
  } finally {
    https.request = saved.request; https.get = saved.get;
  }
});

test('reports why ScrapingBee is not proxied, including a missing agent', () => {
  const { proxyStatus } = require('../../scripts/lib/cloud-proxy.js');
  assert.match(proxyStatus('app.scrapingbee.com', {}).reason, /CLAUDE_CODE_REMOTE/);
  assert.match(proxyStatus('app.scrapingbee.com', { CLAUDE_CODE_REMOTE: 'true' }).reason, /HTTPS_PROXY/);
  assert.match(proxyStatus('app.scrapingbee.com', cloud, () => null).reason, /https-proxy-agent/);
  assert.equal(proxyStatus('app.scrapingbee.com', cloud, () => ({})).reason, null);
  assert.equal(shouldProxy('app.scrapingbee.com', cloud), true);
  assert.deepEqual(withProxyAgent(['https://app.scrapingbee.com/'], cloud, () => null), ['https://app.scrapingbee.com/']);
});

test('missing package is diagnosed by the real agent loader', () => {
  const script = `
    const Module = require('module');
    const load = Module._load;
    Module._load = function(name, ...rest) {
      if (name === 'https-proxy-agent') throw new Error('module unavailable');
      return load.call(this, name, ...rest);
    };
    const { proxyStatus, withProxyAgent } = require('./scripts/lib/cloud-proxy');
    const env = { CLAUDE_CODE_REMOTE: 'true', HTTPS_PROXY: 'http://127.0.0.1:1' };
    const args = ['https://app.scrapingbee.com/'];
    if (!/https-proxy-agent/.test(proxyStatus('app.scrapingbee.com', env).reason)) process.exit(1);
    if (withProxyAgent(args, env) !== args) process.exit(2);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_REMOTE: 'false' } });
  assert.equal(result.status, 0, result.stderr);
});
