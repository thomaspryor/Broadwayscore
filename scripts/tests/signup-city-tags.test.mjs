// BRO-6929: past signups get a city tag from the page they came through.
// Requires the real module (no copied logic) and the real hub registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tags = require('../lib/signup-city-tags.js');

const hubs = tags.loadHubKeys();
const shows = [
  { id: 'wicked-broadway-2003', slug: 'wicked', city: null },
  { id: 'hamilton-chicago-2026', slug: 'hamilton-chicago', city: 'chicago-il' },
  { id: 'the-outsiders-dc-2026', slug: 'the-outsiders-dc', city: 'washington-dc' },
  { id: 'les-mis-glasgow-2026', slug: 'les-mis-glasgow', city: 'glasgow-uk' },
];
const ctx = tags.buildCityContext(shows, hubs);

test('hub registry has the launched cities and not UK cities', () => {
  for (const c of ['chicago-il', 'washington-dc', 'los-angeles-ca']) assert.ok(hubs.has(c), c);
  assert.ok(!hubs.has('glasgow-uk'));
});

test('city comes from the city field, hub page, local show page or showId', () => {
  const f = (s) => tags.cityFromSubmission(s, ctx);
  assert.equal(f({ email: 'a@x.com', city: 'chicago-il' }), 'chicago-il');
  assert.equal(f({ email: 'a@x.com', page: '/tours/washington-dc' }), 'washington-dc');
  assert.equal(f({ email: 'a@x.com', page: '/show/hamilton-chicago' }), 'chicago-il');
  assert.equal(f({ email: 'a@x.com', showId: 'the-outsiders-dc-2026' }), 'washington-dc');
});

test('no city for homepage, Broadway shows, UK shows, unknown or hostile values', () => {
  const f = (s) => tags.cityFromSubmission(s, ctx);
  assert.equal(f({ page: '/' }), null);
  assert.equal(f({ page: '/show/wicked', showId: 'wicked-broadway-2003' }), null);
  assert.equal(f({ page: '/show/les-mis-glasgow', showId: 'les-mis-glasgow-2026' }), null);
  assert.equal(f({ city: 'glasgow-uk' }), null);
  assert.equal(f({ city: 'constructor', page: '/tours/__proto__' }), null);
  assert.equal(f(null), null);
});

test('buildCityTags: newest-first input, latest city, all cities, exclusions', () => {
  const newestFirst = [
    { email: 'Pat@Example.org', page: '/tours/washington-dc', action: 'subscribe' },
    { email: 'pat@example.org', page: '/tours/chicago-il' },
    { email: 'solo@example.org', showId: 'hamilton-chicago-2026', action: 'follow' },
    { email: 'gone@example.org', page: '/tours/chicago-il', action: 'unsubscribe' },
    { email: 'test-probe@example.org', page: '/tours/chicago-il' },
    { email: 'plain@example.org', page: '/' },
  ];
  const out = tags.buildCityTags(newestFirst, ctx, (e) => e.startsWith('test-'));
  assert.deepEqual([...out.keys()].sort(), ['pat@example.org', 'solo@example.org']);
  assert.deepEqual(out.get('pat@example.org'), { cities: ['chicago-il', 'washington-dc'], latest: 'washington-dc' });
  assert.deepEqual(out.get('solo@example.org'), { cities: ['chicago-il'], latest: 'chicago-il' });
  assert.deepEqual(tags.summarizeCityTags(out), { people: 2, byCity: { 'chicago-il': 2, 'washington-dc': 1 } });
});

function fakeHttp({ props = [], failFor = {} } = {}) {
  const calls = [];
  const http = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { data: props };
    if (method === 'POST') return { ok: true };
    const key = decodeURIComponent(url.split('/contacts/')[1]);
    if (failFor[key]) { const e = new Error('HTTP ' + failFor[key]); e.status = failFor[key]; throw e; }
    return { ok: true };
  };
  return { http, calls };
}

test('pushCitiesToResend creates the property, sets changed values, skips unchanged, counts 404s', async () => {
  const t = new Map([
    ['a+news@example.org', { cities: ['chicago-il'], latest: 'chicago-il' }],
    ['b@example.org', { cities: ['washington-dc'], latest: 'washington-dc' }],
    ['c@example.org', { cities: ['chicago-il'], latest: 'chicago-il' }],
    ['d@example.org', { cities: ['chicago-il'], latest: 'chicago-il' }],
  ]);
  const pushed = { 'b@example.org': 'washington-dc' };
  const { http, calls } = fakeHttp({ failFor: { 'c@example.org': 404, 'd@example.org': 500 } });
  const logs = [];
  const stats = await tags.pushCitiesToResend({ tags: t, pushed, http, delay: async () => {}, log: (m) => logs.push(m) });
  assert.deepEqual(stats, { set: 1, unchanged: 1, notInResend: 1, cleared: 0, errors: 1, propertyCreated: true });
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { key: 'city', type: 'string' });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, 'https://api.resend.com/contacts/a%2Bnews%40example.org');
  assert.deepEqual(patch.body, { properties: { city: 'chicago-il' } });
  assert.equal(pushed['a+news@example.org'], 'chicago-il');
  assert.equal(pushed['c@example.org'], undefined);
});

test('pushCitiesToResend does not recreate an existing property and never throws', async () => {
  const { http, calls } = fakeHttp({ props: [{ key: 'city' }] });
  const stats = await tags.pushCitiesToResend({ tags: new Map(), pushed: {}, http, delay: async () => {}, log() {} });
  assert.equal(stats.propertyCreated, false);
  assert.ok(!calls.some((c) => c.method === 'POST'));

  const boom = async () => { throw new Error('network down'); };
  const failed = await tags.pushCitiesToResend({ tags: new Map([['a@x.org', { cities: ['chicago-il'], latest: 'chicago-il' }]]), pushed: {}, http: boom, delay: async () => {}, log() {} });
  assert.equal(failed.errors, 1);
  assert.equal(failed.set, 0);
});

test('pushCitiesToResend clears the property for people no longer tagged', async () => {
  const pushed = { 'gone@example.org': 'chicago-il', 'deleted@example.org': 'chicago-il', 'kept@example.org': 'chicago-il' };
  const t = new Map([['kept@example.org', { cities: ['chicago-il'], latest: 'chicago-il' }]]);
  const { http, calls } = fakeHttp({ props: [{ key: 'city' }], failFor: { 'deleted@example.org': 404 } });
  const stats = await tags.pushCitiesToResend({ tags: t, pushed, http, delay: async () => {}, log() {} });
  assert.equal(stats.cleared, 1);
  assert.deepEqual(pushed, { 'kept@example.org': 'chicago-il' });
  const clear = calls.find((c) => c.method === 'PATCH' && c.url.includes('gone%40example.org'));
  assert.deepEqual(clear.body, { properties: { city: null } });
});

test('error logs carry the HTTP status only, never the response body', async () => {
  const logs = [];
  const http = async (m) => { if (m === 'GET') return { data: [{ key: 'city' }] }; const e = new Error('HTTP 422: {"email":"someone@example.org"}'); e.status = 422; throw e; };
  await tags.pushCitiesToResend({ tags: new Map([['someone@example.org', { cities: ['chicago-il'], latest: 'chicago-il' }]]), pushed: {}, http, delay: async () => {}, log: (m) => logs.push(m) });
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes('someone@example.org')), logs.join('|'));
});
