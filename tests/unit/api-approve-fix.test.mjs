/**
 * BRO-5262 — emailed approval links must not act on GET. Mail-security link
 * scanners and preview fetchers open every URL in an email, so GET on
 * /api/approve-fix and /api/dispatch-alert-fix renders a confirm page and
 * dispatches nothing; only the POST that page submits calls GitHub. The link
 * format is unchanged, so emails already sent keep working.
 *
 * Real route handlers + real link signers (scripts/lib/approval-link.js,
 * scripts/health-check.js generateApproveUrl); only global fetch is stubbed.
 *
 * Run: node --test tests/unit/api-approve-fix.test.mjs
 */
import { register, createRequire } from 'node:module';
register('../../src/app/api/__tests__/next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { generateApprovalUrl } = require('../../scripts/lib/approval-link.js');

const SECRET = 'approve-fix-test-secret';
const ALERT_SECRET = 'alert-token-test-secret';
const realFetch = globalThis.fetch;

function stubGithub() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(null, { status: 204 });
  };
  return calls;
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

async function call(mod, urlStr, method, { body, headers } = {}) {
  const route = await import(mod);
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(urlStr, { method, body, headers });
  const res = await route[method](req);
  return { status: res.status, body: await res.text() };
}

// What a browser sends when the owner presses the confirm button.
const FORM = { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
const submit = (mod, urlStr) => call(mod, urlStr, 'POST', { body: 'confirm=1', headers: FORM });

const APPROVE_ROUTE = '../../src/app/api/approve-fix/route.ts';
const ALERT_ROUTE = '../../src/app/api/dispatch-alert-fix/route.ts';
const ENV = { APPROVAL_HMAC_SECRET: SECRET, GH_DISPATCH_TOKEN: 'gh_test', GITHUB_REPO: 'o/r' };
const link = (action, issue = '42') =>
  generateApprovalUrl(action, issue, SECRET, 'plan-uuid-1', { baseUrl: 'http://localhost' });

// The form the confirm page renders must POST back to the same signed URL.
function formAction(body) {
  const m = body.match(/<form method="POST" action="([^"]+)"/);
  assert.ok(m, `confirm page has a POST form: ${body.slice(0, 300)}`);
  return `http://localhost${m[1].replace(/&amp;/g, '&')}`;
}

test('approve-fix GET with a valid link shows a confirm page and calls nothing', withEnv(ENV, async () => {
  const calls = stubGithub();
  const res = await call(APPROVE_ROUTE, link('approve'), 'GET');
  assert.equal(res.status, 200);
  assert.match(res.body, /Approve this fix\?/);
  assert.match(res.body, /issue #42/);
  assert.match(res.body, />Approve fix</);
  assert.deepEqual(calls, [], 'GET must not touch GitHub');
}));

test('approve-fix: the confirm form POST dispatches execute-approved-fix in apply mode', withEnv(ENV, async () => {
  const calls = stubGithub();
  const page = await call(APPROVE_ROUTE, link('approve'), 'GET');
  const res = await submit(APPROVE_ROUTE, formAction(page.body));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Fix Approved/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/workflows/execute-approved-fix.yml/dispatches');
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { issue_number: '42', plan_id: 'plan-uuid-1', mode: 'apply' } });
}));

test('approve-fix reject: GET confirms only, POST comments, labels and persists the rejection', withEnv(ENV, async () => {
  const calls = stubGithub();
  const page = await call(APPROVE_ROUTE, link('reject'), 'GET');
  assert.match(page.body, /Reject this fix\?/);
  assert.match(page.body, />Reject fix</);
  assert.deepEqual(calls, []);
  const res = await submit(APPROVE_ROUTE, formAction(page.body));
  assert.match(res.body, /Fix Rejected/);
  assert.deepEqual(calls.map((c) => c.url.replace('https://api.github.com/repos/o/r', '')), [
    '/issues/42/comments', '/issues/42/labels', '/actions/workflows/execute-approved-fix.yml/dispatches',
  ]);
  assert.equal(calls[2].body.inputs.mode, 'reject');
}));

