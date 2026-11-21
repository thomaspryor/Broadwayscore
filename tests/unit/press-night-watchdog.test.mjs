// BRO-6858: the old-path press-night watchdog acts on stalled reviews only, once per stage, and pages after its retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateTick, runIsForShow, undoUnsent } = require('../../scripts/lib/press-night-watchdog.js');

const SHOW = 'wanted-2022';
const E = Date.parse('2026-11-09T03:00:00Z');
const M = 60000;
const norm = (o) => String(o || '').toLowerCase().replace(/[^a-z]/g, '');
const file = (outletId, critic, seenMin, extra = {}) => ({ outletId, critic, firstSeenAt: new Date(E + seenMin * M).toISOString(), includable: true, scoredAt: null, ...extra });
const run = (workflow, status, title = '', extra = {}) => ({ workflow, status, displayTitle: title, ...extra });
const tick = (nowMin, o = {}) => evaluateTick({ showId: SHOW, embargoMs: E, nowMs: E + nowMin * M, files: [], coreRows: [], liveRows: [], runs: [], normOutlet: norm, ...o });
const ORCH = run('opening-night-orchestrator.yml', 'in_progress', `Opening Night Orchestrator targeted ${SHOW} (broadway)`);

test('a found review that is slow but moving (poller running) is never retried or paged', () => {
  const r = tick(40, { files: [file('nytimes', 'Jesse Green', 5)], runs: [ORCH, run('opening-night-poller.yml', 'in_progress', `Opening Night Poller — ${SHOW}`)] });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.summary.pending, ['nytimes:score:35m']);
});

