// Executable backing for docs/BRO-373-codex-lane-decision.md.
//
// BRO-373's acceptance criteria are two-branched: EITHER a Codex delegation
// reaches a merged PR, OR the Codex lane is explicitly dropped and the
// Claude/Codex split is re-costed against Max limits — "verified by rerunning
// `node --test tests/unit/codex-delegation.test.mjs`". The lane was dropped
// (BRO-263 sat 5.8 days as `stalled`, and the codex agent's only substantive
// replies on this team are two "link your ChatGPT account" stubs), so this file
// is the drop branch's executable half.
//
// A drop decision that lives only in prose rots: someone re-adds an `@codex`
// mention six weeks from now, it silently never starts, and the board shows the
// issue as assigned the whole time — the exact failure mode that made the lane
// worse than no lane. So this test asserts three things:
//
//   1. The decision is RECORDED (the doc exists and says DROPPED, with the
//      reversal steps), so the next reader finds a decision, not a gap.
//   2. No repo code routes a Linear delegation to codex — the guard is the
//      literal `@codex` mention string, because on Linear a mention is what
//      actually starts an agent session. Re-adding the lane fails this test on
//      purpose and forces a conscious revisit of the doc.
//   3. The KEPT half survives. "Codex" names two different things here and only
//      the delegation lane is dropped; the adversarial-review lane found real
//      bugs (three of bsc-next.js's dispatch fixes exist because of it). A
//      future cleanup that reads "Codex: dropped" and rips out the review lane
//      would delete working machinery, so the doc must keep both rows distinct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DECISION = join(REPO, 'docs', 'BRO-373-codex-lane-decision.md');

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

test('the drop decision is recorded, not just remembered', () => {
  const doc = readFileSync(DECISION, 'utf8');
  assert.match(doc, /\*\*Status:\s*DROPPED/i, 'the doc must state the verdict in its own words');
  assert.match(doc, /BRO-263/, 'the doc must cite the smoke test that failed, so the verdict is evidence-backed');
  assert.match(doc, /check-linear-delegations\.js/, 'the doc must name the command that classified it stalled');
  assert.match(doc, /## How to reverse this/, 'a drop with no documented reversal path is a dead end, not a decision');
});

test('the re-cost the drop branch requires is actually written down', () => {
  const doc = readFileSync(DECISION, 'utf8');
  // BRO-373's drop branch is not satisfied by "we stopped using it" alone — the
  // acceptance text demands the Claude/Codex split be re-costed against Max
  // limits, because the original plan assumed load spread over two runners.
  assert.match(doc, /re-cost/i, 'the drop branch must re-cost the split, per BRO-373 acceptance');
  assert.match(doc, /100% of Linear\s*\n?\s*delegations route to the Cyrus\/Claude lane/i,
    'the re-cost must state where the dropped lane\'s load now goes');
  assert.match(doc, /dispatchCapDecision|SUCCESSION_DEPTH_CAP|DEAD_ATTEMPT_LIMIT/,
    'the re-cost must name the caps that actually bind, not hand-wave about limits');
});

test('no repo code routes a Linear delegation to codex', () => {
  // A Linear agent starts on a MENTION. `@codex` anywhere in code that writes to
  // Linear would silently re-open the lane, so the mention string is the guard.
  const offenders = [];
  for (const file of walkJs(join(REPO, 'scripts'))) {
    const src = readFileSync(file, 'utf8');
    if (/@codex/i.test(src)) offenders.push(relative(REPO, file));
  }
  assert.deepEqual(
    offenders, [],
    `the Codex delegation lane is dropped (docs/BRO-373-codex-lane-decision.md), but these files mention @codex: ${offenders.join(', ')}. ` +
    'If you are deliberately re-opening the lane, update that doc and this test together.'
  );
});

test('dropping the delegation lane does NOT drop the adversarial-review lane', () => {
  const doc = readFileSync(DECISION, 'utf8');
  assert.match(doc, /Codex \*\*review\*\* lane/, 'the doc must name the review lane separately');
  assert.match(doc, /KEPT/, 'the review lane must be explicitly kept, so a later cleanup does not delete it');
  // The review lane is load-bearing in a file anyone can check, not a claim.
  const bscNext = readFileSync(join(REPO, 'scripts', 'bsc-next.js'), 'utf8');
  assert.ok(
    /Codex adversarial/i.test(bscNext),
    'bsc-next.js should still carry the fixes credited to Codex adversarial review — ' +
    'if these are gone, re-read the decision doc before assuming the review lane is dead too'
  );
});
