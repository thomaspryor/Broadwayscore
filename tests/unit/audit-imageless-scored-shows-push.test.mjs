import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apiFallbackSafeEntriesFor } from '../../scripts/lib/core-data-merge-registry.js';
import {
  classifyPushFallbackSafety,
  stagedPathsPerCall,
  auditWorkflowText,
} from '../../scripts/lib/audit-push-retry-budgets.js';

// BRO-2942 (reverting BRO-2683). audit-imageless-scored-shows.yml's single
// "Commit audit ledger" step was split in two on the theory that bundling the
// apiFallbackSafe data/audit/imageless-scored-shows.json with the multi-writer
// alert-ledger.json / alert-router-attempts.jsonl defeated push-with-retry.sh's
// Git Data API fallback. That premise was already false when the split landed,
// and the split actively broke the workflow. This test pins all three facts so
// the split cannot be reapplied from the same reasoning:
//
//   1. The two telemetry files carry apiFallbackMerge:true (BRO-2413), and the
//      disqualifier is `(isManaged && !isApiFallbackMerge) || ...` — so they do
//      NOT disqualify the fallback. There was never anything to unblock.
//   2. The workflow must stage all three paths in ONE push-with-retry call.
//      Under a split, the telemetry files stay UNCOMMITTED while the first step
//      pushes, and push-with-retry.sh has zero autostash or clean-tree guards.
//      UNDER PUSH CONTENTION (not on an uncontended run, where the first push
//      just succeeds) that is fatal: the rebase refuses on unstaged changes and
//      the merge refuses as "would be overwritten", so the script falls to its
//      reset+cherry-pick last resort and runs
//      `git reset --hard origin/$PULL_BRANCH` (scripts/lib/push-with-retry.sh
//      :1682), reverting the telemetry files to the remote's content. The edits
//      are gone and routeAlert's 7-day cooldown never persists. Two later
//      resets (:1938 pre-fallback, :2114 on fallback success) would do the same,
//      but :1682 is the one that fires first and most often.
//   3. The single step must keep PUSH_DEADLINE_SEC=600. The split left the
//      higher-contention telemetry half on the 240s default, which the repo's
//      own audit flagged `deadline-cannot-fund-retries`.
//
// Every assertion below reads the REAL workflow text and the REAL registry
// predicates (CLAUDE.md rule 15) rather than restating them.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'audit-imageless-scored-shows.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

const LEDGER_FILE = 'data/audit/imageless-scored-shows.json';
const TELEMETRY_FILES = ['data/audit/alert-ledger.json', 'data/audit/alert-router-attempts.jsonl'];
const ALL_STAGED = [LEDGER_FILE, ...TELEMETRY_FILES];

test('registry: imageless-scored-shows.json is apiFallbackSafe with the required provenance fields', () => {
  const entry = apiFallbackSafeEntriesFor('public-repo').find((e) => e.file === 'audit/imageless-scored-shows.json');
  assert.ok(entry, 'audit/imageless-scored-shows.json must be registered apiFallbackSafe');
  assert.equal(typeof entry.concurrencyGroup, 'string');
  assert.ok(entry.concurrencyGroup.length > 0, 'apiFallbackSafe entry needs a concurrencyGroup');
  assert.equal(typeof entry.verifiedBy, 'string');
  assert.ok(entry.verifiedBy.length > 0, 'apiFallbackSafe entry needs a verifiedBy');
});

// THE LOAD-BEARING ASSERTION. This is the fact BRO-2683 missed. If someone
// flips apiFallbackMerge off these entries, the split becomes justified again
// and this test fails loudly rather than the workflow silently regressing.
test('predicate: the telemetry files do NOT disqualify the Git Data API fallback', () => {
  for (const file of TELEMETRY_FILES) {
    const c = classifyPushFallbackSafety(file);
    assert.equal(c.isApiFallbackMerge, true, `${file} must be apiFallbackMerge-registered (BRO-2413)`);
    assert.equal(
      c.disqualifiesFallback,
      false,
      `${file} must NOT disqualify the fallback — this is why bundling it with ${LEDGER_FILE} is safe and why the BRO-2683 split was unnecessary`,
    );
  }
  // The bundled file itself must still qualify, or the bundle proves nothing.
  assert.equal(classifyPushFallbackSafety(LEDGER_FILE).isApiFallbackSafe, true);
  assert.equal(classifyPushFallbackSafety(LEDGER_FILE).disqualifiesFallback, false);
});

