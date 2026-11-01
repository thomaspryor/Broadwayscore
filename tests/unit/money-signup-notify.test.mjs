import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planNotifications, buildSignupEmail, rowKey } = require('../../scripts/lib/money-signup-notify.js');

const NOW = new Date('2026-11-02T12:00:00Z');
const row = (email, iso, extra = {}) => ({ email, created_at: iso, role: 'fan', first_page: 'biz-season:/biz/season', signup_count: 1, ...extra });
const seed = '2026-11-01T00:00:00Z';

test('only rows after seed and inside the window are sent', () => {
  const rows = [row('old@x.com', '2026-10-30T00:00:00Z'), row('beforeseed@x.com', '2026-10-31T23:00:00Z'),
    row('new@x.com', '2026-11-02T11:00:00Z')];
  const p = planNotifications(rows, { now: NOW, seed });
  assert.deepEqual(p.send.map(s => s.row.email), ['new@x.com']);
  assert.equal(p.send[0].ordinal, 3);
});
test('window excludes rows older than 20h even when after seed', () => {
  const p = planNotifications([row('a@x.com', '2026-11-01T10:00:00Z')], { now: NOW, seed });
  assert.equal(p.send.length, 0);
});
test('owner test addresses are skipped and do not count in the total', () => {
  const rows = [row('thomas.pryor@gmail.com', '2026-11-02T10:00:00Z'), row('a@x.com', '2026-11-02T11:00:00Z')];
  const p = planNotifications(rows, { now: NOW, seed });
  assert.equal(p.send.length, 1);
  assert.equal(p.send[0].ordinal, 1);
});
test('ties on created_at break by email and ordinals stay distinct', () => {
  const t = '2026-11-02T11:00:00Z';
  const p = planNotifications([row('b@x.com', t), row('a@x.com', t)], { now: NOW, seed });
  assert.deepEqual(p.send.map(s => [s.row.email, s.ordinal]), [['a@x.com', 1], ['b@x.com', 2]]);
});
test('per-run cap defers the rest', () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(`u${i}@x.com`, `2026-11-02T11:0${i}:00Z`));
  const p = planNotifications(rows, { now: NOW, seed, cap: 5 });
  assert.equal(p.send.length, 5);
  assert.equal(p.deferred, 3);
});
test('key is stable, hides the address, and changes per row', () => {
  const r = row('a@x.com', '2026-11-02T11:00:00Z');
  assert.equal(rowKey(r, 's'), rowKey({ ...r, role: 'press', signup_count: 2 }, 's'));
  assert.ok(!rowKey(r, 's').includes('a@x.com'));
  assert.notEqual(rowKey(r, 's'), rowKey(row('b@x.com', '2026-11-02T11:00:00Z'), 's'));
});
test('email body has every requested field and escapes HTML', () => {
  const { subject, html } = buildSignupEmail({ row: row('<b>@x.com', '2026-11-02T11:00:00Z', { role: null }), ordinal: 45 }, 45);
  assert.match(subject, /#45/);
  for (const f of ['Email', 'Role', 'First page', 'Sign-up count', 'Signed up', 'Running total']) assert.ok(html.includes(f));
  assert.ok(html.includes('&lt;b&gt;') && !html.includes('<b>@'));
});