test('approve-fix: a systematic plan id keeps working through the confirm round trip', withEnv(ENV, async () => {
  const calls = stubGithub();
  const page = await call(APPROVE_ROUTE, link('approve', '42-systematic'), 'GET');
  assert.match(page.body, /systematic fix for issue #42/);
  await submit(APPROVE_ROUTE, formAction(page.body));
  assert.equal(calls[0].body.inputs.issue_number, '42-systematic');
}));

test('approve-fix: bad, tampered and expired links never show a button or dispatch', withEnv(ENV, async () => {
  const calls = stubGithub();
  const good = link('approve');
  const flipped = good.replace('action=approve', 'action=reject');
  const junk = good.replace(/token=([0-9a-f]{60})[0-9a-f]{4}/, 'token=$1zzzz');
  const expired = generateApprovalUrl('approve', '42', SECRET, 'plan-uuid-1', { baseUrl: 'http://localhost', now: Date.now() - 8 * 86400000 });
  const otherPlan = good.replace('plan=plan-uuid-1', 'plan=plan-uuid-2');
  for (const [u, status] of [[flipped, 403], [junk, 403], [expired, 410], [otherPlan, 403], ['http://localhost/api/approve-fix?issue=42', 400]]) {
    for (const method of ['GET', 'POST']) {
      const res = method === 'POST' ? await submit(APPROVE_ROUTE, u) : await call(APPROVE_ROUTE, u, method);
      assert.equal(res.status, status, `${method} ${u}`);
      assert.doesNotMatch(res.body, /<form/);
    }
  }
  assert.deepEqual(calls, []);
}));

// dispatch-alert-fix: same bug, links minted by scripts/health-check.js.
async function alertLink(workflow = 'rebuild-reviews.yml', title = 'Reviews <stale>') {
  process.env.ALERT_TOKEN_SECRET = ALERT_SECRET;
  const { generateApproveUrl } = require('../../scripts/health-check.js');
  return generateApproveUrl(workflow, title).replace('https://broadwayscorecard.com', 'http://localhost');
}

test('dispatch-alert-fix GET shows a confirm page and calls nothing; POST dispatches', withEnv(
  { ALERT_TOKEN_SECRET: ALERT_SECRET, REVIEW_TEXTS_TOKEN: 'gh_test' }, async () => {
    const calls = stubGithub();
    const url = await alertLink();
    const page = await call(ALERT_ROUTE, url, 'GET');
    assert.equal(page.status, 200);
    assert.match(page.body, /Run this fix\?/);
    assert.match(page.body, /Reviews &lt;stale&gt;/, 'alert title is escaped');
    assert.deepEqual(calls, [], 'GET must not touch GitHub');
    const res = await submit(ALERT_ROUTE, formAction(page.body));
    assert.equal(res.status, 200, res.body);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/actions\/workflows\/rebuild-reviews\.yml\/dispatches$/);
  }));

test('dispatch-alert-fix: invalid or unknown-fix tokens get no button and no dispatch', withEnv(
  { ALERT_TOKEN_SECRET: ALERT_SECRET, REVIEW_TEXTS_TOKEN: 'gh_test' }, async () => {
    const calls = stubGithub();
    const unknown = await alertLink('evil.yml');
    const tampered = (await alertLink()).replace(/token=./, 'token=X');
    for (const u of [unknown, tampered, 'http://localhost/api/dispatch-alert-fix']) {
      for (const method of ['GET', 'POST']) {
        const res = method === 'POST' ? await submit(ALERT_ROUTE, u) : await call(ALERT_ROUTE, u, method);
        assert.equal(res.status, 400, `${method} ${u}`);
        assert.doesNotMatch(res.body, /<form/);
      }
    }
    assert.deepEqual(calls, []);
  }));

test('a POST without the form field, or from another site, changes nothing (blind probes)', withEnv(
  { ...ENV, ALERT_TOKEN_SECRET: ALERT_SECRET, REVIEW_TEXTS_TOKEN: 'gh_test' }, async () => {
    const calls = stubGithub();
    const page = await call(APPROVE_ROUTE, link('approve'), 'GET');
    assert.match(page.body, /<input type="hidden" name="confirm" value="1">/);
    const target = formAction(page.body);
    for (const opts of [{}, { body: 'confirm=0', headers: FORM }, { body: 'confirm=1', headers: { ...FORM, 'sec-fetch-site': 'cross-site' } }]) {
      const res = await call(APPROVE_ROUTE, target, 'POST', opts);
      assert.equal(res.status, 400);
      assert.match(res.body, /Nothing Was Changed/);
    }
    const alertPage = await call(ALERT_ROUTE, await alertLink(), 'GET');
    const res = await call(ALERT_ROUTE, formAction(alertPage.body), 'POST');
    assert.equal(res.status, 400);
    assert.match(res.body, /Nothing was changed/);
    assert.deepEqual(calls, []);
  }));

test('approve-fix: an uppercased token from a mail client still works', withEnv(ENV, async () => {
  const calls = stubGithub();
  const upper = link('approve').replace(/token=([0-9a-f]{64})/, (_, t) => `token=${t.toUpperCase()}`);
  const page = await call(APPROVE_ROUTE, upper, 'GET');
  assert.equal(page.status, 200);
  await submit(APPROVE_ROUTE, formAction(page.body));
  assert.equal(calls.length, 1);
}));
