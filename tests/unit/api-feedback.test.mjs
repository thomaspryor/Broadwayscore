/**
 * BRO-580 / BRO-2387 acceptance test — POST /api/feedback validates a
 * feedback submission and creates a page in Notion. Requires the real route
 * handler (no reimplemented logic, CLAUDE.md rule 15) and stubs the global
 * fetch used by src/lib/notion-api.ts so no NOTION_API_KEY is needed.
 *
 * src/app/api/__tests__/notion-write-is-non-fatal.test.mjs (BRO-3379/3382)
 * covers the "Notion write can never fail the request" contract; this file
 * covers the acceptance criterion itself — a valid submission validates and
 * DOES create a Notion page with the right data, and an invalid submission
 * is rejected before any Notion write is attempted.
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

test('valid submission is validated and creates a Notion page with the submitted data', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  let notionBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.notion.com')) {
      notionBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'fake-page', url: 'https://notion.so/fake-page' }), { status: 200 });
    }
    if (u.includes('formspree.io')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('../../src/app/api/feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData(),
      headers: { 'x-forwarded-for': '10.0.1.1' },
    });
    const res = await POST(req);
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

    assert.ok(notionBody, 'a Notion page create request must have been sent');
    assert.equal(notionBody.parent.data_source_id, 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6');
    assert.match(notionBody.properties.Name.title[0].text.content, /\[Bug Report\]/);
    assert.match(notionBody.properties.Name.title[0].text.content, /Hamilton/);
    assert.equal(notionBody.properties.Type.select.name, 'Fix');
    assert.match(notionBody.properties.Notes.rich_text[0].text.content, /score badge is missing/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NOTION_API_KEY;
  }
});

test('submission missing the required message field is rejected before any Notion write', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  let notionCalled = false;
  let formspreeCalled = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.notion.com')) {
      notionCalled = true;
      return new Response(JSON.stringify({ id: 'fake-page' }), { status: 200 });
    }
    if (u.includes('formspree.io')) {
      formspreeCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('../../src/app/api/feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData({ message: '' }),
      headers: { 'x-forwarded-for': '10.0.1.2' },
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errors[0].field, 'message');
    assert.equal(notionCalled, false, 'Notion must not be written to for an invalid submission');
    assert.equal(formspreeCalled, false, 'Formspree must not be called for an invalid submission');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NOTION_API_KEY;
  }
});

test('submission with an invalid email is rejected before any Notion write', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  let notionCalled = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.notion.com')) {
      notionCalled = true;
      return new Response(JSON.stringify({ id: 'fake-page' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('../../src/app/api/feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData({ email: 'not-an-email' }),
      headers: { 'x-forwarded-for': '10.0.1.3' },
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errors[0].field, 'email');
    assert.equal(notionCalled, false, 'Notion must not be written to for an invalid submission');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NOTION_API_KEY;
  }
});
