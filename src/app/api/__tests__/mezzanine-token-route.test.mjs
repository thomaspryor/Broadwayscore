/**
 * BRO-5235: the real /api/admin/mezzanine-token GET + POST handlers.
 * GET: only a signed, unexpired link shows the form. POST: only a same-origin
 * form post with a valid link and a findable token dispatches, and the
 * dispatch carries the sealed token, never the raw one.
 *
 * Only global fetch is stubbed. Run: npx tsx --test src/app/api/__tests__/mezzanine-token-route.test.mjs
 */
import { register, createRequire } from 'node:module';
register('./next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const m = require('../../../../scripts/lib/mezzanine-token-renewal.js');

const SECRET = 'route-test-secret';
process.env.APPROVAL_HMAC_SECRET = SECRET;
process.env.GH_DISPATCH_TOKEN = 'test-dispatch';
const realFetch = globalThis.fetch;
const TOKEN = 'r:0123456789abcdef0123456789abcdef';
const URL_BASE = 'https://broadwayscorecard.com/api/admin/mezzanine-token';

function signed(nowMs = Date.now()) {
  const u = new URL(m.buildStartLink(SECRET, nowMs).url);
  return { e: u.searchParams.get('e'), s: u.searchParams.get('s'), search: u.search };
}

async function get(query) {
  const { GET } = await import('../admin/mezzanine-token/route.ts');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`${URL_BASE}${query}`));
}

async function post(fields, { headers = {}, dispatchStatus = 204 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    return new Response(null, { status: dispatchStatus });
  };
  try {
    const { POST } = await import('../admin/mezzanine-token/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://broadwayscorecard.com', ...headers },
      body: new URLSearchParams(fields).toString(),
    }));
    res.calls = calls;
    res.html = await res.text();
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a signed link shows the form with same-origin referrer policy', async () => {
  const q = signed();
  const res = await get(q.search);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.ok(html.includes('name="token"'));
  assert.ok(html.includes(`value="${q.s}"`));
  assert.ok(html.includes('Remove Profile'));
});

test('unsigned, tampered, expired and other-flow links never show the form', async () => {
  const gmail = require('../../../../scripts/lib/gmail-reauth.js');
  const gq = new URL(gmail.buildStartLink(SECRET).url).search;
  for (const [q, status] of [
    ['', 403],
    [signed().search.replace(/s=([0-9a-f])/, (_, c) => `s=${c === 'a' ? 'b' : 'a'}`), 403],
    [signed(Date.now() - 31 * 86400 * 1000).search, 410],
    [gq, 403],
  ]) {
    const res = await get(q);
    assert.equal(res.status, status, q);
    assert.ok(!(await res.text()).includes('name="token"'));
  }
});

test('a valid same-origin post dispatches only the sealed token', async () => {
  const { e, s } = signed();
  const res = await post({ e, s, token: `GET /parse/classes/Show HTTP/1.1\nX-Parse-Session-Token: ${TOKEN}\n` });
  assert.equal(res.status, 200, res.html);
  assert.equal(res.calls.length, 1);
  assert.ok(res.calls[0].url.endsWith('/actions/workflows/mezzanine-token.yml/dispatches'));
  const body = JSON.parse(res.calls[0].body);
  assert.equal(body.inputs.mode, 'complete');
  assert.equal(body.inputs.issue, 'BRO-5235');
  assert.ok(!res.calls[0].body.includes(TOKEN.slice(2)), 'raw token leaked into the dispatch');
  assert.equal(m.openToken(body.inputs.sealed, SECRET).token, TOKEN);
  assert.ok(!res.html.includes(TOKEN.slice(2)));
});

test('cross-origin, null-origin, wrong type and bad links never dispatch', async () => {
  const { e, s } = signed();
  const cases = [
    [{ e, s, token: TOKEN }, { headers: { origin: 'https://evil.example' } }, 403],
    [{ e, s, token: TOKEN }, { headers: { origin: 'null' } }, 403],
    [{ e, s, token: TOKEN }, { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } }, 403],
    [{ e, s, token: TOKEN }, { headers: { 'content-type': 'text/plain' } }, 415],
    [{ e, s: s.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), token: TOKEN }, {}, 403],
    [{ e, s, token: 'hello there' }, {}, 400],
    [{ e, s, token: 'x'.repeat(m.MAX_FORM_BYTES + 10) }, {}, 413],
  ];
  for (const [fields, opts, status] of cases) {
    const res = await post(fields, opts);
    assert.equal(res.status, status, JSON.stringify(opts));
    assert.equal(res.calls.length, 0);
  }
});

test('null origin with sec-fetch-site same-origin is accepted', async () => {
  const { e, s } = signed();
  const res = await post({ e, s, token: TOKEN }, { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
  assert.equal(res.status, 200);
  assert.equal(res.calls.length, 1);
});

test('a failed dispatch re-shows the form with an error and no token', async () => {
  const { e, s } = signed();
  const res = await post({ e, s, token: TOKEN }, { dispatchStatus: 500 });
  assert.equal(res.status, 502);
  assert.ok(res.html.includes('name="token"'));
  assert.ok(!res.html.includes(TOKEN.slice(2)));
});

test('kill switch hides both handlers', async () => {
  process.env.MEZZANINE_TOKEN_FORM_DISABLED = 'true';
  try {
    assert.equal((await get(signed().search)).status, 404);
    const { e, s } = signed();
    const res = await post({ e, s, token: TOKEN });
    assert.equal(res.status, 404);
    assert.equal(res.calls.length, 0);
  } finally {
    delete process.env.MEZZANINE_TOKEN_FORM_DISABLED;
  }
});
