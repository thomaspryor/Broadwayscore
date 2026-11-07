/**
 * BRO-580 / BRO-2387 / BRO-3382 / BRO-4717 — POST /api/feedback validates a
 * feedback submission and forwards it to Formspree, the only real consumer
 * (process-feedback.yml polls it). Success is gated on Formspree's actual
 * response. The retired Notion board is never written to, even when
 * NOTION_API_KEY is set (BRO-4717 removed that additive dead-end write).
 *
 * Requires the real route handler (no reimplemented logic, CLAUDE.md rule 15)
 * and stubs the global fetch.
 *
 * Run: node --test tests/unit/api-feedback.test.mjs
 */
import { register } from 'node:module';
register('../../src/app/api/__tests__/next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;

function feedbackFormData(overrides = {}) {
  const fields = {
    name: 'Ada',
    email: 'ada@example.com',
    category: 'bug',
    show: 'Hamilton',
    message: 'The score badge is missing on the Hamilton page.',
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) fd.set(key, value);
  }
  return fd;
}

// Formspree responder is configurable; any other host (Notion included) is a test failure.
function stubFetch(formspree) {
  const calls = { formspree: 0, other: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('formspree.io')) {
      calls.formspree++;
      return formspree();
    }
    calls.other.push(u);
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  return calls;
}

async function post(fd, ip) {
  const { POST } = await import('../../src/app/api/feedback/route.ts');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('http://localhost/api/feedback', {
    method: 'POST',
    body: fd,
    headers: { 'x-forwarded-for': ip },
  }));
}

test('valid submission is forwarded to Formspree and never touches Notion', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const res = await post(feedbackFormData(), '10.0.1.1');
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
    assert.equal(calls.formspree, 1, 'Formspree (the real consumer) must receive the submission');
    assert.deepEqual(calls.other, [], 'no other destination (e.g. api.notion.com) may be called');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NOTION_API_KEY;
  }
});

test('submission missing the required message field is rejected before Formspree', async () => {
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const res = await post(feedbackFormData({ message: '' }), '10.0.1.2');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errors[0].field, 'message');
    assert.equal(calls.formspree, 0, 'Formspree must not be called for an invalid submission');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submission with an invalid email is rejected before Formspree', async () => {
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const res = await post(feedbackFormData({ email: 'not-an-email' }), '10.0.1.3');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errors[0].field, 'email');
    assert.equal(calls.formspree, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('returns 502 when Formspree rejects the submission (BRO-3382)', async () => {
  stubFetch(() => new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: 429 }));
  try {
    const res = await post(feedbackFormData(), '10.0.1.4');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.errors?.[0]?.message, 'error response must include a user-visible message');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('returns 502 when Formspree is unreachable', async () => {
  stubFetch(() => { throw new Error('simulated network failure'); });
  try {
    const res = await post(feedbackFormData(), '10.0.1.5');
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});
