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

// ship-check/Codex adversarial findings (BRO-3127): a first version of this
// fix gated downstream steps purely on steps.rebuild.outcome, which unblocked
// publish on ANY failure of the guard step — including an unexplained crash
// (can't read reviews.json, unhandled exception), not just its normal scoped
// "show X is missing" detection. The guard step now sets a safe_to_publish
// output that's only true for the scoped case (exit 1 WITH a populated
// missing-shows file) — false on an unexplained crash (exit 1 without one) —
// and downstream steps additionally gate on it.
for (const cfg of WINDOWS) {
  test(`${cfg.file}: the staleness guard step sets id: staleness and downstream steps gate on its safe_to_publish output`, () => {
    const { steps, anchorIdx, endIdx } = windowSteps(cfg);
    const guardIdx = steps.findIndex((s) => /Verify no scoreable review vanished/i.test(s.name || ''));
    assert.ok(guardIdx >= 0, `${cfg.file}: staleness guard step not found`);
    assert.ok(guardIdx > anchorIdx && guardIdx < endIdx, `${cfg.file}: staleness guard step must sit inside the fail-closed window`);
    assert.equal(
      steps[guardIdx].id,
      'staleness',
      `${cfg.file}: the staleness guard step must carry id: staleness — downstream steps gate on steps.staleness.outputs.safe_to_publish`
    );

    const run = String(steps[guardIdx].run || '');
    assert.match(
      run,
      /safe_to_publish=true/,
      `${cfg.file}: the guard step must set safe_to_publish=true on a clean run and on a SCOPED missing-show detection`
    );
    assert.match(
      run,
      /safe_to_publish=false/,
      `${cfg.file}: the guard step must set safe_to_publish=false when it fails WITHOUT a populated missing-shows file ` +
        '(an unexplained crash) — otherwise downstream steps publish blind on any guard failure, not just a scoped one'
    );

    // Every step in the window after the guard should reference safe_to_publish
    // (the ones before it — enrichment/utility steps that ran pre-rebuild —
    // are irrelevant here since this loop is scoped to the anchor..end window).
    // "Aggregate locked-skip counts" is deliberately exempt — it aggregates
    // PRE-rebuild utility-step log lines into the step summary, touches no
    // publish artifact (no public/data/, no reviews.json), and predates
    // BRO-3127 entirely (unchanged bare `always()`).
    const SAFE_TO_PUBLISH_EXEMPT = /^Aggregate locked-skip counts/;
    const after = steps.slice(guardIdx + 1, endIdx).filter((s) => !SAFE_TO_PUBLISH_EXEMPT.test(s.name || ''));
    const missingSafeCheck = after
      .filter((s) => !/steps\.staleness\.outputs\.safe_to_publish\s*==\s*'true'/.test(String(s.if || '')))
      .map((s) => `${s.name}: ${s.if}`);
    assert.deepEqual(
      missingSafeCheck,
      [],
      `${cfg.file}: these steps run after the staleness guard but do not check safe_to_publish, so an unexplained ` +
        `guard crash would still let them publish blind:\n  ` + missingSafeCheck.join('\n  ')
    );
  });

  test(`${cfg.file}: the revert step checks HEAD existence, not just the working-tree file, before deciding how to reconcile a flagged show`, () => {
    const { steps } = windowSteps(cfg);
    const revertIdx = steps.findIndex((s) => /Revert public data for shows flagged by staleness guard/i.test(s.name || ''));
    assert.ok(revertIdx >= 0, `${cfg.file}: revert step not found`);
    const run = String(steps[revertIdx].run || '');
    assert.match(
      run,
      /git cat-file -e "HEAD:/,
      `${cfg.file}: the revert step must check whether HEAD already has a committed version of the flagged show's ` +
        'public JSON before attempting `git checkout HEAD --` on it — a brand-new show (never committed) has nothing ' +
        'to revert to, and checking only the working-tree file (which regeneration just created) silently leaves the ' +
        'freshly-generated incomplete file in place to be published as-is'
    );
    assert.match(
      run,
      /rm -f "\$TARGET"/,
      `${cfg.file}: the revert step must REMOVE a brand-new flagged show's freshly-generated public JSON (no HEAD ` +
        'version to fall back to) rather than leave the incomplete regenerated state to be staged and published'
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
    // Matched by NAME, not by content: the guard step itself ALSO references
    // staleness-missing-shows.txt (it's what writes the path into $GITHUB_OUTPUT
    // messaging / reads it back for the safe_to_publish decision), so a
    // content-based search would false-match the guard step instead of the
    // actual revert step.
    const revertIdx = steps.findIndex((s) => /Revert public data for shows flagged by staleness guard/i.test(s.name || ''));
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
