// BRO-7627: the advisory Codex route for a hand-started worker. Requires the real
// scripts/lib/codex-route.js (rule 15); the lane read is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardRouteReason, decideRoute, ghaLaneVerdict, dispatchCommand, MAX_COMMENTS } = require('./codex-route.js');

const NOW = Date.parse('2026-11-26T12:00:00Z');
const card = (identifier, over = {}) => ({
  identifier, title: 'Fix the date parser in scripts/lib/foo.js', priority: 3,
  state: { name: 'Todo', type: 'unstarted' },
  description: 'Fix parseDate in scripts/lib/foo.js so it handles ISO dates.\n\nVERIFY: node --test scripts/lib/foo.test.mjs',
  comments: { nodes: [] }, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', ...over,
});
const healthy = () => ({ ok: true, reason: 'Codex GHA lane healthy' });

test('a Codex-fit P2 Todo card with a healthy lane routes to Codex with the exact dispatch command', async () => {
  assert.equal(cardRouteReason(card('BRO-1'), { nowMs: NOW }), null);
  const r = await decideRoute([card('BRO-1'), card('BRO-2')], { nowMs: NOW, laneHealth: healthy });
  assert.equal(r.route, 'codex');
  assert.equal(r.dispatch, 'node scripts/cloud-dispatch.js codex-runner.yml -f ids=BRO-1,BRO-2 -f limit=2');
  assert.match(r.dispatchNote, /queued/);
  assert.match(r.dispatchNote, /Todo/);
  assert.doesNotMatch(r.dispatch, /--wait/);
});

test('a mac-only card routes to Claude, and the lane is never read', async () => {
  let read = 0;
  const r = await decideRoute([card('BRO-1', { description: 'Reload the launchd agent on the Mac.\n\nVERIFY: node --test scripts/lib/foo.test.mjs' })], { nowMs: NOW, laneHealth: () => { read++; return { ok: true }; } });
  assert.equal(r.route, 'claude');
  assert.match(r.routeReason, /mac-only/);
  assert.equal(r.dispatch, undefined);
  assert.equal(read, 0);
});

test('one unfit card sends the whole batch to Claude', async () => {
  const r = await decideRoute([card('BRO-1'), card('BRO-2', { priority: 1 })], { nowMs: NOW, laneHealth: healthy });
  assert.equal(r.route, 'claude');
  assert.match(r.routeReason, /BRO-2: P0/);
  assert.equal(r.cards[0].routeReason, null);
});

test('P0, a raw Model: Opus line, 50+ comments and a non-Todo state route to Claude', () => {
  assert.match(cardRouteReason(card('BRO-1', { priority: 1 }), { nowMs: NOW }), /P0/);
  assert.match(cardRouteReason(card('BRO-1', { description: `${card('x').description}\n\nModel: Opus` }), { nowMs: NOW }), /Opus/);
  // prose mentioning the hint mid-line is not a hint (MODEL_HINT_RE is line-anchored)
  assert.equal(cardRouteReason(card('BRO-1', { description: `${card('x').description}\nthe old card said Model: Opus here` }), { nowMs: NOW }), null);
  assert.equal(cardRouteReason(card('BRO-1', { description: `${card('x').description}\n\nModel: Sonnet` }), { nowMs: NOW }), null);
  const many = Array.from({ length: MAX_COMMENTS }, (_, i) => ({ body: `note ${i}`, createdAt: '2026-11-20T00:00:00Z' }));
  assert.match(cardRouteReason(card('BRO-1', { comments: { nodes: many } }), { nowMs: NOW }), /50\+ comments/);
  assert.match(cardRouteReason(card('BRO-1', { state: { name: 'In Progress', type: 'started' } }), { nowMs: NOW }), /only takes a Todo/);
  assert.match(cardRouteReason(card('BRO-1', { comments: undefined }), { nowMs: NOW }), /comments not read/);
  assert.equal(cardRouteReason(null), 'card not found');
});

test('lane unknown, unhealthy or throwing routes to Claude and prints the reason', async () => {
  const unknown = await decideRoute([card('BRO-1')], { nowMs: NOW, laneHealth: () => ghaLaneVerdict(null) });
  assert.equal(unknown.route, 'claude');
  assert.match(unknown.routeReason, /health unknown/);
  const threw = await decideRoute([card('BRO-1')], { nowMs: NOW, laneHealth: async () => { throw new Error('gh missing'); } });
  assert.equal(threw.route, 'claude');
  assert.match(threw.routeReason, /unknown \(gh missing\)/);
  const bad = await decideRoute([card('BRO-1')], { nowMs: NOW, laneHealth: () => ({ ok: false, reason: 'Codex lane unhealthy: gha:failing' }) });
  assert.equal(bad.route, 'claude');
  assert.match(bad.routeReason, /gha:failing/);
});

test('ghaLaneVerdict counts gha breaches and a lost login, not the cloud lane', () => {
  const h = (breaches, ghaRuns = 5) => ({ now: { breaches, facts: { ghaRuns } } });
  assert.equal(ghaLaneVerdict(h([])).ok, true);
  assert.equal(ghaLaneVerdict(h([{ lane: 'cloud', cls: 'no-run', why: 'x' }])).ok, true);
  assert.equal(ghaLaneVerdict(h([{ lane: 'codex', cls: 'landed-low', why: 'x' }])).ok, true);
  const gha = ghaLaneVerdict(h([{ lane: 'gha', cls: 'failing', why: 'the last 2 runs failed' }]));
  assert.equal(gha.ok, false);
  assert.match(gha.reason, /gha:failing/);
  assert.equal(ghaLaneVerdict(h([{ lane: 'codex', cls: 'login-not-saved', why: 'x' }])).ok, false);
  assert.equal(ghaLaneVerdict(h([], 0)).ok, false);
  assert.equal(ghaLaneVerdict(null).ok, false);
});

test('ghaLaneVerdict on real codexLaneHealth output: two failed runs breach, recent green work passes', () => {
  const { confirmedBreaches } = require('./codex-lane-health.js');
  const HOUR = 3600_000;
  const run = (agoH, conclusion, durationMin) => ({ startMs: NOW - agoH * HOUR, endMs: NOW - agoH * HOUR + durationMin * 60_000, durationMin, conclusion });
  const inputs = (ghRuns) => ({ nowMs: NOW, landed: null, summaries: null, ghRuns, lockAgeH: null });
  assert.equal(ghaLaneVerdict(confirmedBreaches(inputs([run(3, 'failure', 30), run(8, 'failure', 30)]))).ok, false);
  assert.equal(ghaLaneVerdict(confirmedBreaches(inputs([run(3, 'success', 150), run(8, 'success', 160)]))).ok, true);
  assert.equal(ghaLaneVerdict(confirmedBreaches(inputs(null))).ok, false);
});

test('dispatchCommand uses -f for both inputs (cloud-dispatch.js rejects a bare ids=)', () => {
  assert.equal(dispatchCommand(['BRO-9']), 'node scripts/cloud-dispatch.js codex-runner.yml -f ids=BRO-9 -f limit=1');
});
