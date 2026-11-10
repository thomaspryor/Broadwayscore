// BRO-6863: what the press-night record keeps about the night's pipeline (runs, scoredAt, in-core) for the replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pnr = require('./press-night-runs.js');

const norm = (o) => (o ? String(o).toLowerCase().replace(/[^a-z]/g, '') : null);
const EMB = '2026-11-09T03:00:00.000Z';
const at = (m) => new Date(Date.parse(EMB) + m * 60000).toISOString();

test('runsWindow: embargo -2h to +3h, listed from an hour earlier; null for a bad embargo', () => {
  const z = (m) => at(m).replace('.000Z', 'Z');
  assert.deepEqual(pnr.runsWindow(EMB), { from: z(-120), to: z(180), listFrom: z(-480), listTo: z(180) });
  assert.equal(pnr.runsWindow('nope'), null);
});

test('runsWindow lists back at least the longest watched job timeout (orchestrator 360 min), so a run created then and still active is kept', async () => {
  const fs = await import('node:fs');
  for (const wf of pnr.WATCHED_WORKFLOWS) {
    const yml = fs.readFileSync(new URL(`../../.github/workflows/${wf}`, import.meta.url), 'utf8');
    for (const m of yml.matchAll(/^\s{4}timeout-minutes:\s*(\d+)/gm)) assert.ok(Number(m[1]) <= pnr.LIST_LEAD_MIN, `${wf} job timeout ${m[1]} > LIST_LEAD_MIN`);
  }
  const win = pnr.runsWindow(EMB);
  const orch = { status: 'completed', conclusion: 'success', display_title: 'o', run_started_at: at(-470), updated_at: at(-100) };
  const listing = Object.fromEntries(pnr.WATCHED_WORKFLOWS.map((wf) => [wf, { runs: [] }]));
  listing['opening-night-orchestrator.yml'] = { runs: [orch] };
  assert.ok(Date.parse(win.listFrom) <= Date.parse(orch.run_started_at));
  assert.equal(pnr.pipelineRunsFrom(listing, win, at(360)).runs.length, 1);
});

test('pipelineRunsFrom: a listing at GitHub\'s 1000-run cap is not complete', () => {
  const win = pnr.runsWindow(EMB);
  const listing = Object.fromEntries(pnr.WATCHED_WORKFLOWS.map((wf) => [wf, { runs: [] }]));
  listing['vercel-deploy.yml'] = { runs: Array.from({ length: 1000 }, () => ({ status: 'completed', run_started_at: at(0), updated_at: at(1) })) };
  const p = pnr.pipelineRunsFrom(listing, win, at(360));
  assert.equal(p.complete, false);
  assert.match(p.errors[0].error, /1000-run cap/);
});

test('coreFreshForNight: only a reviews.json written after embargo +3h is the night\'s end state', () => {
  assert.equal(pnr.coreFreshForNight(Date.parse(at(-150)), EMB), false); // the probe's own clone, before the night
  assert.equal(pnr.coreFreshForNight(Date.parse(at(179)), EMB), false);
  assert.equal(pnr.coreFreshForNight(Date.parse(at(180)), EMB), true);
  assert.equal(pnr.coreFreshForNight(NaN, EMB), false);
  assert.equal(pnr.coreFreshForNight(Date.parse(at(400)), 'bad'), false);
});

test('slimRun: REST fields map to the replay row; nothing else is kept', () => {
  const api = { id: 1, status: 'completed', conclusion: 'success', display_title: 'Opening Night Poller — x', run_started_at: at(5), created_at: at(4), updated_at: at(30), head_sha: 'abc' };
  assert.deepEqual(pnr.slimRun(api, 'opening-night-poller.yml'),
    { workflow: 'opening-night-poller.yml', status: 'completed', conclusion: 'success', displayTitle: 'Opening Night Poller — x', startedAt: at(5), updatedAt: at(30) });
});

