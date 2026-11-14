// BRO-6411: a visual ask whose change shipped another way (VISUAL-OK commit) is voided, never approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const link = require('../../src/lib/owner-decision-link.js');
const va = require('./visual-approval.js');
const { planCard, shippedVisualCommit, askedSince } = require('../visual-approval-land.js');
const { resolveDecision } = require('../record-owner-answer.js');

const S = 'test-secret';
const PATCH = 'a'.repeat(40);
const VERDICT = 'b'.repeat(16);
const block = () => va.buildBlock({ what: 'the link-in-bio page', patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-7', evidence: [], summary: 'ok' });
const hashOf = (d) => link.questionHash(link.markerLines(d)[0].question);

test('holdSettled: a gone hold is settled even without a patch id', () => {
  assert.equal(va.holdSettled({ fetchOk: false }), true);
  assert.equal(va.holdSettled({ fetchOk: false, patchIdValue: PATCH }), true);
});

test('holdSettled: a fetched hold is settled only for an empty diff', () => {
  assert.equal(va.holdSettled({ fetchOk: true, patchIdValue: null }), true);
  assert.equal(va.holdSettled({ fetchOk: true, patchIdValue: PATCH }), false);
  assert.equal(va.holdSettled({ fetchOk: true }), false);
  assert.equal(va.holdSettled({ fetchOk: true, patchIdValue: '' }), false);
});

function fakeBoard(description, state = 'In Progress') {
  const issue = { id: 'uuid-1', identifier: 'BRO-7', title: 'UI work', description, state: { id: 's1', name: state, type: 'started' },
    labels: { nodes: [{ id: 'l1', name: 'awaiting-owner' }] }, team: { states: { nodes: [{ id: 'todo1', name: 'Todo', type: 'unstarted' }] } }, comments: { nodes: [] } };
  const updates = [];
  let n = 0;
  const graphql = async (query, vars) => {
    if (/commentCreate/.test(query)) { const c = { id: `c${++n}`, body: vars.input.body, createdAt: new Date(Date.now() + n).toISOString() }; issue.comments.nodes.push(c); return { commentCreate: { success: true, comment: c } }; }
    if (/commentDelete/.test(query)) { issue.comments.nodes = issue.comments.nodes.filter((c) => c.id !== vars.id); return { commentDelete: { success: true } }; }
    if (/issueUpdate/.test(query)) { updates.push(vars.input); return { issueUpdate: { success: true } }; }
    return { issue };
  };
  return { issue, updates, graphql };
}

test('void records the closure, writes no approval, leaves the card where it is, and is idempotent', async () => {
  const d = block();
  const b = fakeBoard(d);
  const run = () => link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'void', allowVoid: true, text: 'shipped as d2ae329de2c', via: 'a chat with Claude' });
  assert.equal((await run()).status, 'recorded');
  assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT }), false, 'void must never approve');
  assert.match(b.updates[0].description, /ANSWERED by the owner/);
  assert.equal(b.updates[0].stateId, undefined, 'a shipped change must not be re-queued');
  assert.match(b.issue.comments.nodes[0].body, /closed without an owner tap/);
  assert.equal((await run()).status, 'answered');
  assert.equal(b.issue.comments.nodes.length, 1);
});

test('void is refused on a card with no visual ask (bad-choice) and by the CLI resolver', async () => {
  const plain = 'DECISION NEEDED: send the welcome email now?\n\nOption A — Send: fast / risky\nOption B — Wait: safe / slow\n';
  const b = fakeBoard(plain);
  const r = await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(plain), secret: S, choiceKey: 'void', text: '' });
  assert.equal(r.status, 'bad-choice');
  assert.equal(b.issue.comments.nodes.length, 0);
  assert.match(resolveDecision({ identifier: 'BRO-7', title: 't', description: plain, labels: { nodes: [] } }, 'void').error, /only for a card with a visual ask/);
});

test('resolveDecision still refuses approving a visual ask, and allows void', () => {
  const issue = { identifier: 'BRO-7', title: 't', description: block(), labels: { nodes: [] } };
  assert.match(resolveDecision(issue, 'a').error, /visual change/);
  // BRO-6546: the refusal must send the session to land the held change itself, never to the owner's tap.
  assert.match(resolveDecision(issue, 'a').error, /said yes\/Approved in THIS chat[\s\S]*Never tell the owner to tap/);
  assert.equal(resolveDecision(issue, 'void').choiceKey, 'void');
});

test('shippedVisualCommit needs the VISUAL-OK prefix and the exact card id', () => {
  const sha = (c) => c.repeat(40);
  const log = [`${sha('1')}\tfeat: other (BRO-6377)`, `${sha('2')}\tVISUAL-OK-1440: feat(links): page (BRO-63770)`, `${sha('3')}\tVISUAL-OK-1440: feat(links): page (BRO-6377)`].join('\n');
  assert.equal(shippedVisualCommit(log, 'BRO-6377'), sha('3'));
  assert.equal(shippedVisualCommit(log, 'BRO-637'), null);
  assert.equal(shippedVisualCommit('', 'BRO-6377'), null);
});

test('planCard voids an open ask once a VISUAL-OK commit shipped it, but not an answered one', () => {
  const issue = { identifier: 'BRO-7', description: block(), comments: { nodes: [] }, createdAt: '2026-10-01T00:00:00Z' };
  assert.equal(planCard(issue, S, Date.now(), null, 'c'.repeat(40)).action, 'shipped');
  assert.equal(planCard(issue, S, Date.now(), null, null).action, 'wait');
  const answered = { ...issue, description: `${issue.description}\nANSWERED by the owner (see the "Owner decision" comment on this card).` };
  assert.notEqual(planCard(answered, S, Date.now(), null, 'c'.repeat(40)).action, 'shipped');
  assert.equal(askedSince(issue), Date.parse('2026-10-01T00:00:00Z'));
  const twice = { ...issue, comments: { nodes: [{ body: 'Asked the owner to look at it', createdAt: '2026-10-02T00:00:00Z' }, { body: 'Asked the owner to look at it again', createdAt: '2026-10-09T00:00:00Z' }] } };
  assert.equal(askedSince(twice), Date.parse('2026-10-09T00:00:00Z'), 'the newest ask bounds the search');
  // An owner Approve already on the card wins over the shipped check: it keeps the landing path.
  const mac = link.visualMac(S, 'BRO-7', PATCH, VERDICT);
  const approved = { ...issue, comments: { nodes: [{ body: link.visualMarker(mac), createdAt: new Date().toISOString() }] } };
  assert.equal(planCard(approved, S, Date.now(), null, 'c'.repeat(40)).action, 'land');
});

test('void without allowVoid (the web link path) is refused and writes nothing', async () => {
  const d = block();
  const b = fakeBoard(d);
  const r = await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'void', text: '' });
  assert.equal(r.status, 'bad-choice');
  assert.equal(b.issue.comments.nodes.length, 0);
  assert.equal(b.updates.length, 0);
});
