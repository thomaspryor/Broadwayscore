'use strict';
// BRO-7198: the press-night priority step cancels only the go-live-now skill's safe list, only in a Broadway
// press-night window, and never a run for a show whose press night is tonight. Synthetic shows (no live data).
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./press-night-priority');

// Market-default embargo for a Broadway or Off-Broadway opening night 2026-11-08 is 2026-11-09T03:00Z.
const SHOWS = [
  { id: 'wanted-2022', market: 'broadway', category: 'broadway', openingDate: '2026-11-08' },
  { id: 'msblackforpresident-off-broadway-2026', market: 'broadway', category: 'off-broadway', openingDate: '2026-11-08' },
  { id: 'the-steel-man-off-broadway-2026', market: 'broadway', category: 'off-broadway' },
  { id: 'here-there-are-blueberries-2026', market: 'broadway', category: 'broadway', openingDate: '2026-11-09' },
  { id: 'the-visitors-off-broadway-2026', market: 'broadway', category: 'off-broadway', openingDate: '2026-11-09' },
  { id: 'tosca-english-national-opera-west-end-2026', market: 'london', category: 'west-end', openingDate: '2026-10-01' },
];
const W = (f) => `.github/workflows/${f}`;
const run = (id, wf, title, extra = {}) => ({ id, path: W(wf), display_title: title, name: '', event: 'workflow_dispatch', head_branch: 'main', status: 'in_progress', ...extra });

// The runs that were active at 03:30Z on Wanted's night (ids from the 2026-11-09 Actions history), plus one of each
// remaining safe-list workflow so every rule is exercised.
const RUNS = [
  run(1, 'opening-night-orchestrator.yml', 'Opening Night Orchestrator (broadway)'),
  run(2, 'opening-night-poller.yml', 'Opening Night Poller — wanted-2022'),
  run(3, 'land.yml', 'data: ack Wanted coverage hold so its opening-night score shows', { event: 'push', head_branch: 'land/wanted-coverage-ack' }),
  run(4, 'land.yml', 'BRO-7183: keep CLOUD.md under its byte cap', { event: 'push', head_branch: 'land/bro-7183', status: 'queued' }),
  run(5, 'opening-night-lane-live.yml', 'Opening-night lane shadow msblackforpresident-off-broadway-2026 2026-11-08'),
  run(6, 'opening-night-lane-live.yml', 'Opening-night lane shadow the-steel-man-off-broadway-2026 2026-11-08'),
  run(7, 'opening-night-lane-live.yml', 'Opening-night lane shadow wanted-2022 2026-11-08'),
  run(8, 'test.yml', 'Test Suite', { event: 'push' }),
  run(9, 'test.yml', 'Test Suite', { event: 'push', head_branch: 'land/bro-7183' }),
  run(10, 'gather-reviews.yml', 'Gather Review Data — msblackforpresident-off-broadway-2026'),
  run(11, 'gather-reviews.yml', 'Gather Review Data — the-steel-man-off-broadway-2026'),
  run(12, 'rebuild-fast.yml', 'Rebuild Reviews (Fast)', { status: 'queued' }),
  run(13, 'vercel-deploy.yml', 'Deploy to Vercel', { status: 'queued' }),
  run(14, 'ingest-urls.yml', 'Ingest Review URLs'),
  run(15, 'morning-digest-action.yml', 'Morning Digest', { event: 'workflow_run' }),
  run(16, 'vercel-demo.yml', 'Deploy Demo Site', { event: 'push', status: 'queued' }),
  run(17, 'mirror-data-to-gitlab.yml', 'Mirror Core Data to GitLab', { event: 'push', status: 'queued' }),
  run(18, 'update-critic-consensus.yml', "Update Critics' Take", { event: 'schedule', status: 'queued' }),
  run(19, 'fetch-all-image-formats.yml', 'Fetch Show Images', { event: 'schedule' }),
  run(20, 'land-retry-cancelled.yml', 'Land retry on cancel', { event: 'workflow_run', status: 'queued' }),
  run(21, 'demo-alias-watchdog.yml', 'Demo Alias Watchdog', { event: 'schedule' }),
  run(22, 'check-direct-push-to-main.yml', 'Check Direct Push To Main', { event: 'push' }),
  run(23, 'llm-ensemble-score.yml', 'LLM Ensemble Score Reviews — tosca-english-national-opera-west-end-2026'),
  run(24, 'llm-ensemble-score.yml', 'LLM Ensemble Score Reviews — wanted-2022'),
  run(25, 'llm-ensemble-score.yml', 'LLM Ensemble Score Reviews'),
  run(26, 'press-night-probe.yml', 'Press night probe wanted-2022 2026-11-08'),
  run(27, 'press-night-watchdog.yml', 'Press night watchdog the-steel-man-off-broadway-2026 2026-11-08 (dry run)'),
  run(28, 'opening-night-lane-live.yml', 'Opening-night lane night the-steel-man-off-broadway-2026 2026-11-08'),
  run(29, 'gather-reviews.yml', 'Gather Review Data — the-steel-man-off-broadway-2026,wanted-2022'),
  run(30, 'extract-pull-quotes.yml', 'Extract Pull Quotes'),
  run(31, 'execute-approved-fix.yml', 'Execute Approved Fix'),
  run(32, 'opening-night-lane-switch.yml', 'Opening-night lane switch'),
  run(33, 'fetch-all-image-formats.yml', 'Fetch Show Images', { status: 'completed' }),
];
// Auto: no alert, no follow-up job, no lost work. Manual: on the skill's list, but a cancel pages, re-queues or loses work.
const EXPECTED_CANCEL = [16, 18, 20, 21, 23, 27];
const EXPECTED_MANUAL = [6, 8, 11, 17, 19, 22];

