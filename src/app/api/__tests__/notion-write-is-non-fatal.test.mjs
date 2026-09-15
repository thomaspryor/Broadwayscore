/**
 * BRO-3379 — src/app/api/feedback/route.ts and src/app/api/submit-review/route.ts
 * each persist to a real consumer (Formspree / a GitHub issue) BEFORE making
 * an additive write to the retired Notion board. The Notion write must never
 * be able to turn an already-successful submission into a 5xx.
 *
 * Requires the real route handlers (no reimplemented logic) and stubs the
 * global fetch used by src/lib/notion-api.ts to simulate a Notion outage.
 *
 * Run: node --test src/app/api/__tests__/notion-write-is-non-fatal.test.mjs
 */
import { register } from 'node:module';
register('./next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;

function stubFetch({ formspreeCalled, githubIssueCalled }) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.notion.com')) {
      throw new Error('simulated Notion outage');
    }
    if (u.includes('formspree.io')) {
      formspreeCalled.hit = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes('api.github.com/search/issues')) {
      return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
    }
    if (u.includes('api.github.com') && init?.method === 'POST') {
      githubIssueCalled.hit = true;
      return new Response(JSON.stringify({ number: 4242 }), { status: 201 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

function feedbackFormData() {
  const fd = new FormData();
  fd.set('name', 'Ada');
  fd.set('email', 'ada@example.com');
  fd.set('category', 'bug');
  fd.set('show', 'Hamilton');
  fd.set('message', 'The score badge is missing on the Hamilton page.');
  return fd;
}

function submitReviewFormData() {
  const fd = new FormData();
  fd.set('review_url', 'https://www.nytimes.com/review-of-hamilton');
  fd.set('show_name', 'Hamilton');
  fd.set('outlet_name', 'NYT');
  fd.set('critic_name', 'Ben Brantley');
  fd.set('notes', 'Great review.');
  fd.set('submitter_email', 'ada@example.com');
  return fd;
}

test('feedback route returns 2xx and keeps the Formspree submission when Notion throws', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  const formspreeCalled = { hit: false };
  stubFetch({ formspreeCalled, githubIssueCalled: {} });
  try {
    const { POST } = await import('./../feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData(),
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    const res = await POST(req);
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
    assert.equal(formspreeCalled.hit, true, 'Formspree (the real consumer) must have been called');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('feedback route returns 2xx when NOTION_API_KEY is entirely absent', async () => {
  delete process.env.NOTION_API_KEY;
  const formspreeCalled = { hit: false };
  stubFetch({ formspreeCalled, githubIssueCalled: {} });
  try {
    const { POST } = await import('./../feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData(),
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    const res = await POST(req);
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
    assert.equal(formspreeCalled.hit, true, 'Formspree (the real consumer) must have been called');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('feedback route returns an error when Formspree rejects the submission, even if Notion succeeds (BRO-3382)', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  let notionCalled = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.notion.com')) {
      notionCalled = true;
      return new Response(JSON.stringify({ id: 'fake-page' }), { status: 200 });
    }
    if (u.includes('formspree.io')) {
      return new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: 429 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('./../feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData(),
      headers: { 'x-forwarded-for': '10.0.0.4' },
    });
    const res = await POST(req);
    assert.equal(res.status, 502, `expected 502 when the real consumer (Formspree) rejects, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.errors?.[0]?.message, 'error response must include a user-visible message');
    assert.equal(notionCalled, true, 'Notion should still be attempted as a best-effort fallback');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('feedback route returns an error when Formspree is unreachable', async () => {
  delete process.env.NOTION_API_KEY;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('formspree.io')) {
      throw new Error('simulated network failure');
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  try {
    const { POST } = await import('./../feedback/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/feedback', {
      method: 'POST',
      body: feedbackFormData(),
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });
    const res = await POST(req);
    assert.equal(res.status, 502, `expected 502 when Formspree is unreachable, got ${res.status}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submit-review route returns 2xx and keeps the GitHub issue when Notion throws', async () => {
  process.env.NOTION_API_KEY = 'test-key';
  process.env.GH_DISPATCH_TOKEN = 'test-gh-token';
  const githubIssueCalled = { hit: false };
  stubFetch({ formspreeCalled: {}, githubIssueCalled });
  try {
    const { POST } = await import('./../submit-review/route.ts');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/submit-review', {
      method: 'POST',
      body: submitReviewFormData(),
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    const res = await POST(req);
    assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
    assert.equal(githubIssueCalled.hit, true, 'GitHub issue (the real consumer) must have been called');
  } finally {
    globalThis.fetch = realFetch;
  }
});
