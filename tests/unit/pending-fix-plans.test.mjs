// Every pending session plan in data/pending-fixes must be applicable by
// execute-approved-fix.js. BRO-4492: a 41-action plan landed and was refused
// only at apply time. BRO-5007: a notes edit carrying "[Plausibility warning:
// ...]" was rolled back at apply time by the commercial rules validator. The
// checks live in scripts/lib/pending-fix-plan-checks.js, which the land push
// hook (scripts/lib/land-preflight.mjs) runs too: add new checks there, never
// inline here. They stay two tests so a red one on main cannot hide a new
// failure of the other kind in land.yml (it compares failing test names with
// base). Reads the directory (not git ls-files) so an uncommitted plan is
// checked too. Scoped to session-written bro-* plans: the feedback pipeline
// commits its numbered plans straight to main, and gating those here would turn
// main red with no code change (the BRO-3425 live-data trap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
const { planShapeProblems, planWordingProblems, pendingPlanProblems, planStatusWarning, finishedOnBranchProblems, localRunProblems } = require('../../scripts/lib/pending-fix-plan-checks.js');
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/pending-fixes');
const plans = () => fs.readdirSync(dir).filter(f => /^bro-.*\.json$/.test(f))
  .map(f => [f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]);

test('pending bro-* plans are applicable by execute-approved-fix', () => {
  const all = plans();
  assert.ok(all.length > 0, 'expected bro-* plans in data/pending-fixes');
  assert.deepEqual(all.flatMap(([f, plan]) => planShapeProblems(f, plan)), []);
});

test('pending bro-* plans write no internal wording into public commercial fields', () => {
  assert.deepEqual(plans().flatMap(([f, plan]) => planWordingProblems(f, plan)), []);
});

// BRO-5647: the executor tags each status it writes with where it ran; a
// local run's status on main means CI skipped the plan as done.
test('no bro-* plan carries a status a local execute-approved-fix run wrote', () => {
  assert.deepEqual(plans().flatMap(([f, plan]) => localRunProblems(f, plan)), []);
});

const edit = (field, newValue) => ({ type: 'data-edit', file: 'commercial.json', showSlug: 'six', field, oldValue: null, newValue });
const plan = (actions, extra = {}) => ({ planId: 'p-1', status: 'pending', plan: { actions }, ...extra });
const many = (n) => Array.from({ length: n }, () => edit('capitalization', 1));

test('planShapeProblems: the action cap, planId and actions shape (fixtures)', () => {
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(MAX_PLAN_ACTIONS))), []);
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(MAX_PLAN_ACTIONS + 1))), [
    `bro-1.json: ${MAX_PLAN_ACTIONS + 1} actions (max ${MAX_PLAN_ACTIONS}); split it into bro-1-b.json`,
  ]);
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(1), { planId: undefined })), ['bro-1.json: missing planId']);
});

// BRO-5843: the executor stamps openingDateSource 'human-correction' when it applies an openingDate edit.
test('an openingDateSource edit after an openingDate edit must expect human-correction', () => {
  const se = (field, oldValue, newValue) => ({ type: 'data-edit', file: 'shows.json', showId: 'x', field, oldValue, newValue });
  assert.deepEqual(planShapeProblems('bro-1.json', plan([se('openingDate', null, '2024-01-02'), se('openingDateSource', 'human-correction', 'sourced')])), []);
  assert.equal(planShapeProblems('bro-1.json', plan([se('openingDate', null, '2024-01-02'), se('openingDateSource', null, 'sourced')])).length, 1);
  assert.deepEqual(planShapeProblems('bro-1.json', plan([se('openingDateSource', null, 'sourced')])), []);
  // Same class: setSynopsis stamps synopsisSource 'manual'.
  assert.equal(planShapeProblems('bro-1.json', plan([se('synopsis', null, 'A play.'), se('synopsisSource', null, 'llm')])).length, 1);
  assert.deepEqual(planShapeProblems('bro-1.json', plan([se('synopsis', null, 'A play.'), se('synopsisSource', 'manual', 'llm')])), []);
  assert.deepEqual(planShapeProblems('bro-1.json', { planId: 'p-1', status: 'pending', plan: {} }), ['bro-1.json: plan.actions is not an array']);
  // Only a pending plan is judged: an applied one stays in the directory as history.
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(MAX_PLAN_ACTIONS + 1), { status: 'applied' })), []);
});

test('planWordingProblems: internal wording in a public commercial field (fixtures)', () => {
  assert.deepEqual(planWordingProblems('bro-1.json', plan([edit('notes', 'Recouped per Playbill. [Plausibility warning: check date]')])), [
    'bro-1.json: six.notes contains "Plausibility warning" (the validator rolls this back; keep research notes in Linear)',
  ]);
  // A quoted source, a non-public field and a null action pass.
  assert.deepEqual(planWordingProblems('bro-1.json', plan([edit('recoupedSource', 'Playbill (Nov 25, 2024): "recouped"'), edit('designation', 'Windfall'), null])), []);
});