test('stalled 15 min: each stage retried once; paged only a tick after the retry did not move it', () => {
  const files = [file('nytimes', 'Jesse Green', 5), file('vulture', 'Sara Holdren', 6, { scoredAt: new Date(E + 10 * M).toISOString() })];
  const a = tick(21, { files, runs: [ORCH] });
  assert.deepEqual(a.actions.map((x) => x.type + ':' + (x.stage || '')).sort(), ['dispatch:rebuild', 'dispatch:score']);
  const b = tick(31, { files, runs: [ORCH], state: a.state });
  assert.deepEqual(b.actions.map((x) => x.type), ['page']);
  assert.match(b.actions[0].reason, /nytimes \(score/);
  const c = tick(41, { files, runs: [ORCH], state: b.state });
  assert.deepEqual(c.actions, [], 'one page per night, no second retry');
  // Everything live later: the page resolves once.
  const d = tick(60, { files, runs: [ORCH], state: c.state, liveRows: [{ o: 'nytimes', cn: 'Jesse Green' }, { o: 'vulture', cn: 'Sara Holdren' }] });
  assert.deepEqual(d.actions.map((x) => x.type), ['resolve']);
});

test('a retry that started a run counts as moving: no page', () => {
  const files = [file('nytimes', 'Jesse Green', 5)];
  const a = tick(21, { files, runs: [ORCH] });
  const b = tick(31, { files, runs: [ORCH, run('llm-ensemble-score.yml', 'queued', `LLM Ensemble Score Reviews — ${SHOW}`)], state: a.state });
  assert.deepEqual(b.actions, []);
});

test('in reviews.json but not live -> deploy stage; a rebuild that finished after the score drops it (never paged)', () => {
  const scored = new Date(E + 10 * M).toISOString();
  const deploy = tick(30, { files: [file('nytimes', 'Jesse Green', 5, { scoredAt: scored })], coreRows: [{ outletId: 'nytimes', criticName: 'Jesse Green' }], runs: [ORCH] });
  assert.deepEqual(deploy.actions.map((x) => x.stage), ['deploy']);
  const dropped = tick(30, { files: [file('nytimes', 'Jesse Green', 5, { scoredAt: scored })], runs: [ORCH, run('rebuild-fast.yml', 'completed', 'Rebuild', { conclusion: 'success', startedAt: new Date(E + 15 * M).toISOString(), updatedAt: new Date(E + 20 * M).toISOString() })] });
  assert.deepEqual(dropped.actions, []);
  assert.deepEqual(dropped.summary.dropped, ['nytimes']);
  // A rebuild that started before the score and finished after it never contained the review: still the rebuild stage.
  const before = tick(30, { files: [file('nytimes', 'Jesse Green', 5, { scoredAt: scored })], runs: [ORCH, run('rebuild-fast.yml', 'completed', 'Rebuild', { conclusion: 'success', startedAt: new Date(E + 5 * M).toISOString(), updatedAt: new Date(E + 20 * M).toISOString() })] });
  assert.deepEqual(before.summary.dropped, []);
  assert.deepEqual(before.actions.map((x) => x.stage), ['rebuild']);
});

test('no pipeline in the first 2h: one orchestrator start; a page only if still none 15 min later with reviews waiting', () => {
  const a = tick(5);
  assert.deepEqual(a.actions.map((x) => x.type), ['dispatch-orchestrator']);
  const b = tick(25, { state: a.state });
  assert.deepEqual(b.actions, [], 'nothing found and waiting: a quiet night is not a page (second-opinion blocker 2)');
  const c = tick(25, { state: a.state, files: [file('nytimes', 'Jesse Green', 12)] });
  assert.equal(c.actions.filter((x) => x.type === 'page').length, 1);
  // Broadcast already done, or past +2h: no orchestrator start.
  assert.deepEqual(tick(5, { broadcastDone: true }).actions, []);
  assert.deepEqual(tick(130).actions, []);
});

test('lane-only nights and pre-embargo ticks only observe', () => {
  assert.deepEqual(tick(40, { laneOwnsNight: true, files: [file('nytimes', 'Jesse Green', 5)] }).actions, []);
  assert.deepEqual(tick(-10, { files: [file('nytimes', 'Jesse Green', -60)] }).actions, []);
});

test('files from before the night window and non-includable files are not found reviews', () => {
  const r = tick(40, { runs: [ORCH], files: [file('nytimes', 'Jesse Green', -6 * 60), file('ew', 'X', 5, { includable: false })] });
  assert.equal(r.found.length, 0);
});

test('runIsForShow: targeted runs for other shows do not count; untargeted ones do', () => {
  assert.equal(runIsForShow(run('opening-night-orchestrator.yml', 'in_progress', 'Opening Night Orchestrator targeted other-show (broadway)'), SHOW), false);
  assert.equal(runIsForShow(run('opening-night-orchestrator.yml', 'in_progress', 'Opening Night Orchestrator (broadway)'), SHOW), true);
  assert.equal(runIsForShow(run('opening-night-orchestrator.yml', 'in_progress', 'Opening Night Orchestrator (west-end)'), SHOW), false);
  assert.equal(runIsForShow(run('opening-night-poller.yml', 'in_progress', 'Opening Night Poller — auto'), SHOW), true);
  assert.equal(runIsForShow(run('opening-night-poller.yml', 'in_progress', 'Opening Night Poller — other'), SHOW), false);
  assert.equal(runIsForShow(run('llm-ensemble-score.yml', 'in_progress', `LLM Ensemble Score Reviews — a,${SHOW}`), SHOW), true);
});

test('an action not really sent (blind tick, failed write) keeps its once-per-night slot for the next tick', () => {
  const files = [file('nytimes', 'Jesse Green', 5)];
  const t1 = tick(25, { files, runs: [ORCH] });
  assert.deepEqual(t1.actions.map((x) => x.type), ['dispatch']);
  let st = t1.actions.reduce((acc, a) => undoUnsent({}, acc, a), t1.state);
  assert.deepEqual(st.retried, {});
  const t2 = tick(35, { files, runs: [ORCH], state: st });
  assert.deepEqual(t2.actions.map((x) => x.stage), ['score'], 'retried on the next seeing tick');
  // The orchestrator start and pages put back the same way; a sent action's state stays.
  const o = tick(5, {});
  assert.equal(o.actions[0].type, 'dispatch-orchestrator');
  assert.equal(undoUnsent({}, o.state, o.actions[0]).orchestratorAt, null);
  const paged = { retried: {}, orchestratorAt: null, paged: { stuck: 1 } };
  assert.equal(undoUnsent({ paged: {} }, paged, { type: 'page' }).paged.stuck, undefined);
  assert.equal(undoUnsent({ paged: { stuck: 1 } }, { ...paged, paged: { stuck: 1, resolved: 2 } }, { type: 'resolve' }).paged.resolved, undefined);
});
