import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getFormspreeAuthJoins } = require('./formspree-auth-joins');
const NOW = Date.parse('2026-10-26T13:00:00Z');
const options = { formId: 'test-form', token: 'test-token', days: 7, nowMs: NOW };
const submission = (overrides = {}) => ({ source: 'auth-auto', _date: '2026-10-24T12:00:00Z', ...overrides });

function pagesFetch(pages, calls = []) {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.ok(pages.length, 'unexpected API call');
    const page = pages.shift();
    if (page instanceof Error) throw page;
    return { ok: true, json: async () => page };
  };
}

test('counts only auth-auto subscriptions within the window, using supported date fields', async () => {
  const items = [
    submission(),
    submission({ _date: undefined, date: '2026-10-25T00:00:00Z' }),
    submission({ _date: undefined, submitted_at: '2026-10-25T00:00:00Z' }),
    submission({ _date: undefined, created_at: '2026-10-25T00:00:00Z' }),
    submission({ source: 'footer' }), submission({ source: 'email-gate' }),
    submission({ source: undefined }), submission({ action: 'health-check' }),
    submission({ action: 'unsubscribe' }), submission({ _date: '2026-10-01T00:00:00Z' }),
    submission({ _date: '2026-10-19T13:00:00Z' }), // Lower bound excluded, like PostHog.
    submission({ _date: '2026-10-27T00:00:00Z' }),
    submission({ _date: '2026-10-26T13:00:00Z' }), // Upper bound included.
  ];
  const result = await getFormspreeAuthJoins({ ...options, fetchImpl: pagesFetch([{ submissions: items }]) });
  assert.deepEqual(result, { formspreeAuthJoins: 5, formspreeAuthJoinsStatus: 'ok' });
});

test('uses read-only authenticated pagination and counts beyond the first page', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, () => submission({ source: 'footer' }));
  const fetchImpl = pagesFetch([{ submissions: first }, { submissions: [submission(), submission()] }], calls);
  assert.deepEqual(await getFormspreeAuthJoins({ ...options, fetchImpl }), {
    formspreeAuthJoins: 2, formspreeAuthJoinsStatus: 'ok',
  });
  assert.equal(calls.length, 2);
  for (const [i, { url, init }] of calls.entries()) {
    assert.equal(url.origin, 'https://formspree.io');
    assert.equal(url.pathname, '/api/0/forms/test-form/submissions');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('offset'), String(i * 100));
    assert.equal(url.searchParams.get('since'), '2026-10-19T13:00:00.000Z');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.method ?? 'GET', 'GET');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('supports array responses, empty forms and exact page boundaries', async () => {
  assert.equal((await getFormspreeAuthJoins({ ...options, fetchImpl: pagesFetch([[submission()]]) })).formspreeAuthJoins, 1);
  assert.deepEqual(await getFormspreeAuthJoins({ ...options, fetchImpl: pagesFetch([{ submissions: [] }]) }), {
    formspreeAuthJoins: 0, formspreeAuthJoinsStatus: 'ok',
  });
  const full = Array.from({ length: 100 }, () => submission());
  const r = await getFormspreeAuthJoins({ ...options, fetchImpl: pagesFetch([full, []]) });
  assert.equal(r.formspreeAuthJoins, 100);
});

test('missing credentials never calls Formspree and returns unknown, not zero', async () => {
  for (const missing of [{ formId: '' }, { token: '' }]) {
    const r = await getFormspreeAuthJoins({ ...options, ...missing, fetchImpl: () => assert.fail('must not fetch') });
    assert.deepEqual(r, { formspreeAuthJoins: null, formspreeAuthJoinsStatus: 'unconfigured' });
  }
});

test('API errors, malformed responses and invalid auth dates return unknown without leaking bodies', async () => {
  const fixtures = [
    async () => ({ ok: false, status: 403, json: () => assert.fail('must not read error body') }),
    async () => { throw new Error('private response body'); },
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    pagesFetch([{ error: 'invalid payload' }]),
    pagesFetch([null]),
    pagesFetch([{ submissions: [submission({ _date: undefined })] }]),
    pagesFetch([{ submissions: [submission({ _date: 'bad-date' })] }]),
  ];
  for (const fetchImpl of fixtures) {
    assert.deepEqual(await getFormspreeAuthJoins({ ...options, fetchImpl }), {
      formspreeAuthJoins: null, formspreeAuthJoinsStatus: 'unavailable',
    });
  }
});

test('a later-page failure discards partial counts instead of reporting a healthy or empty window', async () => {
  for (const source of ['auth-auto', 'footer']) {
    const page = Array.from({ length: 100 }, () => submission({ source }));
    const fetchImpl = pagesFetch([{ submissions: page }, new Error('timeout')]);
    assert.deepEqual(await getFormspreeAuthJoins({ ...options, fetchImpl }), {
      formspreeAuthJoins: null, formspreeAuthJoinsStatus: 'unavailable',
    });
  }
});