const ids = (list) => list.map((x) => x.run.id).sort((a, b) => a - b);

test('BRO-7198: inside Wanted\'s window the plan cancels exactly the safe-to-cancel runs', () => {
  const plan = P.planPriority({ shows: SHOWS, runs: RUNS, nowMs: Date.parse('2026-11-09T03:30:00Z') });
  assert.deepEqual(plan.tonight.map((t) => t.id), ['wanted-2022']);
  assert.deepEqual(ids(plan.cancel), EXPECTED_CANCEL);
  assert.deepEqual(ids(plan.manual), EXPECTED_MANUAL);
  assert.equal(plan.cancel.length + plan.manual.length + plan.keep.length, RUNS.length);
});

test('BRO-7198: outside every Broadway window nothing is cancelled', () => {
  for (const now of ['2026-11-09T01:59:00Z', '2026-11-09T09:01:00Z', '2026-11-08T12:00:00Z']) {
    const plan = P.planPriority({ shows: SHOWS, runs: RUNS, nowMs: Date.parse(now) });
    assert.equal(plan.cancel.length + plan.manual.length, 0, now);
  }
});

test('BRO-7198: window edges are embargo - 1h and embargo + 6h', () => {
  assert.deepEqual(P.tonightShows(SHOWS, Date.parse('2026-11-09T02:00:00Z')).map((s) => s.id), ['wanted-2022']);
  assert.deepEqual(P.tonightShows(SHOWS, Date.parse('2026-11-09T09:00:00Z')).map((s) => s.id), ['wanted-2022']);
});

test('BRO-7198: an Off-Broadway-only night does not switch priority on, but its runs are protected on a Broadway night', () => {
  const offOnly = SHOWS.filter((s) => s.category !== 'broadway');
  assert.equal(P.planPriority({ shows: offOnly, runs: RUNS, nowMs: Date.parse('2026-11-09T03:30:00Z') }).cancel.length, 0);
  const plan = P.planPriority({ shows: SHOWS, runs: RUNS, nowMs: Date.parse('2026-11-09T03:30:00Z') });
  for (const id of [5, 10]) assert.ok(plan.keep.some((k) => k.run.id === id), `run ${id} (Ms. Black opens tonight) must be kept`);
});

test('BRO-7198: next night protects Blueberries and The Visitors', () => {
  const nowMs = Date.parse('2026-11-10T03:30:00Z');
  const runs = [
    run(1, 'opening-night-lane-live.yml', 'Opening-night lane shadow here-there-are-blueberries-2026 2026-11-09'),
    run(2, 'gather-reviews.yml', 'Gather Review Data — the-visitors-off-broadway-2026'),
    run(3, 'llm-ensemble-score.yml', 'LLM Ensemble Score Reviews — here-there-are-blueberries-2026'),
    run(4, 'llm-ensemble-score.yml', 'LLM Ensemble Score Reviews — the-steel-man-off-broadway-2026'),
  ];
  const plan = P.planPriority({ shows: SHOWS, runs, nowMs });
  assert.deepEqual(plan.tonight.map((t) => t.id), ['here-there-are-blueberries-2026']);
  assert.deepEqual(ids(plan.cancel), [4]);
});

test('BRO-7198: never-cancel workflows are not on any safe list (a later edit cannot add them by accident)', () => {
  const auto = [...Object.keys(P.AUTO_SAFE), ...Object.keys(P.AUTO_OTHER_SHOW)];
  const manual = [...Object.keys(P.MANUAL_SAFE), ...Object.keys(P.MANUAL_MAIN_PUSH), ...Object.keys(P.MANUAL_OTHER_SHOW), P.LANE_LIVE];
  for (const wf of P.NEVER) assert.ok(!auto.includes(wf) && !manual.includes(wf), wf);
  for (const wf of auto) assert.ok(!manual.includes(wf), `${wf} is on both the auto and the by-hand list`);
  const ctx = { tonightIds: [], knownIds: SHOWS.map((s) => s.id) };
  for (const wf of P.NEVER) assert.equal(P.classifyRun({ id: 1, path: wf, display_title: 'x', status: 'queued' }, ctx).action, 'keep', wf);
});

test('BRO-7198: tests on main and alerting workflows are never cancelled automatically', () => {
  const ctx = { tonightIds: ['wanted-2022'], knownIds: SHOWS.map((s) => s.id) };
  for (const wf of ['test.yml', 'mirror-data-to-gitlab.yml', 'fetch-all-image-formats.yml', 'gather-reviews.yml', 'press-night-probe.yml']) {
    const d = P.classifyRun(run(1, wf, `X — the-steel-man-off-broadway-2026`, { event: 'push' }), ctx);
    assert.notEqual(d.action, 'cancel', wf);
  }
});

test('BRO-7198: show ids match whole tokens only', () => {
  const known = ['wanted-2022', 'wanted'];
  assert.deepEqual(P.showIdsInTitle('Gather Review Data — wanted-2022', known), ['wanted-2022']);
  assert.deepEqual(P.showIdsInTitle('Gather Review Data — a,b', ['a', 'b', 'c']), ['a', 'b']);
});
