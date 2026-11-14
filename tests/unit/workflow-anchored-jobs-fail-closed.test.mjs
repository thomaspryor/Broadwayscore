// BRO-3224: the "hard-failing step silently skips everything after it" class
// hit twice (BRO-2906 test.yml lint-workflows, BRO-3127 rebuild-fast /
// rebuild-reviews) and was fixed both times with the same anchor:
// `if: always() && steps.<anchor>.outcome == 'success'` on every later step.
// Each fix got a test scoped to its own job. This one covers EVERY job in
// EVERY workflow that adopted the anchor, so a step added later without the
// guard (the recurrence) fails here instead of in an incident.
//
// Scope, honestly: a job that never adopted the anchor is not covered. A
// broader rule ("any step between a failing step and a later always() step")
// was measured on 2026-10-13 at 178 hits in 67 workflows, nearly all
// deliberate (do not commit after the audit crashed), so it cannot gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { anchorIdsOf, findAnchorGaps } = require('../../scripts/lib/workflow-fail-closed-condition.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WF_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// `${workflow}::${job}::${step name}` -> reason. Keep it empty unless a step
// genuinely must not run after an unrelated earlier failure.
// success() no longer counts as a guard (BRO-5261 retro-review), so a step
// that deliberately runs only on full success is listed here.
const EXEMPT = new Map([
  ['rebuild-reviews.yml::rebuild::Record pipeline success', 'records a SUCCESSFUL pipeline run; must not run after any failure'],
]);

function loadAll() {
  return fs.readdirSync(WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, yaml.load(fs.readFileSync(path.join(WF_DIR, f), 'utf8'))]);
}

test('the anchor is found where the two incidents were fixed (guard against a vacuous pass)', () => {
  const anchored = [];
  for (const [file, doc] of loadAll()) {
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      if (anchorIdsOf(job).length) anchored.push(`${file}::${jobId}`);
    }
  }
  for (const must of ['test.yml::lint-workflows', 'rebuild-fast.yml::rebuild-fast', 'rebuild-reviews.yml::rebuild', 'update-show-status.yml::update-shows']) {
    assert.ok(anchored.includes(must), `${must} no longer reads as anchored — the detector or the workflow changed (found: ${anchored.join(', ')})`);
  }
});

test('no anchored job has a step an unrelated earlier failure would skip', () => {
  const offenders = [];
  for (const [file, doc] of loadAll()) {
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      for (const gap of findAnchorGaps(job)) {
        const key = `${file}::${jobId}::${gap.name}`;
        if (!EXEMPT.has(key)) offenders.push(`${key} (if: ${gap.if === undefined ? 'none' : gap.if})`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'These steps sit after their job\'s `always() && steps.<anchor>.outcome == \'success\'` anchor but would be SKIPPED by ' +
    'any earlier failure (no if:, or an if: with no status function, which GitHub wraps in success()). Give them ' +
    '`always() && steps.<anchor>.outcome == \'success\'` (or a narrower always()/!cancelled() condition), or add an ' +
    'EXEMPT entry with the reason the step must not run after an unrelated failure.');
});

// True positives on the real files: strip the guard from ONE step after the
// anchor, as a later edit adding a step would, and the detector must see it.
function stripOneGuard(file, jobId) {
  const doc = yaml.load(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));
  const job = doc.jobs[jobId];
  const [anchorId] = anchorIdsOf(job);
  const start = job.steps.findIndex((s) => s.id === anchorId);
  const victim = job.steps.slice(start + 1).find((s) => s.if !== undefined);
  delete victim.if;
  return { job, victim };
}

test('BRO-2906 shape: an unguarded step added to test.yml lint-workflows is caught', () => {
  const { job, victim } = stripOneGuard('test.yml', 'lint-workflows');
  assert.ok(findAnchorGaps(job).some((g) => g.name === victim.name), `stripped "${victim.name}" but no gap reported`);
});

test('BRO-3127 shape: an unguarded publish step in rebuild-fast.yml is caught', () => {
  const { job, victim } = stripOneGuard('rebuild-fast.yml', 'rebuild-fast');
  assert.ok(findAnchorGaps(job).some((g) => g.name === victim.name), `stripped "${victim.name}" but no gap reported`);
});

test('an if: with no status function is an implicit success() and counts as a gap', () => {
  const job = { steps: [
    { id: 'deps', run: 'npm ci' },
    { name: 'a', if: "always() && steps.deps.outcome == 'success'" },
    { name: 'b', if: "always() && steps.deps.outcome == 'success'" },
    { name: 'c', if: "always() && steps.deps.outcome == 'success'" },
    { name: 'implicit', if: "steps.x.outputs.y == 'true'" },
    { name: 'explicit', if: "always() && steps.x.outputs.y == 'true'" },
    { name: 'not-cancelled', if: '${{ !cancelled() }}' },
    { name: 'coe-only', 'continue-on-error': true },
  ] };
  assert.deepEqual(findAnchorGaps(job).map((g) => g.name), ['implicit', 'coe-only']);
});

test('fewer than 3 steps on one anchor is incidental, not an adopted anchor', () => {
  const job = { steps: [
    { id: 'x', run: 'true' },
    { name: 'a', if: "always() && steps.x.outcome == 'success'" },
    { name: 'b', if: "always() && steps.x.outcome == 'success'" },
    { name: 'unguarded' },
  ] };
  assert.deepEqual(anchorIdsOf(job), []);
  assert.deepEqual(findAnchorGaps(job), []);
});

test('an explicit success() is not a guard; always()/!cancelled() anchors both count (BRO-5261)', () => {
  const anchorIf = (id) => `always() && steps.${id}.outcome == 'success'`;
  const job = (lastIf) => ({ steps: [
    { id: 'a', name: 'anchor', run: 'x' },
    { name: 's1', if: anchorIf('a'), run: 'x' },
    { name: 's2', if: "${{ !cancelled() && steps.a.outcome == 'success' }}", run: 'x' },
    { name: 's3', if: anchorIf('a'), run: 'x' },
    { name: 'late', if: lastIf, run: 'x' },
  ] });
  assert.deepEqual(anchorIdsOf(job("always()")), ['a']);
  assert.deepEqual(findAnchorGaps(job("success() && steps.a.outcome == 'success'")).map((g) => g.name), ['late']);
  assert.deepEqual(findAnchorGaps(job("!cancelled() && steps.a.outcome == 'success'")), []);
});
