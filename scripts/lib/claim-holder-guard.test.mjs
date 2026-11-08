// BRO-7141: claim refuses when another live session holds a started card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { claimHolderDecision, refusalMessage } = createRequire(import.meta.url)('./claim-holder-guard.js');
const { RECLAIM_IDLE_MS } = createRequire(import.meta.url)('./linear-reclaim-abandoned.js');

const NOW = Date.parse('2026-11-08T17:30:00Z');
const MAC = 'local session 4f7ce9ae-32fe-467e-87bc-ff68b6818831 on Toms-Mac-Studio.local';
const CLOUD = 'https://claude.ai/code/session_01RUGH9mh3HXpxbNky6axwrT';
const iso = (ms) => new Date(ms).toISOString();
const claim = (ref, ms, extra = '') => ({ body: `Claimed by ${ref} at ${iso(ms)}${extra}`, createdAt: iso(ms) });
const card = (comments, updatedMs, over = {}) => ({
  identifier: 'BRO-7133', title: 'Codex blocked filter', description: '', updatedAt: iso(updatedMs),
  state: { name: 'In Progress', type: 'started' }, comments: { nodes: comments }, ...over,
});

test('BRO-7133 shape: a cloud session claiming a card the Mac session claimed 1h ago is refused, naming the holder', () => {
  const d = claimHolderDecision({ issue: card([claim(MAC, NOW - 3600e3)], NOW - 600e3), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'refuse');
  assert.equal(d.holder, MAC);
  assert.match(refusalMessage('BRO-7133', d), /already held by local session 4f7ce9ae/);
});

test('a "Session report (done)" or a Dispatched comment does not release a card that is still In Progress', () => {
  const comments = [
    claim(MAC, NOW - 3600e3),
    { body: '**Session report (done)**\nlanded', createdAt: iso(NOW - 900e3) },
    { body: 'Dispatched 326f67f2 to linear:BRO-7133 at x (headless)', createdAt: iso(NOW - 400e3) },
  ];
  assert.equal(claimHolderDecision({ issue: card(comments, NOW - 400e3), selfRef: CLOUD, nowMs: NOW }).action, 'refuse');
});

test('a holder idle past the reclaim window (card and comments) is claimable', () => {
  const old = NOW - RECLAIM_IDLE_MS - 3600e3;
  const d = claimHolderDecision({ issue: card([claim(MAC, old)], old), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'takeover');
});

test('idle just under the window still refuses (same threshold as the reclaim sweep)', () => {
  const t = NOW - RECLAIM_IDLE_MS + 3600e3;
  assert.equal(claimHolderDecision({ issue: card([claim(MAC, t)], t), selfRef: CLOUD, nowMs: NOW }).action, 'refuse');
});

test('a recent comment keeps an old claim live even when updatedAt is old', () => {
  const old = NOW - RECLAIM_IDLE_MS - 86400e3;
  const comments = [claim(MAC, old), { body: 'progress note', createdAt: iso(NOW - 3600e3) }];
  assert.equal(claimHolderDecision({ issue: card(comments, old), selfRef: CLOUD, nowMs: NOW }).action, 'refuse');
});

test('NO-RECLAIM and owner cards still refuse while the holder is recently active', () => {
  const d = claimHolderDecision({ issue: card([claim(MAC, NOW - 600e3)], NOW - 600e3, { description: 'NO-RECLAIM: tracker' }), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'refuse');
});

test('a protected or blocked card whose holder has been idle 48h+ is claimable (holder is gone)', () => {
  const old = NOW - RECLAIM_IDLE_MS - 86400e3;
  const blocked = { body: '**Session report (blocked)**\nneeds owner', createdAt: iso(old + 1000) };
  for (const over of [{ description: 'NO-RECLAIM: tracker' }, { labels: { nodes: [{ name: 'owner' }] } }]) {
    assert.equal(claimHolderDecision({ issue: card([claim(MAC, old), blocked], old, over), selfRef: CLOUD, nowMs: NOW }).action, 'takeover');
  }
});

test('a Dispatched receipt newer than the claim hands the card to a local worker (re-dispatch flow)', () => {
  const comments = [claim(MAC, NOW - 7200e3), { body: 'Dispatched abc to linear:BRO-7133 at x (headless)', createdAt: iso(NOW - 300e3) }];
  const d = claimHolderDecision({ issue: card(comments, NOW - 300e3), selfRef: MAC.replace('4f7ce9ae', '11111111'), nowMs: NOW });
  assert.equal(d.action, 'handoff');
});

test('a person comment starting "Claimed by me" is not a session claim', () => {
  const comments = [{ body: 'Claimed by me, will do this week', createdAt: iso(NOW - 600e3) }];
  assert.equal(claimHolderDecision({ issue: card(comments, NOW - 600e3), selfRef: CLOUD, nowMs: NOW }).action, 'unknown-holder');
});

test('a --child handoff older than 2h no longer covers a stranger', () => {
  const c = claim(MAC, NOW - 3 * 3600e3, '\nChild session starting on this card now: x. Workers: do not take it.');
  const d = claimHolderDecision({ issue: card([c], NOW - 600e3), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'refuse');
});

test('the same session re-claiming its own card proceeds', () => {
  const d = claimHolderDecision({ issue: card([claim(CLOUD, NOW - 600e3)], NOW - 600e3), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'own');
});

test('a host-only ref never proves "this is me" (two sessions share it)', () => {
  const host = 'a session on Toms-Mac-Studio.local';
  const d = claimHolderDecision({ issue: card([claim(host, NOW - 600e3)], NOW - 600e3), selfRef: host, nowMs: NOW });
  assert.equal(d.action, 'refuse');
});

test('a parent --child claim hands the card to the child session (not refused)', () => {
  const c = claim(MAC, NOW - 120e3, '\nChild session starting on this card now: BRO-7141: claim guard. Workers: do not take it.');
  const d = claimHolderDecision({ issue: card([c], NOW - 120e3), selfRef: CLOUD, nowMs: NOW });
  assert.equal(d.action, 'handoff');
});

test('after the child posts its own claim, a third session is refused', () => {
  const parent = claim(MAC, NOW - 600e3, '\nChild session starting on this card now: BRO-7141: claim guard. Workers: do not take it.');
  const child = claim(CLOUD, NOW - 300e3);
  const d = claimHolderDecision({ issue: card([parent, child], NOW - 300e3), selfRef: 'https://claude.ai/code/session_other', nowMs: NOW });
  assert.equal(d.action, 'refuse');
  assert.equal(d.holder, CLOUD);
});

test('--force overrides a live holder', () => {
  assert.equal(claimHolderDecision({ issue: card([claim(MAC, NOW - 3600e3)], NOW - 600e3), selfRef: CLOUD, nowMs: NOW, force: true }).action, 'takeover');
});

test('a started card with no claim comment is a warning only (no named holder to refuse for)', () => {
  assert.equal(claimHolderDecision({ issue: card([], NOW - 600e3), selfRef: CLOUD, nowMs: NOW }).action, 'unknown-holder');
});

test('cmdClaim stays wired to the guard: refuses with exit 8 and the issue query carries updatedAt', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../linear-session.js', import.meta.url), 'utf8');
  assert.match(src, /chg\.claimHolderDecision\(/);
  assert.match(src, /decision\.action === 'refuse'[\s\S]{0,200}process\.exit\(8\)/);
  const { buildIssueQuery } = createRequire(import.meta.url)('./linear-dispatch.js');
  assert.match(buildIssueQuery(), /\bupdatedAt\b/);
});
