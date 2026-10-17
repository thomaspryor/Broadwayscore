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
const { planShapeProblems, planWordingProblems, pendingPlanProblems, planStatusWarning } = require('../../scripts/lib/pending-fix-plan-checks.js');
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

const edit = (field, newValue) => ({ type: 'data-edit', file: 'commercial.json', showSlug: 'six', field, oldValue: null, newValue });
const plan = (actions, extra = {}) => ({ planId: 'p-1', status: 'pending', plan: { actions }, ...extra });
const many = (n) => Array.from({ length: n }, () => edit('capitalization', 1));

test('planShapeProblems: the action cap, planId and actions shape (fixtures)', () => {
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(MAX_PLAN_ACTIONS))), []);
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(MAX_PLAN_ACTIONS + 1))), [
    `bro-1.json: ${MAX_PLAN_ACTIONS + 1} actions (max ${MAX_PLAN_ACTIONS}); split it into bro-1-b.json`,
  ]);
  assert.deepEqual(planShapeProblems('bro-1.json', plan(many(1), { planId: undefined })), ['bro-1.json: missing planId']);
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
