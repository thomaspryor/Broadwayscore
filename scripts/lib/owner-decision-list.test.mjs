// BRO-6235: list page token + decision listing + backlog email + digest link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const link = require('../../src/lib/owner-decision-link.js');
const { buildBacklogEmail, buildDecisionEmail, listUrl } = require('./owner-decision-email.js');
const { decisionsListLinkHtml } = require('../send-morning-digest.js');

const S = 'test-secret';
const NOW = Date.UTC(2026, 9, 25);

test('list token round trip, forged and expired are refused', () => {
  const t = link.signListToken({ secret: S, now: NOW });
  assert.equal(link.verifyListToken(t, S, NOW + 1000).ok, true);
  assert.equal(link.verifyListToken(t, 'other', NOW).reason, 'signature');
  assert.equal(link.verifyListToken(t, S, NOW + link.LIST_TTL_MS + 5000).reason, 'expired');
  assert.equal(link.verifyListToken(`${t}JUNK`, S, NOW).ok, false);
  assert.equal(link.verifyListToken('', S, NOW).ok, false);
  assert.equal(link.verifyListToken(t, '', NOW).reason, 'config');
});

test('domains are separate: a list token is not a decision token and vice versa', () => {
  const lt = link.signListToken({ secret: S, now: NOW });
  const dt = link.signToken({ id: 'BRO-1', hash: 'a'.repeat(12), secret: S, now: NOW });
  assert.equal(link.verifyToken(lt, S, NOW).ok, false);
  assert.equal(link.verifyListToken(dt, S, NOW).ok, false);
});

test('minted decision tokens never outlive the list token', () => {
  const listExpires = Math.floor((NOW + 60 * 60 * 1000) / 1000);
  const t = link.mintDecisionToken({ id: 'BRO-9', hash: 'b'.repeat(12), secret: S, listExpires, now: NOW });
  assert.equal(link.verifyToken(t, S, NOW).ok, true);
  assert.equal(link.verifyToken(t, S, NOW + 2 * 60 * 60 * 1000).reason, 'expired');
});

const card = (over = {}) => ({
  identifier: 'BRO-100', title: 'T', url: 'https://linear.app/x/BRO-100', priority: 3, createdAt: '2026-10-01T00:00:00Z', labels: { nodes: [] },
  description: 'DECISION NEEDED: Ship it?\nWhy this is your call: money.\nOption A: Yes: fast / risky\nOption B: No: safe / slow\nMy recommendation: A because fast.\nDefault: nothing.',
  ...over,
});

test('listOpenDecisions: real blocks and the label only; placeholders, quotes, settled, bad ids dropped', () => {
  const issues = [
    card(),
    card({ identifier: 'BRO-101', description: 'DECISION NEEDED: <what, one sentence, plain English>' }),
    card({ identifier: 'BRO-102', description: 'We said "DECISION NEEDED" in the middle of a sentence.' }),
    card({ identifier: 'BRO-103', description: 'ANSWERED by the owner (see the "Owner decision" comment on this card).' }),
    card({ identifier: 'BRO-104', description: 'plain', labels: { nodes: [{ name: 'awaiting-owner' }] }, priority: 1 }),
    card({ identifier: 'not-an-id' }),
    card({ identifier: 'BRO-105', url: 'https://evil.example/x' }),
  ];
  const out = link.listOpenDecisions(issues);
  assert.deepEqual(out.map((d) => d.identifier), ['BRO-104', 'BRO-100', 'BRO-105']);
  assert.equal(out[1].block.options.length, 2);
  assert.equal(out[2].url, null);
  // the hash matches what the confirm page checks
  assert.equal(out[1].hash, link.questionHash('Ship it?'));
});

test('buildBacklogEmail: one list link, no per-decision answer links', () => {
  const ds = ['a', 'b', 'c'].map((x, i) => ({ identifier: `BRO-${i + 1}`, title: x, question: `Question ${x}?` }));
  const e = buildBacklogEmail({ decisions: ds, secret: S, now: NOW });
  assert.match(e.subject, /^3 decisions are waiting on you$/);
  assert.equal((e.html.match(/\/api\/owner-decision\/list\?t=/g) || []).length, 1);
  assert.ok(!e.html.includes('&o='));
  assert.ok(!/—|–/.test(e.html));
  const href = /href="([^"]*list\?t=[^"]*)"/.exec(e.html)[1].replace(/&amp;/g, '&');
  const tok = new URL(href).searchParams.get('t');
  assert.equal(link.verifyListToken(tok, S, NOW).ok, true);
});

test('single decision email carries the list link too', () => {
  const e = buildDecisionEmail({ decision: { identifier: 'BRO-5', title: 't', question: 'Q?' }, description: 'DECISION NEEDED: Q?', secret: S, now: NOW });
  assert.match(e.html, /See everything waiting on you/);
  assert.ok(e.html.includes(listUrl(S, { now: NOW }).replace(/&/g, '&amp;')) || e.html.includes('/api/owner-decision/list?t='));
});

test('digest link only when there are decisions and a secret', () => {
  assert.equal(decisionsListLinkHtml(null, S), '');
  assert.equal(decisionsListLinkHtml({ items: [] }, S), '');
  assert.equal(decisionsListLinkHtml({ items: [{}] }, ''), '');
  assert.match(decisionsListLinkHtml({ items: [{}] }, S), /owner-decision\/list\?t=/);
});

test('stub markers are skipped like the sender does, so the real question wins', () => {
  const mk = (description) => [{ identifier: 'BRO-9', title: 't', description, priority: 2, createdAt: '2026-10-01', labels: { nodes: [] } }];
  assert.equal(link.listOpenDecisions(mk('DECISION NEEDED: none')).length, 0);
  const l = link.listOpenDecisions(mk('DECISION NEEDED: No decision needed.\nDECISION NEEDED: Real one?'));
  assert.equal(l.length, 1);
  assert.equal(l[0].question, 'Real one?');
});

test('a label-only card with a very long title hashes like loadDecision (opens as open)', async () => {
  const title = 'T'.repeat(300);
  const issue = { identifier: 'BRO-8', title, description: 'no block', priority: 2, createdAt: '2026-10-01', labels: { nodes: [{ name: link.AWAITING_OWNER_LABEL }] }, comments: { nodes: [] } };
  const [d] = link.listOpenDecisions([issue]);
  const r = await link.loadDecision({ graphql: async () => ({ issue }), id: 'BRO-8', hash: d.hash, secret: S });
  assert.equal(r.status, 'open');
});

test('overflow past the cap is reported, and minted tokens never outlive the list token', () => {
  const many = Array.from({ length: link.MAX_LISTED + 5 }, (_, i) => ({ identifier: `BRO-${i + 1}`, title: 't', description: `DECISION NEEDED: q${i}?`, priority: 3, createdAt: '2026-10-01', labels: { nodes: [] } }));
  assert.equal(link.listOpenDecisions(many).omitted, 5);
  const exp = Math.floor(NOW / 1000) + 10;
  const tok = link.mintDecisionToken({ id: 'BRO-1', hash: 'a'.repeat(12), secret: S, listExpires: exp, now: NOW });
  assert.equal(link.verifyToken(tok, S, NOW + 11_000).ok, false);
});

test('the digest list link is suppressed in dry-run previews', () => {
  process.env.DIGEST_NO_LIST_TOKEN = '1';
  try { assert.equal(decisionsListLinkHtml({ items: [{}] }, S), ''); } finally { delete process.env.DIGEST_NO_LIST_TOKEN; }
});