test('pipelineRunsFrom: keeps runs active in the window, sorted; complete only when all five workflows listed', () => {
  const win = pnr.runsWindow(EMB);
  const r = (s, u) => ({ status: 'completed', conclusion: 'success', display_title: 't', run_started_at: at(s), updated_at: at(u) });
  const listing = Object.fromEntries(pnr.WATCHED_WORKFLOWS.map((wf) => [wf, { runs: [] }]));
  listing['rebuild-fast.yml'] = { runs: [r(-170, -150), r(-130, -110), r(30, 40), r(185, 190)] };
  listing['vercel-deploy.yml'] = { runs: [r(10, 20)] };
  const p = pnr.pipelineRunsFrom(listing, win, at(360));
  assert.equal(p.complete, true);
  assert.equal(p.errors, undefined);
  // -170..-150 ended before the window; 185 started after it; -130..-110 overlaps its start.
  assert.deepEqual(p.runs.map((x) => `${x.workflow}@${x.startedAt}`), [`rebuild-fast.yml@${at(-130)}`, `vercel-deploy.yml@${at(10)}`, `rebuild-fast.yml@${at(30)}`]);
  assert.deepEqual(p.window, { from: win.from, to: win.to });

  listing['llm-ensemble-score.yml'] = { error: 'HTTP 403' };
  const bad = pnr.pipelineRunsFrom(listing, win, at(360));
  assert.equal(bad.complete, false);
  assert.deepEqual(bad.errors, [{ workflow: 'llm-ensemble-score.yml', error: 'HTTP 403' }]);
});

test('mergePipelineRuns / recordedRuns: an incomplete capture never replaces a complete one, nor feeds the replay', () => {
  const good = { complete: true, runs: [{ workflow: 'rebuild-fast.yml' }] };
  const bad = { complete: false, runs: [], errors: [{ workflow: 'x', error: 'y' }] };
  assert.equal(pnr.mergePipelineRuns(good, bad), good);
  assert.equal(pnr.mergePipelineRuns(undefined, bad), bad);
  assert.equal(pnr.mergePipelineRuns(bad, good), good);
  assert.equal(pnr.recordedRuns({ pipelineRuns: good }), good.runs);
  assert.equal(pnr.recordedRuns({ pipelineRuns: bad }), null);
  assert.equal(pnr.recordedRuns({}), null);
});

test('stampReviewTimes: perReview scoredAt from the matching file, in-core flag from reviews.json rows', () => {
  const rec = {
    perReview: [{ outlet: 'NYT', critic: 'Ann Bé' }, { outlet: 'Variety', critic: 'Initials' }, { outlet: 'Vulture', critic: 'C' }, { outlet: 'Gone', critic: 'X', scoredAt: 'stale' }],
    fileState: { files: [
      { outletId: 'nyt', critic: 'Ann Be', scoredAt: at(5) },
      { outletId: 'variety', critic: 'Full Name', scoredAt: at(7) }, // one file for the outlet: matched by outlet
      { outletId: 'vulture', critic: 'C', scoredAt: null },
      { outletId: 'timeout', critic: 'D', scoredAt: at(9) },
    ] },
  };
  // Variety: core says "F. Name", the file "Full Name"; one of each for the outlet, so the same review.
  const n = pnr.stampReviewTimes(rec, [{ outletId: 'nyt', criticName: 'Ann Be' }, { outlet: 'Time Out', criticName: 'D' }, { outletId: 'variety', criticName: 'F. Name' }], norm);
  assert.deepEqual(rec.perReview.map((p) => p.scoredAt), [at(5), at(7), undefined, undefined]);
  assert.deepEqual(rec.fileState.files.map((f) => f.inCoreAtEnd), [true, true, false, true]);
  assert.deepEqual(n, { scored: 2, reviews: 4, inCore: 3, files: 4, coreKnown: true });
  // Two critics at one outlet: a name mismatch is ambiguous, so unknown (null), never false (which reads as dropped).
  const rec3 = { perReview: [], fileState: { files: [{ outletId: 'nysr', critic: 'A' }, { outletId: 'nysr', critic: 'B' }] } };
  pnr.stampReviewTimes(rec3, [{ outletId: 'nysr', criticName: 'A.' }, { outletId: 'nysr', criticName: 'Z' }], norm);
  assert.deepEqual(rec3.fileState.files.map((f) => f.inCoreAtEnd), [true, null]);
  // reviews.json unavailable: in-core stays unknown, never false.
  const rec2 = { perReview: [], fileState: { files: [{ outletId: 'nyt', critic: 'A' }] } };
  assert.equal(pnr.stampReviewTimes(rec2, null, norm).coreKnown, false);
  assert.equal(rec2.fileState.files[0].inCoreAtEnd, undefined);
});

