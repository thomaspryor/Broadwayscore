/**
 * autonomous-merge-parity.test.mjs — the ONE thing that makes the owner's
 * morning Approve tap mean what the email says it means (Sprint 2, S2-T3).
 *
 * The tap re-verifies from scratch in CI, on a different machine, possibly
 * days after the overnight run. If that re-verification runs a SMALLER check
 * set than the run that produced the evidence, the tap silently approves less
 * than it claims. This file asserts the two paths cannot diverge:
 *
 *   1. identity — both modules resolve tier and plan checks through the SAME
 *      function objects (scripts/lib/autonomous-checks.js), not two copies
 *   2. output   — for the same diff at the same tier, the plans are equal
 *   3. structure — neither module defines its own checksEnv/decideChecks, and
 *      each passes its tier down to the shared runner
 *
 * (1)+(2) can't drift as long as (3) holds, and (3) is what a future edit
 * would have to break first — so it is asserted on the source text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executor = require('./autonomous-run.js');
const merge = require('./autonomous-merge.js');
const shared = require('./lib/autonomous-checks.js');

const runSrc = fs.readFileSync(new URL('./autonomous-run.js', import.meta.url), 'utf8');
const mergeSrc = fs.readFileSync(new URL('./autonomous-merge.js', import.meta.url), 'utf8');

const DIFFS = [
  ['docs/x.md'],
  ['tests/unit/a.test.mjs'],
  ['scripts/lib/outlet-canonicalize.js'],
  ['src/components/ShowCard.tsx'],
  ['src/lib/format.ts', 'scripts/bare.js', 'tests/unit/a.test.mjs'],
  ['src/app/globals.css'],
];

test('executor and approve tap plan checks with the SAME function object', () => {
  assert.equal(executor.decideChecks, shared.decideChecks);
  assert.equal(merge.decideChecks, shared.decideChecks);
  assert.equal(executor.tierOf, shared.tierOf);
  assert.equal(merge.tierOf, shared.tierOf);
});

test('same diff + same tier → identical check plan on both sides', () => {
  const exists = f => f === 'scripts/lib/outlet-canonicalize.test.mjs';
  for (const tier of [1, 3]) {
    for (const files of DIFFS) {
      const fromExecutor = executor.decideChecks(files, exists, { tier });
      const fromTap = merge.decideChecks(files, exists, { tier });
      assert.deepEqual(fromTap, fromExecutor,
        `check plans diverged for tier ${tier} diff ${files.join(',')}`);
    }
  }
});

// The executor reads the tier off the triage queue item; the tap reads it off
// the Notion evidence comment the executor wrote. Same reader, same field —
// so a tier-3 card is re-verified as tier 3, and a card with no tier stamp
// falls to Tier 1 on BOTH sides rather than one side widening.
test('tier resolution agrees across the carriers (item vs evidence)', () => {
  const item = { id: 'x', tier: 3, size: 'M' };
  const evidence = { branch: 'auto/x', tier: item.tier };
  assert.equal(merge.tierOf(evidence), executor.tierOf(item));
  assert.equal(merge.tierOf(evidence), 3);

  assert.equal(executor.tierOf({ id: 'y' }), 1);
  assert.equal(merge.tierOf({ branch: 'auto/y', tier: null }), 1);
  assert.equal(merge.tierOf(null), 1, 'missing evidence must not widen the gate');
  assert.equal(merge.tierOf({ tier: '3' }), 1, 'a string tier is not tier 3');
});

test('neither module redefines the shared env or plan', () => {
  for (const [name, src] of [['autonomous-run.js', runSrc], ['autonomous-merge.js', mergeSrc]]) {
    assert.ok(!/^function checksEnv\s*\(/m.test(src), `${name} must not define its own checksEnv`);
    assert.ok(!/^function decideChecks\s*\(/m.test(src), `${name} must not define its own decideChecks`);
    assert.ok(/require\('\.(\/lib)?\/autonomous-checks\.js'\)/.test(src), `${name} must use the shared runner`);
    assert.ok(/runSafeChecks\(\{/.test(src), `${name} must run checks through runSafeChecks`);
  }
});

test('both sides pass a tier through to the shared runner', () => {
  // Executor: tierOf(item) at the call site; tap: tierOf(evidence) in verifyRebase.
  assert.ok(/runChecks\(workdir, files, item\.checkableDone, tierOf\(item\)/.test(runSrc));
  assert.ok(/const tier = tierOf\(evidence\);/.test(mergeSrc));
  assert.ok(/runChecks\(files, evidence \? evidence\.checkableDone : null, tier\)/.test(mergeSrc));
});

// The gate that decides WHICH paths may land must follow the same tier as the
// checks — a tier-3 branch re-gated with the Tier-1 predicate is refused at
// the tap no matter how green its checks are (the bug this sprint fixes).
test('the tap gates the rebased diff with the tier-3 predicate for tier-3 evidence', () => {
  assert.ok(/isCodeDiffAllowed/.test(mergeSrc), 'merge must know the tier-3 gate exists');
  assert.ok(/tier === 3 \? isCodeDiffAllowed\(files\) : isDiffAllowed\(files\)/.test(mergeSrc));
});