test('pendingPlanProblems is both kinds; planStatusWarning names a status the executor will not run (fixtures)', () => {
  const both = plan([...many(MAX_PLAN_ACTIONS), edit('notes', '[Plausibility warning: x]')]);
  assert.equal(pendingPlanProblems('bro-1.json', both).length, 2);
  assert.equal(planStatusWarning('bro-1.json', plan([])), null);
  assert.equal(planStatusWarning('bro-1.json', plan([], { status: 'applied' })), null);
  assert.match(planStatusWarning('bro-1.json', plan([], { status: 'approved' })), /bro-1\.json: status "approved" will not run/);
});

test('finishedOnBranchProblems and localRunProblems (fixtures, BRO-5647)', () => {
  const p = (status, extra = {}) => plan([], { status, ...extra });
  assert.match(finishedOnBranchProblems('bro-1.json', null, p('applied')).join(''), /bro-1\.json: this branch adds it as "applied"/);
  assert.match(finishedOnBranchProblems('bro-1.json', p('pending'), p('rejected')).join(''), /moves it from "pending" to "rejected".*rejectedAt/);
  assert.deepEqual(finishedOnBranchProblems('bro-1.json', p('applied'), p('applied')), []);
  assert.deepEqual(finishedOnBranchProblems('bro-1.json', null, p('pending')), []);
  // A status the executor does not know is planStatusWarning's, not this check's.
  assert.deepEqual(finishedOnBranchProblems('bro-1.json', null, p('approved')), []);
  assert.match(localRunProblems('bro-1.json', p('applied', { executedIn: 'local' })).join(''), /written by a local execute-approved-fix run/);
  assert.deepEqual(localRunProblems('bro-1.json', p('applied', { executedIn: 'ci' })), []);
  assert.deepEqual(localRunProblems('bro-1.json', p('applied')), []);
});

test('superseding withdraws an existing unresolved plan with evidence and preserves its actions', () => {
  const base = plan([edit('notes', 'Existing correction')]);
  const withdrawn = { ...base, status: 'superseded', supersededAt: '2026-10-26T12:00:00Z', supersededReason: 'BRO-5935: current data already has the requested value.' };
  assert.equal(planStatusWarning('bro-1.json', withdrawn), null);
  for (const status of ['pending', 'partial', 'validation-failed', 'superseded']) {
    assert.deepEqual(finishedOnBranchProblems('bro-1.json', { ...base, status }, withdrawn), []);
  }
  for (const old of [null, { ...base, status: 'applied' }, { ...base, status: 'rejected' }]) {
    assert.match(finishedOnBranchProblems('bro-1.json', old, withdrawn).join(''), /existing unresolved plan/);
  }
  for (const extra of [{ supersededReason: '' }, { supersededReason: '  ' }, { supersededAt: undefined }, { supersededAt: 'invalid' }]) {
    assert.match(finishedOnBranchProblems('bro-1.json', base, { ...withdrawn, ...extra }).join(''), /supersededAt.*supersededReason/);
  }
  for (const extra of [{ planId: 'different' }, { issueNumber: 'different' }, { plan: { ...base.plan, actions: [] } }]) {
    assert.match(finishedOnBranchProblems('bro-1.json', base, { ...withdrawn, ...extra }).join(''), /preserve the original plan/);
  }
});

// BRO-5892: two BRO-5853 authoring traps, caught before land.
test('planShapeProblems: issueNumber must name the file, review-file-op paths carry no data/review-texts/ prefix', () => {
  assert.deepEqual(planShapeProblems('bro-9-b.json', plan(many(1), { issueNumber: 'bro-9-b' })), []);
  assert.deepEqual(planShapeProblems('bro-9-b.json', plan(many(1))), []);
  assert.equal(planShapeProblems('bro-9-b.json', plan(many(1), { issueNumber: 'bro-9' })).length, 1);
  const op = (sourcePath) => ({ type: 'review-file-op', operation: 'delete', sourcePath });
  assert.deepEqual(planShapeProblems('bro-9.json', plan([op('show-2026/nyt--a.json')])), []);
  assert.match(planShapeProblems('bro-9.json', plan([op('data/review-texts/show-2026/nyt--a.json')]))[0], /drop the data\/review-texts\/ prefix/);
});

// BRO-6481: a move whose target was named destinationPath landed and failed at apply time.
test('planShapeProblems: review-file-op moves need destPath, operations are known', () => {
  const mv = (extra) => ({ type: 'review-file-op', operation: 'move', sourcePath: 'a-2026/x.json', ...extra });
  assert.deepEqual(planShapeProblems('bro-9.json', plan([mv({ destPath: 'b-2026/x.json' })])), []);
  assert.match(planShapeProblems('bro-9.json', plan([mv({ destinationPath: 'b-2026/x.json' })]))[0], /needs destPath \(rename destinationPath to destPath\)/);
  assert.match(planShapeProblems('bro-9.json', plan([mv({ destPath: ' ' })]))[0], /needs destPath/);
  assert.deepEqual(planShapeProblems('bro-9.json', plan([mv({ destinationPath: 'b' })], { status: 'partial' })), []);
  assert.deepEqual(planShapeProblems('bro-9.json', plan([{ type: 'review-file-op', operation: 'restore', sourcePath: 'a-2026/x.json' }])), []);
  assert.match(planShapeProblems('bro-9.json', plan([{ type: 'review-file-op', operation: 'remove', sourcePath: 'a-2026/x.json' }]))[0], /not one of delete, move, rename, restore/);
});