test('replayFiles: file scoredAt wins, perReview scoredAt fills a gap, else null', () => {
  const rec = { perReview: [{ outlet: 'NYT', critic: 'A', scoredAt: at(3) }], fileState: { files: [{ outletId: 'nyt', critic: 'A' }, { outletId: 'x', critic: 'B', scoredAt: at(4) }, { outletId: 'y', critic: 'C' }] } };
  assert.deepEqual(pnr.replayFiles(rec, norm).map((f) => f.scoredAt), [at(3), at(4), null]);
  assert.deepEqual(pnr.replayFiles({}, norm), []);
});

test('coreRowsAt: a scored review enters core when the first rebuild started after its scoring ends, or when it went live', () => {
  const rb = (s, e, conclusion = 'success') => ({ workflow: 'rebuild-fast.yml', conclusion, startedAt: at(s), updatedAt: at(e) });
  const runs = [rb(0, 8), rb(12, 20, 'failure'), rb(15, 25)];
  const files = [
    { outletId: 'a', critic: 'A', scoredAt: at(10), inCoreAtEnd: true }, // rebuild 15..25 (12..20 failed)
    { outletId: 'b', critic: 'B', scoredAt: at(10), inCoreAtEnd: false }, // dropped: never in core
    { outletId: 'c', critic: 'C', scoredAt: null, inCoreAtEnd: true }, // not scored: never modelled in core
    { outletId: 'd', critic: 'D', scoredAt: at(30) }, // no end stamp: in core when it went live (+40)
    { outletId: 'e', critic: 'E', scoredAt: at(30) }, // no end stamp, never live: not in core
  ];
  const live = { d: Date.parse(at(40)) };
  const rows = (m) => pnr.coreRowsAt(files, runs, Date.parse(at(m)), (f) => live[f.outletId] ?? NaN).map((r) => r.outletId);
  assert.deepEqual(rows(24), []);
  assert.deepEqual(rows(25), ['a']);
  assert.deepEqual(rows(40), ['a', 'd']);
  assert.deepEqual(pnr.coreRowsAt(files, null, Date.parse(at(60)), () => NaN).map((r) => r.outletId), []);
});

test('stampReviewTimes: an unscored critic at a two-critic outlet never takes the other critic\'s scoredAt', () => {
  const rec = { perReview: [{ outlet: 'NYSR', critic: 'Unscored Person' }, { outlet: 'NYSR', critic: 'B' }],
    fileState: { files: [{ outletId: 'nysr', critic: 'B', scoredAt: at(5) }, { outletId: 'nysr', critic: 'Unscored Person', scoredAt: null }] } };
  pnr.stampReviewTimes(rec, null, norm);
  assert.deepEqual(rec.perReview.map((p) => p.scoredAt), [undefined, at(5)]);
  // Same with the unscored file named differently from the site (initials): still not matched by outlet.
  const rec2 = { perReview: [{ outlet: 'NYSR', critic: 'U. P.' }], fileState: { files: rec.fileState.files } };
  pnr.stampReviewTimes(rec2, null, norm);
  assert.equal(rec2.perReview[0].scoredAt, undefined);
});
