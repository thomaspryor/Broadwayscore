/**
 * BRO-4454 — the real /submit-review POST handler must create its PUBLIC
 * GitHub issue with no submitter email in it, while
 * the sealed contact still decrypts to the address for the notify emails.
 *
 * Requires the real route and the real helper; only global fetch is stubbed.
 * Env is set BEFORE the route is imported (route.ts reads GH_DISPATCH_TOKEN at
 * module load), and each POST uses its own x-forwarded-for to stay under the
 * route's 5-per-minute per-IP rate limit.
 *
 * Run: npx tsx --test src/app/api/__tests__/submit-review-pii-route.test.mjs
 */
import { register, createRequire } from 'node:module';
register('./next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { extractSubmitterEmail, CONTACT_HEADING, NOT_STORED } = require('../../../../scripts/lib/submitter-contact.js');
const { firstRealEmail } = require('../../../../scripts/lib/pii-scan.js');

const SECRET = 'route-test-secret';
const EMAIL = 'ada.lovelace@example.com';
const realFetch = globalThis.fetch;

process.env.GH_DISPATCH_TOKEN = 'test-token';
// Set so a regression re-adding the retired Notion write (BRO-4717) would
// fire a fetch to api.notion.com, which the stub below rejects as unexpected.
process.env.NOTION_API_KEY = 'test-notion';

function formData() {
  const fd = new FormData();
  fd.set('review_url', `https://www.nytimes.com/review-of-hamilton-${Math.random().toString(36).slice(2)}`);
  fd.set('show_name', 'Hamilton');
  fd.set('outlet_name', 'NYT');
  fd.set('notes', 'Please add.');
  fd.set('submitter_email', EMAIL);
  return fd;
}

async function submit(ip) {
  const captured = { issue: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.github.com/search/issues')) {
      return new Response(JSON.stringify({ total_count: 0 }), { status: 200 });
    }
    if (u.includes('api.github.com') && init?.method === 'POST') {
      captured.issue = init.body;
      return new Response(JSON.stringify({ number: 4454 }), { status: 201 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('./../submit-review/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest('http://localhost/api/submit-review', {
      method: 'POST',
      body: formData(),
      headers: { 'x-forwarded-for': ip },
    }));
    return { res, captured };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('issue payload carries no email; the sealed contact decrypts to it', async () => {
  process.env.APPROVAL_HMAC_SECRET = SECRET;
  const { res, captured } = await submit('10.44.54.1');
  assert.equal(res.status, 200);
  assert.ok(captured.issue, 'GitHub issue was created');
  assert.equal(firstRealEmail(captured.issue), null, 'GitHub issue request carries no email');
  const { body } = JSON.parse(captured.issue);
  assert.ok(body.includes(CONTACT_HEADING));
  assert.ok(!body.includes('### Submitter Email'), 'legacy plaintext heading is gone');
  assert.equal(extractSubmitterEmail(body, SECRET), EMAIL);
});

test('without APPROVAL_HMAC_SECRET the submission still succeeds and the email is dropped', async () => {
  delete process.env.APPROVAL_HMAC_SECRET;
  const { res, captured } = await submit('10.44.54.2');
  assert.equal(res.status, 200);
  assert.equal(firstRealEmail(captured.issue), null);
  assert.ok(JSON.parse(captured.issue).body.includes(`${CONTACT_HEADING}\n${NOT_STORED}`));
});