// THE ANTI-SPLIT GUARD. A re-split yields two call sites with disjoint path
// sets, so both the length check and the membership check fail.
test('workflow: all three audit paths are staged in ONE push-with-retry call', () => {
  const perCall = stagedPathsPerCall(workflowText);
  assert.equal(
    perCall.length,
    1,
    `audit-imageless-scored-shows.yml must make exactly ONE push-with-retry.sh call; found ${perCall.length}. Splitting leaves the telemetry files uncommitted across the first push, where push-with-retry.sh's reset --hard discards them.`,
  );
  const staged = perCall[0];
  for (const file of ALL_STAGED) {
    assert.ok(staged.includes(file), `${file} must be staged in the single commit step`);
  }
  assert.equal(staged.length, ALL_STAGED.length, `unexpected staged paths: ${JSON.stringify(staged)}`);
});

// Codex adversarial ship-check finding. stagedPathsPerCall() collects every
// `git add` that precedes a push-with-retry call, but it does NOT prove those
// adds precede the `git commit`. Moving a telemetry `git add` to AFTER the
// commit would leave the test above green while reproducing the exact data
// loss this file exists to prevent: the file would still be dirty-but-
// uncommitted when push-with-retry.sh reaches its destructive resets
// (scripts/lib/push-with-retry.sh:1938 pre-fallback, :2114 on fallback
// success). Assert the ORDER inside the step body, not just the membership.
test('workflow: every audit path is staged BEFORE the commit, not merely before the push', () => {
  const stepStart = workflowText.indexOf('- name: Commit audit ledger');
  assert.ok(stepStart !== -1, 'could not locate the "Commit audit ledger" step');
  // Bound the slice at the next step so a later step's git commit can't satisfy us.
  const nextStep = workflowText.indexOf('\n      - name:', stepStart + 1);
  const stepBody = workflowText.slice(stepStart, nextStep === -1 ? workflowText.length : nextStep);

  const commitIdx = stepBody.indexOf('git commit');
  assert.ok(commitIdx !== -1, 'the step must contain a git commit');

  // Match the file only on an actual `git add` LINE, never a bare mention:
  // a filename appearing in a comment above the commit would otherwise satisfy
  // the ordering assertion (ship-check P2). The two telemetry paths share one
  // multi-path `git add`, so scan lines rather than looking for `git add <file>`.
  const addLineIndexFor = (file) => {
    let offset = 0;
    for (const line of stepBody.split('\n')) {
      const start = offset;
      offset += line.length + 1;
      const code = line.split('#')[0];
      if (code.includes('git add') && code.includes(file)) return start;
    }
    return -1;
  };

  for (const file of ALL_STAGED) {
    const addIdx = addLineIndexFor(file);
    assert.ok(addIdx !== -1, `${file} is not staged by a git add line in the "Commit audit ledger" step`);
    assert.ok(
      addIdx < commitIdx,
      `${file} must be git-added BEFORE the git commit. Staged after it, the file stays dirty-but-uncommitted through push-with-retry.sh; under push contention its reset+cherry-pick path (push-with-retry.sh:1682) reverts the file to the remote's content and the edit is gone.`,
    );
  }
});

test('workflow: the commit step keeps the raised push deadline and is not retry-starved', () => {
  const sites = auditWorkflowText(workflowText, 'audit-imageless-scored-shows.yml');
  assert.equal(sites.length, 1, 'expected exactly one push-with-retry call site');
  const site = sites[0];
  // Read the parsed value, never a grep for "600" — the string can be present
  // for the wrong reason (a comment, or a sibling step that still carries it).
  assert.ok(
    site.deadlineSec >= 600,
    `PUSH_DEADLINE_SEC must stay >= 600 (PR 667 raised it after live run 32576759555 exhausted the budget); got ${site.deadlineSec}`,
  );
  assert.ok(
    !site.flags.includes('deadline-cannot-fund-retries'),
    `step must not be retry-starved; flags: ${JSON.stringify(site.flags)}`,
  );
});
