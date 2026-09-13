import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { conditionIsFailClosed } = require('../../scripts/lib/workflow-fail-closed-condition.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

/**
 * BRO-3127: rebuild-fast.yml / rebuild-reviews.yml both run a hard-failing
 * guard step (check-rebuild-staleness.js) partway through their job. Before
 * this fix, every step after it had no `if:`, so GitHub Actions' default
 * `if: success()` meant the guard's failure for ONE unrelated show silently
 * skipped every downstream step — including the one that writes
 * public/data/shows/{id}.json, the file the live site reads — for every
 * OTHER show in the run (rebuild-fast.yml run 34318929964, 2026-09-09: a
 * sylvia-off-west-end-2026 drift blocked jane-eyre-off-west-end-2026's
 * freshly-scored review from ever reaching prod).
 *
 * Fix mirrors BRO-2906's anchor pattern exactly (test.yml's lint-workflows
 * job, id: deps + tests/unit/workflow-audit-steps-always.test.mjs, whose
 * conditionIsFailClosed() this file reuses via
 * scripts/lib/workflow-fail-closed-condition.js rather than reimplementing a
 * parallel, potentially weaker check): `id: rebuild` on the "Rebuild
 * reviews.json" step, `always() && steps.rebuild.outcome == 'success'` on
 * everything through "Get new review count". The guard's own failure no
 * longer skips downstream steps, while a genuine EARLIER failure (checkout,
 * the rebuild itself) still does, since steps.rebuild never reaches
 * 'success' in that case.
 *
 * This is a POSITION rule, like BRO-2906's — not a name-matcher — so a new
 * step inserted into this window is covered even if nobody remembers to name
 * it here.
 */
const WINDOWS = [
  { file: 'rebuild-fast.yml', jobId: 'rebuild-fast', anchorId: 'rebuild', endId: 'changes', minSteps: 6 },
  { file: 'rebuild-reviews.yml', jobId: 'rebuild', anchorId: 'rebuild', endId: 'changes', minSteps: 11 },
];

function loadWorkflow(file) {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf-8'));
}

function windowSteps({ file, jobId, anchorId, endId }) {
  const job = loadWorkflow(file).jobs[jobId];
  assert.ok(job, `${file}: no job "${jobId}"`);
  const steps = job.steps || [];
  const anchorIdx = steps.findIndex((s) => s.id === anchorId);
  const endIdx = steps.findIndex((s) => s.id === endId);
  const window = anchorIdx >= 0 && endIdx > anchorIdx ? steps.slice(anchorIdx + 1, endIdx) : [];
  return { steps, anchorIdx, endIdx, window };
}

for (const cfg of WINDOWS) {
  test(`${cfg.file}: anchor (${cfg.anchorId}) and boundary (${cfg.endId}) steps both exist, in order`, () => {
    const { anchorIdx, endIdx } = windowSteps(cfg);
    assert.ok(anchorIdx >= 0, `${cfg.file}: no step carries id: ${cfg.anchorId}`);
    assert.ok(endIdx >= 0, `${cfg.file}: no step carries id: ${cfg.endId}`);
    assert.ok(
      endIdx > anchorIdx,
      `${cfg.file}: ${cfg.endId} (index ${endIdx}) does not come after ${cfg.anchorId} (index ${anchorIdx})`
    );
  });

  test(`${cfg.file}: the ${cfg.anchorId} anchor step is unconditional`, () => {
    const { steps, anchorIdx } = windowSteps(cfg);
    const anchor = steps[anchorIdx];
    assert.equal(
      anchor.if,
      undefined,
      `${cfg.file}: the ${cfg.anchorId} anchor step must be unconditional; with an if: (${JSON.stringify(anchor.if)}) ` +
        'it can evaluate to skipped forever, and every step gated on its outcome is then skipped forever too'
    );
  });

  test(`${cfg.file}: the window between ${cfg.anchorId} and ${cfg.endId} is non-trivial (guard against a vacuous pass)`, () => {
    const { window } = windowSteps(cfg);
    assert.ok(
      window.length >= cfg.minSteps,
      `${cfg.file}: expected at least ${cfg.minSteps} steps between ${cfg.anchorId} and ${cfg.endId}, found ` +
        `${window.length} — the workflow shape changed and this rule may now be checking almost nothing`
    );
  });

  test(`${cfg.file}: EVERY step between ${cfg.anchorId} and ${cfg.endId} is fail-closed, by position not by name`, () => {
    const { window } = windowSteps(cfg);
    const offenders = window
      .filter((s) => !conditionIsFailClosed(s.if))
      .map((s) => `${cfg.file} / ${s.name || s.uses || '(unnamed)'}\n      if: ${JSON.stringify(s.if)}`);
    assert.deepEqual(
      offenders,
      [],
      `These steps run between the ${cfg.anchorId} anchor and the ${cfg.endId} boundary but are not ` +
        'fail-closed, so the staleness guard\'s failure (or any other earlier failure in this window) SKIPS ' +
        'them and the run silently stops publishing for every other show — the exact BRO-3127 bug:\n' +
        offenders.map((o) => `  - ${o}`).join('\n')
    );
  });

  test(`${cfg.file}: every gate in the window references the real ${cfg.anchorId} anchor, not a decoy`, () => {
    const { window } = windowSteps(cfg);
    const outcomeRef = /steps\.[A-Za-z0-9_-]+\.outcome/;
    const wrongRef = window
      .filter((s) => outcomeRef.test(String(s.if || '')))
      .filter((s) => !new RegExp(`steps\\.${cfg.anchorId}\\.outcome`).test(String(s.if || '')))
      .map((s) => `${s.name}: ${s.if}`);
    assert.deepEqual(
      wrongRef,
      [],
      `${cfg.file}: these steps gate on something other than steps.${cfg.anchorId} — a decoy step that is ` +
        `always skipped would permanently disable this window while looking correctly gated:\n  ` +
        wrongRef.join('\n  ')
    );
  });
}

test('check-rebuild-staleness.js writes the missing-shows file the workflow revert step reads (BRO-3127)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'check-rebuild-staleness.js'), 'utf-8');
  assert.match(
    src,
    /staleness-missing-shows\.txt/,
    'check-rebuild-staleness.js no longer writes the missing-shows file — the "Revert public data for shows ' +
      'flagged by staleness guard" step in rebuild-fast.yml/rebuild-reviews.yml would silently find nothing ' +
      'to revert, republishing incomplete data for the flagged show'
  );
});

