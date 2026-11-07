/**
 * BRO-4718 — the morning digest's signed "Fix this" tap (POST
 * /api/autonomous-action?action=dispatch) files a Linear issue in Todo,
 * dedupes against an open issue for the same condition, fails visibly when
 * LINEAR_API_KEY is missing, and never touches Notion. The retired
 * approve/reject/revert actions answer 410.
 *
 * Real route handler + real link signer (scripts/lib/dispatch-link.js); only
 * global fetch is stubbed.
 *
 * Run: node --test tests/unit/api-autonomous-action-dispatch.test.mjs
 */
import { register, createRequire } from 'node:module';
register('../../src/app/api/__tests__/next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { buildDispatchUrl } = require('../../scripts/lib/dispatch-link.js');
const { buildActionUrl } = require('../../scripts/lib/autonomous-links.js');
const { conditionSearchPrefix } = require('../../src/lib/linear-dispatch-issue.js');

const SECRET = 'dispatch-test-secret';
const realFetch = globalThis.fetch;
const KEY = 'health-check:Data: something stuck';

function signedUrl(conditionKey = KEY) {
  return buildDispatchUrl({
    conditionKey, title: 'BSC Daily: Data: something stuck', description: '3 items stuck',
    exp: Math.floor(Date.now() / 1000) + 3600, secret: SECRET, baseUrl: 'http://localhost',
  });
}

// Linear stub: `open` is the list the dedupe query returns (before / after create).
function stubLinear({ openBefore = [], openAfter = null } = {}) {
  const calls = { creates: [], archives: [], queries: 0, other: [] };
  let created = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith('https://api.linear.app/graphql')) {
      calls.other.push(u);
      throw new Error(`unexpected fetch: ${u}`);
    }
    const { query, variables } = JSON.parse(init.body);
    const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });
    if (/issueCreate/.test(query)) {
      calls.creates.push(variables.input);
      created = { id: 'new-id', identifier: 'BRO-9999', url: 'https://linear.app/x/issue/BRO-9999', createdAt: '2026-10-12T10:00:00Z', state: { type: 'unstarted' } };
      return ok({ issueCreate: { success: true, issue: created } });
    }
    if (/issueArchive/.test(query)) { calls.archives.push(variables.id); return ok({ issueArchive: { success: true } }); }
    if (/teams\(/.test(query)) {
      return ok({ teams: { nodes: [{ id: 'team-1', states: { nodes: [{ id: 's-back', name: 'Backlog', type: 'backlog' }, { id: 's-todo', name: 'Todo', type: 'unstarted' }] } }] } });
    }
    if (/issues\(/.test(query)) {
      calls.queries++;
      // Linear's contains never matches the full anchor it stores escaped
      // (BRO-5170), so the route searches by the raw prefix.
      assert.equal(variables.anchor, conditionSearchPrefix(KEY));
      const nodes = (created ? (openAfter || [created]) : openBefore)
        .map(n => ({ description: `body\n\n\\[conditionKey:${KEY}\\]`, ...n }));
      return ok({ issues: { nodes } });
    }
    throw new Error(`unexpected GraphQL: ${query.slice(0, 80)}`);
  };
  return calls;
}

async function call(urlStr, method = 'POST') {
  const { POST, GET } = await import('../../src/app/api/autonomous-action/route.ts');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(urlStr, { method });
  const res = await (method === 'POST' ? POST(req) : GET(req));
  return { status: res.status, body: await res.text() };
}

