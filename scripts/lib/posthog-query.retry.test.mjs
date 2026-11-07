/**
 * BRO-5998: PostHog 503 clickhouse_at_capacity failed Weekly A/B Monitors twice.
 * phQueryFull must retry 429/502/503, not other statuses.
 * Run: node --test scripts/lib/posthog-query.retry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.POSTHOG_PERSONAL_API_KEY = 'test';
const { phQueryFull } = require('./posthog-query.js');

const resp = (status, body = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const seq = (...rs) => { const calls = []; const f = async () => { calls.push(1); return rs[Math.min(calls.length - 1, rs.length - 1)]; }; f.calls = calls; return f; };
const sleep = async () => {};

test('retries 503 then succeeds', async () => {
  const f = seq(resp(503), resp(503), resp(200, { results: [[1]] }));
  const out = await phQueryFull('select 1', { fetch: f, sleep });
  assert.deepEqual(out.results, [[1]]);
  assert.equal(f.calls.length, 3);
});

test('gives up after 4 attempts on persistent 503', async () => {
  const f = seq(resp(503));
  await assert.rejects(phQueryFull('select 1', { fetch: f, sleep }), /PostHog API 503/);
  assert.equal(f.calls.length, 4);
});

test('does not retry 400/401', async () => {
  for (const s of [400, 401]) {
    const f = seq(resp(s));
    await assert.rejects(phQueryFull('select 1', { fetch: f, sleep }), new RegExp(`PostHog API ${s}`));
    assert.equal(f.calls.length, 1);
  }
});