for (const cfg of WINDOWS) {
  test(`${cfg.file}: a step reverts flagged shows' public JSON, positioned after mobile-artifact regen and inside the fail-closed window`, () => {
    const { steps, anchorIdx, endIdx } = windowSteps(cfg);
    const regenIdx = steps.findIndex((s) => /Regenerate mobile artifacts/i.test(s.name || ''));
    const revertIdx = steps.findIndex((s) => /staleness-missing-shows\.txt/.test(String(s.run || '')));
    assert.ok(regenIdx >= 0, `${cfg.file}: "Regenerate mobile artifacts" step not found`);
    assert.ok(
      revertIdx >= 0,
      `${cfg.file}: no step reads staleness-missing-shows.txt to revert flagged shows' public JSON`
    );
    assert.ok(
      revertIdx > regenIdx,
      `${cfg.file}: the revert step (index ${revertIdx}) must run AFTER "Regenerate mobile artifacts" ` +
        `(index ${regenIdx}) — reverting first would just get overwritten by the full regenerate`
    );
    assert.ok(
      revertIdx > anchorIdx && revertIdx < endIdx,
      `${cfg.file}: the revert step (index ${revertIdx}) must sit inside the fail-closed window ` +
        `(${anchorIdx}, ${endIdx}) or it won't run when the staleness guard actually fires`
    );
  });
}