function withEnv(env, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

test('a tap files one Linear issue in Todo with the dedupe anchor and a runnable acceptance command', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test', NOTION_API_KEY: 'set-but-must-not-be-used' },
  async () => {
    const calls = stubLinear();
    const res = await call(signedUrl());
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /Queued/);
    assert.match(res.body, /BRO-9999/);
    assert.equal(calls.creates.length, 1);
    const input = calls.creates[0];
    assert.equal(input.teamId, 'team-1');
    assert.equal(input.stateId, 's-todo');
    assert.equal(input.priority, 2);
    assert.match(input.description, /\[conditionKey:health-check:Data: something stuck\]/);
    assert.match(input.description, /`node scripts\/check-health-row-absent\.js --row-b64 /);
    assert.deepEqual(calls.other, [], 'no non-Linear destination (e.g. api.notion.com) may be called');
  }));

test('an open issue for the same condition makes a repeat tap a no-op', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test' },
  async () => {
    const calls = stubLinear({ openBefore: [{ id: 'old', identifier: 'BRO-1234', url: 'https://linear.app/x/issue/BRO-1234', createdAt: '2026-10-01T00:00:00Z', state: { type: 'started' } }] });
    const res = await call(signedUrl());
    assert.equal(res.status, 200);
    assert.match(res.body, /Already Being Fixed/);
    assert.match(res.body, /BRO-1234/);
    assert.equal(calls.creates.length, 0);
  }));

test('a create that loses a race to an earlier issue archives itself', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test' },
  async () => {
    const earlier = { id: 'racer', identifier: 'BRO-1', url: 'https://linear.app/x/issue/BRO-1', createdAt: '2026-10-12T09:59:59Z', state: { type: 'unstarted' } };
    const ours = { id: 'new-id', identifier: 'BRO-9999', url: 'u', createdAt: '2026-10-12T10:00:00Z', state: { type: 'unstarted' } };
    const calls = stubLinear({ openAfter: [ours, earlier] });
    const res = await call(signedUrl());
    assert.match(res.body, /Already Being Fixed/);
    assert.deepEqual(calls.archives, ['new-id']);
  }));

test('missing LINEAR_API_KEY fails visibly with a 500 page and files nothing', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: undefined },
  async () => {
    const calls = stubLinear();
    const res = await call(signedUrl());
    assert.equal(res.status, 500);
    assert.match(res.body, /Could Not Start the Fix/);
    assert.match(res.body, /not configured/);
    assert.equal(calls.creates.length + calls.queries, 0);
  }));

test('a Linear outage on the dedupe query fails closed (502), never files', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test' },
  async () => {
    globalThis.fetch = async () => new Response('boom', { status: 503 });
    const res = await call(signedUrl());
    assert.equal(res.status, 502);
    assert.match(res.body, /Could Not Check/);
  }));

test('GET never mutates: it renders the confirm form', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test' },
  async () => {
    const calls = stubLinear();
    const res = await call(signedUrl(), 'GET');
    assert.equal(res.status, 200);
    assert.match(res.body, /<form method="POST"/);
    assert.equal(calls.creates.length + calls.queries, 0);
  }));

test('a tampered signature is refused', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test' },
  async () => {
    stubLinear();
    const res = await call(signedUrl().replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`));
    assert.equal(res.status, 403);
  }));

test('retired approve/reject/revert links answer 410 and touch nothing', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test', NOTION_API_KEY: 'x' },
  async () => {
    const calls = stubLinear();
    for (const action of ['approve', 'reject', 'revert']) {
      const url = buildActionUrl({ action, cardId: 'abc', branch: 'auto/x', exp: Math.floor(Date.now() / 1000) + 3600, secret: SECRET, baseUrl: 'http://localhost' });
      const res = await call(url);
      assert.equal(res.status, 410, action);
      assert.match(res.body, /Retired/);
    }
    assert.equal(calls.creates.length + calls.queries + calls.other.length, 0);
  }));

// BRO-5170: the prefix search also returns issues whose key merely starts with
// ours; the exact client-side anchor check must ignore them.
test('an open issue for a longer key that shares the prefix does not block a tap', withEnv(
  { APPROVAL_HMAC_SECRET: SECRET, LINEAR_API_KEY: 'lin_test', DISPATCH_LINKS_DISABLED: undefined },
  async () => {
    const decoy = { id: 'decoy', identifier: 'BRO-77', url: 'u', createdAt: '2026-10-01T00:00:00Z', state: { type: 'started' },
      description: `\\[conditionKey:${KEY} and more\\]` };
    const calls = stubLinear({ openBefore: [decoy] });
    const { body } = await call(signedUrl());
    assert.equal(calls.creates.length, 1, body);
  }));
