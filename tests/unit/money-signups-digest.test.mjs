import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { collectMoneySignups, renderMoneySignups } = require('../../scripts/lib/money-signups-digest.js');
const { buildHtml } = require('../../scripts/send-morning-digest.js');
const now = new Date('2026-10-27T12:00:00Z');
const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
const recent = '2026-10-27T11:00:00Z';
const old = '2026-10-25T11:00:00Z';
const response = (rows, range = `0-${rows.length - 1}/${rows.length}`) => ({
  ok: true, headers: new Headers({ 'content-range': rows.length ? range : '*/0' }),
  json: async () => rows,
});
const digest = summary => buildHtml({ sections: { moneySignups: summary, health: { errors: [], warnings: [], queued: [] } }, loopDeadMsg: null, now });

test('service-key read feeds aggregate counts into the actual morning digest', async () => {
  const rows = [
    { created_at: old, role: 'producer', first_page: 'biz-dashboard:/biz' },
    { created_at: recent, role: 'investor', first_page: 'biz-dashboard:/biz' },
    { created_at: '2026-10-26T12:00:00Z', role: 'press', first_page: 'show-page:/show/hamilton-2015' },
    { created_at: recent, role: 'industry', first_page: 'biz-season:/biz/season/2026-2027' },
    { created_at: old, role: 'fan', first_page: null },
    { created_at: old, role: null, first_page: null },
  ];
  let calls = 0;
  const summary = await collectMoneySignups({ env, now, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/rest/v1/money_scorecard_signups');
    assert.equal(url.searchParams.get('select'), 'created_at,role,first_page');
    assert.equal(url.searchParams.get('created_at'), `lte.${now.toISOString()}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(options.headers.Prefer, 'count=exact');
    assert.ok(options.signal instanceof AbortSignal);
    return response(rows);
  } });
  assert.equal(calls, 1);
  assert.equal(summary.total, 6);
  assert.equal(summary.last24h, 3);
  const html = digest(summary);
  assert.match(html, /Total sign-ups: 6 · Last 24h: 3/);
  for (const role of ['Producer', 'Investor', 'Press', 'Industry', 'Fan', 'Unspecified']) assert.ok(html.includes(`${role}: 1`));
  assert.match(html, /biz-dashboard: 2/);
  assert.ok(html.indexOf('Money Scorecard sign-ups') < html.indexOf('Technical details'));
});

test('no raw fields, contact details, query strings or HTML reach statistics or digest', async () => {
  const summary = await collectMoneySignups({ env, now, fetchImpl: async () => response([
    { created_at: recent, email: 'private@example.invalid', role: 'Jane Private', first_page: 'show-page:/show/Jane-Private?email=private@example.invalid' },
    { created_at: old, role: '<script>alert(1)</script>', first_page: '<img src=x onerror=alert(1)>' },
    { created_at: old, role: null, first_page: 'private@example.invalid' },
  ]) });
  assert.equal(summary.roles.unspecified, 3);
  assert.deepEqual(summary.topPages, [['other', 2], ['show-page', 1]]);
  for (const output of [JSON.stringify(summary), renderMoneySignups(summary), digest(summary)]) {
    assert.doesNotMatch(output, /private@example|Jane.Private|<script>|<img src=x|onerror|test-service-key/);
  }
});

test('missing service key skips the section without making a request', async () => {
  const summary = await collectMoneySignups({ env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(summary, null);
  assert.equal(renderMoneySignups(summary), '');
  assert.doesNotMatch(digest(summary), /Money Scorecard sign-ups/);
});

test('empty list is a real zero, not an unavailable result', async () => {
  const summary = await collectMoneySignups({ env, now, fetchImpl: async () => response([]) });
  assert.equal(summary.total, 0);
  assert.equal(summary.last24h, 0);
  assert.match(digest(summary), /Total sign-ups: 0 · Last 24h: 0/);
});

test('continues through server-capped pages instead of silently undercounting', async () => {
  const offsets = [];
  const summary = await collectMoneySignups({ env, now, fetchImpl: async url => {
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    return response([{ created_at: offset ? old : recent, role: 'fan', first_page: null }], `${offset}-${offset}/3`);
  } });
  assert.deepEqual(offsets, [0, 1, 2]);
  assert.equal(summary.total, 3);
  assert.equal(summary.last24h, 1);
  assert.equal(summary.roles.fan, 3);
});

test('HTTP errors, malformed rows, incomplete pages and timeout errors cannot produce false totals or leak PII', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, text: () => assert.fail('must not read error body') }),
    async () => { throw new Error('private@example.invalid test-service-key'); },
    async () => response([{ created_at: 'bad' }]),
    async () => response([{ created_at: '2026-10-28T00:00:00Z' }]),
    async () => ({ ok: true, headers: new Headers(), json: async () => [] }),
    async () => response([{ created_at: recent }], '1-1/3'),
    async () => ({ ok: true, headers: new Headers({ 'content-range': '*/3' }), json: async () => [] }),
  ]) {
    const summary = await collectMoneySignups({ env, now, fetchImpl });
    assert.deepEqual(summary, { unavailable: true });
    assert.match(digest(summary), /temporarily unavailable/);
    assert.doesNotMatch(digest(summary), /Total sign-ups|private@example|test-service-key/);
  }
  assert.deepEqual(await collectMoneySignups({ env: { SUPABASE_SERVICE_ROLE_KEY: 'test' } }), { unavailable: true });
});

test('page limit bounds API cost and discards partial statistics', async () => {
  let calls = 0;
  const summary = await collectMoneySignups({ env, now, fetchImpl: async () => {
    const offset = calls++;
    return response([{ created_at: recent }], `${offset}-${offset}/101`);
  } });
  assert.equal(calls, 100);
  assert.deepEqual(summary, { unavailable: true });
});

test('production main collects the section that buildHtml renders', () => {
  const source = readFileSync(new URL('../../scripts/send-morning-digest.js', import.meta.url), 'utf8');
  assert.match(source, /sections\.moneySignups = await collectMoneySignups\(\)/);
  assert.match(source, /head\.push\(renderMoneySignups\(sections\.moneySignups\)\)/);
});
