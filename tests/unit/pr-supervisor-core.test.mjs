/**
 * Fixture tests for the PR supervisor decision function (Loop 5).
 *
 * The four PRs below are the REAL open agent PRs as of 2026-08-17, with their
 * real file lists taken from `gh pr view --json files`. The plan review named
 * two of them as the acceptance test for whether this policy works at all:
 *   - #592 must ESCALATE (forbidden work tangled with allowed work)
 *   - #593 must ESCALATE (collides with #591 on the same file)
 * Those two are the point. If either regresses to `merge`, the supervisor is
 * unsafe and this suite must fail.
 *
 * Run: node --test tests/unit/pr-supervisor-core.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessPullRequests,
  buildCollisionIndex,
  evidenceForSha,
  renderSupervisorDigest,
  buildStatusPayload,
  assessSupervisorStatus,
  MAX_LISTED_PRS,
  STATUS_STALE_AFTER_MS,
  isAdditiveEdit,
  rollupCheckState,
} = require('../../scripts/lib/pr-supervisor-core.js');

// Real file lists, 2026-08-17.
const PR596 = {
  number: 596, headSha: 'a17eb598b', title: 'feat: scripts/lib/linear.js',
  files: ['scripts/audit-linear-issuecreate-chokepoint.js', 'scripts/lib/linear.js',
    'scripts/lib/linear.test.mjs', 'tests/unit-test-manifest.txt'],
};
const PR594 = {
  number: 594, headSha: '09778ebcd', title: 'docs(BRO-383): classify the 34 project hooks',
  files: ['docs/BRO-383-hook-migration-analysis.md'],
};
const PR593 = {
  number: 593, headSha: '0d533c195', title: 'docs(dispatcher): port-or-delete table',
  files: ['.gitignore', 'docs/dispatcher-safety-port-table.md',
    'tests/unit-test-manifest.txt', 'tests/unit/dispatcher-safety-port-table.test.mjs'],
};
const PR592 = {
  number: 592, headSha: '1476b8863', title: 'feat(runner): budget cap, staggered quotas',
  files: ['scripts/lib/cyrus-runner-health.js', 'scripts/lib/cyrus-runner-health.test.mjs',
    'scripts/send-morning-digest.js', 'tests/unit-test-manifest.txt'],
};
const PR591 = {
  number: 591, headSha: 'ffb0326cd', title: 'docs(dispatcher): port-or-delete table (twin)',
  files: ['.gitignore', 'docs/dispatcher-safety-port-table.md'],
};
// Real per-file stats (all four PRs only ADD to the manifest / .gitignore).
const additive = (pr) => ({ ...pr, fileStats: Object.fromEntries(pr.files.map((f) => [f, { additions: 1, deletions: 0 }])) });
const ALL_OPEN = [PR596, PR594, PR593, PR592, PR591].map(additive);
const green = (pr, extra = {}) => ({ ...additive(pr), checksState: 'SUCCESS', ...extra });
const pass = (head) => [{ reviewer: 'ship-check', result: 'pass', head }];

const only = (rows, n) => rows.find((r) => r.number === n);

test('PR supervisor — the two acceptance cases the plan review named', async (t) => {
  await t.test('#592 ESCALATES: forbidden work tangled with allowed work', () => {
    const rows = assessPullRequests([green(PR592, { evidence: pass(PR592.headSha) })], { allOpenPrs: ALL_OPEN });
    const r = only(rows, 592);
    assert.equal(r.verdict, 'escalate', 'a mixed diff must never auto-merge and must never be silently closed');
    assert.ok(r.refused.includes('scripts/send-morning-digest.js'),
      'the send-* email exclusion must be the refusing file');
    assert.match(r.detail, /mixed diff/);
    // The allowed half is real work — that is exactly why this needs a human.
    assert.ok(r.refused.length < PR592.files.length, 'not every file is forbidden');
  });

  await t.test('#593 ESCALATES: collides with #591 on the same file', () => {
    const rows = assessPullRequests([green(PR593, { evidence: pass(PR593.headSha) })], { allOpenPrs: ALL_OPEN });
    const r = only(rows, 593);
    assert.equal(r.verdict, 'escalate');
    assert.deepEqual(r.collidesWith.map((c) => c.number), [591]);
    assert.ok(r.collidesWith[0].files.includes('docs/dispatcher-safety-port-table.md'),
      'the colliding document must be named, not just the PR number');
    assert.match(r.detail, /same file\(s\) as another open PR/);
  });

  await t.test('a collision is reported on BOTH sides, not just the newer PR', () => {
    const rows = assessPullRequests([green(PR591, { evidence: pass(PR591.headSha) })], { allOpenPrs: ALL_OPEN });
    assert.deepEqual(only(rows, 591).collidesWith.map((c) => c.number), [593]);
  });
});

test('PR supervisor — the other two open agent PRs', async (t) => {
  await t.test('#596 escalates: an excluded script alongside allowed work', () => {
    const rows = assessPullRequests([green(PR596, { evidence: pass(PR596.headSha) })], { allOpenPrs: ALL_OPEN });
    const r = only(rows, 596);
    assert.equal(r.verdict, 'escalate');
    assert.ok(r.refused.includes('scripts/audit-linear-issuecreate-chokepoint.js'));
  });

  await t.test('#594 is the only clean one: docs-only, deterministic-green', () => {
    const rows = assessPullRequests([green(PR594)], { allOpenPrs: ALL_OPEN });
    const r = only(rows, 594);
    assert.equal(r.deterministicGreen, true);
    assert.equal(r.verdict, 'merge', 'docs-only with green checks needs no SHA-bound verdict');
    assert.deepEqual(r.refused, []);
  });
});

test('PR supervisor — evidence must be bound to the commit', async (t) => {
  await t.test('a verdict recorded against an EARLIER sha does not carry forward', () => {
    const rows = assessPullRequests(
      [green({ ...PR596, files: ['scripts/lib/linear.js'] }, { evidence: pass('deadbeef0') })],
      { allOpenPrs: [] },
    );
    assert.equal(only(rows, 596).verdict, 'hold');
    assert.match(only(rows, 596).detail, /no passing review verdict bound to/);
  });

  await t.test('a verdict bound to THIS sha clears an otherwise-allowed code diff', () => {
    const pr = green({ ...PR596, files: ['scripts/lib/linear.js'] }, { evidence: pass(PR596.headSha) });
    assert.equal(only(assessPullRequests([pr], { allOpenPrs: [] }), 596).verdict, 'merge');
  });

  await t.test('a FAIL verdict on the right sha is not evidence', () => {
    const pr = green({ ...PR596, files: ['scripts/lib/linear.js'] },
      { evidence: [{ reviewer: 'ship-check', result: 'fail', head: PR596.headSha }] });
    assert.equal(only(assessPullRequests([pr], { allOpenPrs: [] }), 596).verdict, 'hold');
  });

  await t.test('a weak reviewer is not evidence for a code diff', () => {
    const pr = green({ ...PR596, files: ['scripts/lib/linear.js'] },
      { evidence: [{ reviewer: 'second-opinion', result: 'pass', head: PR596.headSha }] });
    assert.equal(only(assessPullRequests([pr], { allOpenPrs: [] }), 596).verdict, 'hold');
  });

  await t.test('evidenceForSha refuses to match when the PR has no headSha', () => {
    assert.equal(evidenceForSha(pass('abc'), null, new Set(['ship-check'])), null);
  });
});

test('PR supervisor — refusing to guess', async (t) => {
  await t.test('unknown CI state is NOT green — and neither is UNFETCHED', () => {
    // The original version only held when checksState was PRESENT and non-green,
    // so a caller that never fetched check state got `merge` with CI unexamined —
    // this module preaching "unknown is not green" while its own boundary treated
    // unfetched as green. Found by adversarial review, 2026-08-17.
    for (const state of ['FAILURE', 'PENDING', 'ERROR', '']) {
      assert.equal(only(assessPullRequests([{ ...additive(PR594), checksState: state }], { allOpenPrs: [] }), 594).verdict,
        'hold', `checksState ${JSON.stringify(state)} must hold`);
    }
    for (const missing of [null, undefined]) {
      const r = only(assessPullRequests([{ ...additive(PR594), checksState: missing }], { allOpenPrs: [] }), 594);
      assert.equal(r.verdict, 'hold', 'unfetched CI must hold, not merge');
      assert.match(r.detail, /not supplied/);
    }
    // Only an actually-green state merges.
    assert.equal(only(assessPullRequests([{ ...additive(PR594), checksState: 'SUCCESS' }], { allOpenPrs: [] }), 594).verdict, 'merge');
  });

  await t.test('an empty file list holds instead of passing as clean', () => {
    const r = only(assessPullRequests([green({ number: 1, headSha: 'x', files: [] })], { allOpenPrs: [] }), 1);
    assert.equal(r.verdict, 'hold');
    assert.match(r.detail, /no files in the diff/);
  });

  await t.test('a draft holds', () => {
    assert.equal(only(assessPullRequests([green(PR594, { isDraft: true })], { allOpenPrs: [] }), 594).verdict, 'hold');
  });

  await t.test('an all-forbidden diff is REFUSED, not escalated', () => {
    const pr = green({ number: 900, headSha: 'z', files: ['scripts/send-opening-night-broadcast.js'] });
    const r = only(assessPullRequests([pr], { allOpenPrs: [] }), 900);
    assert.equal(r.verdict, 'refuse');
    assert.match(r.detail, /every file is outside/);
  });

  await t.test('the most restrictive finding wins but every reason is reported', () => {
    const rows = assessPullRequests([{ ...PR593, checksState: 'FAILURE', isDraft: true }], { allOpenPrs: ALL_OPEN });
    const r = only(rows, 593);
    assert.equal(r.verdict, 'escalate', 'escalate outranks hold');
    assert.ok(r.reasons.length >= 3, `expected draft + collision + mixed-diff + CI, got ${r.reasons.length}`);
    assert.ok(r.reasons.some((x) => /draft/.test(x)));
    assert.ok(r.reasons.some((x) => /CI is FAILURE/.test(x)));
  });
});

test('PR supervisor — collision index', async (t) => {
  await t.test('a PR does not collide with itself', () => {
    assert.deepEqual(buildCollisionIndex([PR594]).get(594), []);
  });

  await t.test('collisions name every shared file, sorted and deduped', () => {
    const hit = buildCollisionIndex(ALL_OPEN).get(593).find((c) => c.number === 591);
    assert.deepEqual(hit.files, ['docs/dispatcher-safety-port-table.md']);
  });

  await t.test('an append-only registry is NOT a collision', () => {
    // #592, #593 and #596 all add a line to tests/unit-test-manifest.txt. If that
    // counted, the supervisor would escalate every PR that adds a test — noise
    // that trains the owner to ignore escalations. Caught by this suite when the
    // first version of the collision rule was written.
    const idx = buildCollisionIndex(ALL_OPEN);
    assert.deepEqual(idx.get(592), [], '#592 shares only the manifest with others');
    assert.deepEqual(idx.get(596), [], '#596 shares only the manifest with others');
    // ...but a real shared document still collides.
    assert.deepEqual(idx.get(593).map((c) => c.number), [591]);
  });

  await t.test('the exemption does not grant eligibility', () => {
    // .gitignore is exempt from COLLISION escalation but still forbidden work.
    const rows = assessPullRequests([green(PR591, { evidence: pass(PR591.headSha) })], { allOpenPrs: [PR591] });
    const r = only(rows, 591);
    assert.deepEqual(r.collidesWith, [], 'alone, #591 collides with nothing');
    assert.ok(r.refused.includes('.gitignore'), '.gitignore is still refused by the eligibility gate');
    assert.equal(r.verdict, 'escalate');
  });
});

test('PR supervisor — owner digest', async (t) => {
  await t.test('names what only the owner can unblock, and says nothing was merged', () => {
    const rows = assessPullRequests(
      [green(PR596, { evidence: pass(PR596.headSha) }), green(PR594),
        green(PR593, { evidence: pass(PR593.headSha) }), green(PR592, { evidence: pass(PR592.headSha) })],
      { allOpenPrs: ALL_OPEN },
    );
    const text = renderSupervisorDigest(rows, { dryRun: true });
    assert.match(text, /report only, nothing merged/);
    assert.match(text, /NEEDS A DECISION \(3\)/);
    assert.match(text, /#594/, 'the one mergeable PR must be named');
  });

  await t.test('empty input does not render a broken section', () => {
    assert.match(renderSupervisorDigest([]), /no open agent PRs/);
  });
});

test('PR supervisor — the additive exemption must be EARNED', async (t) => {
  // Adversarial review: the manifest is the explicit list of which tests CI runs.
  // One PR deleting a line while another adds one merges cleanly and silently
  // stops running a test. Exempting the file unconditionally hides that.
  const MANIFEST = 'tests/unit-test-manifest.txt';
  const adder = {
    number: 10, headSha: 'aaa', files: [MANIFEST],
    fileStats: { [MANIFEST]: { additions: 1, deletions: 0 } },
  };
  const deleter = {
    number: 11, headSha: 'bbb', files: [MANIFEST],
    fileStats: { [MANIFEST]: { additions: 0, deletions: 1 } },
  };

  await t.test('two purely-additive edits do NOT collide', () => {
    const other = { ...adder, number: 12, headSha: 'ccc' };
    assert.deepEqual(buildCollisionIndex([adder, other]).get(10), []);
  });

  await t.test('an edit that DELETES from the registry collides', () => {
    const idx = buildCollisionIndex([adder, deleter]);
    assert.deepEqual(idx.get(11).map((c) => c.number), [10],
      'the deleting PR must be flagged against the adder');
    assert.deepEqual(idx.get(10).map((c) => c.number), [11],
      'and the adder must see it too — a silently-dropped test affects both');
  });

  await t.test('unprovable additivity is NOT exempt — missing stats collide', () => {
    const noStats = { number: 13, headSha: 'ddd', files: [MANIFEST] }; // no fileStats
    const idx = buildCollisionIndex([adder, noStats]);
    assert.deepEqual(idx.get(13).map((c) => c.number), [10],
      'absence of evidence is not evidence of additivity');
  });

  await t.test('isAdditiveEdit never exempts a file outside the registry list', () => {
    assert.equal(isAdditiveEdit({ fileStats: { 'src/app/page.tsx': { deletions: 0 } } }, 'src/app/page.tsx'), false);
  });
});

test('PR supervisor — rollupCheckState fails toward red, never toward green', async (t) => {
  const run = (conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion });

  await t.test('no checks at all is PENDING, not green', () => {
    assert.equal(rollupCheckState([]), 'PENDING');
    assert.equal(rollupCheckState(null), 'PENDING');
    assert.equal(rollupCheckState(undefined), 'PENDING');
  });

  await t.test('SKIPPED and NEUTRAL are green — this repo reports non-applicable jobs that way', () => {
    assert.equal(rollupCheckState([run('SUCCESS'), run('SKIPPED'), run('NEUTRAL')]), 'SUCCESS');
  });

  await t.test('one FAILURE among many successes is FAILURE', () => {
    assert.equal(rollupCheckState([run('SUCCESS'), run('FAILURE'), run('SUCCESS')]), 'FAILURE');
  });

  await t.test('an in-flight check is PENDING even if everything finished green', () => {
    assert.equal(rollupCheckState([run('SUCCESS'), run(null, 'IN_PROGRESS')]), 'PENDING');
  });

  await t.test('an UNRECOGNISED conclusion is a failure, not silently ignored', () => {
    assert.equal(rollupCheckState([run('SUCCESS'), run('TIMED_OUT')]), 'FAILURE');
    assert.equal(rollupCheckState([run('SUCCESS'), run('ACTION_REQUIRED')]), 'FAILURE');
    assert.equal(rollupCheckState([run('SUCCESS'), run('CANCELLED')]), 'FAILURE');
  });

  await t.test('StatusContext entries (state, no conclusion) are handled', () => {
    assert.equal(rollupCheckState([{ __typename: 'StatusContext', state: 'SUCCESS' }]), 'SUCCESS');
    assert.equal(rollupCheckState([{ __typename: 'StatusContext', state: 'FAILURE' }]), 'FAILURE');
    assert.equal(rollupCheckState([{ __typename: 'StatusContext', state: 'PENDING' }]), 'PENDING');
  });

  await t.test('a malformed entry is a failure, not a skip', () => {
    assert.equal(rollupCheckState([run('SUCCESS'), null]), 'FAILURE');
    assert.equal(rollupCheckState(['nope']), 'FAILURE');
  });

  await t.test('feeds straight into a hold', () => {
    const pr = { ...additive(PR594), checksState: rollupCheckState([run('FAILURE')]) };
    assert.equal(only(assessPullRequests([pr], { allOpenPrs: [] }), 594).verdict, 'hold');
  });
});

test('PR supervisor — every verdict carries the facts it rests on', async (t) => {
  await t.test('the full file list travels with the verdict', () => {
    // An independent grader's objection: a "mixed diff" claim is unverifiable
    // unless the file list that produced it is in the same record.
    const r = only(assessPullRequests([green(PR592, { evidence: pass(PR592.headSha) })], { allOpenPrs: ALL_OPEN }), 592);
    assert.deepEqual(r.files, PR592.files);
    // and the refused subset must actually be a subset of it
    for (const f of r.refused) assert.ok(r.files.includes(f), `${f} refused but not in the diff`);
  });

  await t.test('collision findings name files that both PRs actually touch', () => {
    const rows = assessPullRequests([green(PR593), green(PR591)], { allOpenPrs: ALL_OPEN });
    for (const c of only(rows, 593).collidesWith) {
      const other = ALL_OPEN.find((p) => p.number === c.number);
      for (const f of c.files) {
        assert.ok(PR593.files.includes(f) && other.files.includes(f),
          `${f} claimed as shared but not present in both diffs`);
      }
    }
  });
});

test('PR supervisor — the digest names the reason that DROVE the verdict', async (t) => {
  await t.test('a draft that also escalates does not headline "draft"', () => {
    // Found by running the tool against all 22 live PRs: #597 is a draft AND a
    // mixed diff. It escalated, but the digest printed reasons[0] — "draft" — so
    // the owner saw a hold-level reason presented as the decision they must make.
    const pr = green(PR592, { isDraft: true, evidence: pass(PR592.headSha) });
    const r = only(assessPullRequests([pr], { allOpenPrs: ALL_OPEN }), 592);
    assert.equal(r.verdict, 'escalate');
    assert.ok(r.reasons.some((x) => /draft/.test(x)), 'draft is still reported');
    assert.ok(!r.decidingReasons.some((x) => /^draft$/.test(x)),
      'but draft is not a DECIDING reason — it only raised a hold');
    assert.ok(r.decidingReasons.every((x) => /mixed diff|same file/.test(x)));

    const text = renderSupervisorDigest([r], { dryRun: true });
    assert.ok(!/#592 — draft/.test(text), 'the digest line must not headline the hold-level reason');
    assert.match(text, /#592 — mixed diff/);
  });

  await t.test('decidingReasons is always a non-empty subset of reasons', () => {
    const rows = assessPullRequests(
      [green(PR596, { evidence: pass(PR596.headSha) }), green(PR594),
        green(PR593, { evidence: pass(PR593.headSha) }), green(PR592, { evidence: pass(PR592.headSha) })],
      { allOpenPrs: ALL_OPEN },
    );
    for (const r of rows) {
      for (const d of r.decidingReasons) assert.ok(r.reasons.includes(d));
      if (r.verdict !== 'merge') assert.ok(r.decidingReasons.length >= 1, `#${r.number} has no deciding reason`);
    }
  });
});

// ── buildStatusPayload — the owner-facing sentence ────────────────────────────
//
// This is the deliverable of Loop 5 to a person who reads no PRs and no code. If
// the sentence is wrong or missing he simply never learns that finished work is
// piling up, which is the exact failure the loop exists to close — so it is
// tested as carefully as the merge decision itself.

const NOW = '2026-08-18T01:00:00.000Z';
const NOW_MS_FOR_SCOPE = Date.parse(NOW);

test('buildStatusPayload: says plainly what is waiting to merge and what needs a decision', () => {
  const payload = buildStatusPayload([
    { number: 594, title: 'docs', verdict: 'merge', headSha: 'aaa', decidingReasons: [] },
    { number: 596, title: 'client', verdict: 'escalate', headSha: 'bbb', decidingReasons: ['mixed diff'] },
    { number: 592, title: 'runner', verdict: 'escalate', headSha: 'ccc', decidingReasons: ['mixed diff'] },
  ], NOW);

  assert.equal(payload.at, NOW);
  assert.equal(payload.total, 3);
  assert.match(payload.alarm, /1 finished agent PR is green and waiting to be merged \(#594\)/);
  assert.match(payload.alarm, /2 need a decision nobody can make automatically \(#596, #592\)/);
  // No jargon a non-technical reader would have to decode.
  assert.ok(!/verdict|escalate|deterministic/i.test(payload.alarm),
    'the owner-facing line must not leak the supervisor\'s internal vocabulary');
});

test('buildStatusPayload: alarm is NULL when there is genuinely nothing open, never an empty string', () => {
  // The digest renders a row only when there is something to say; '' would print
  // an empty warning banner, which trains the reader to ignore the section.
  const payload = buildStatusPayload([], NOW);
  assert.equal(payload.alarm, null);
  assert.equal(payload.total, 0);
});

test('buildStatusPayload: a PR parked at hold or refuse REACHES the owner', () => {
  // The first version counted only merge and escalate. An adversarial review found
  // a live day where 5 PRs were verdicted "should be closed" and 3 were waiting on
  // CI, and the alarm was silent. A PR parked at hold forever is verbatim the
  // Loop 5 failure this whole mechanism exists to end, so silence is the bug.
  const payload = buildStatusPayload([
    { number: 1, verdict: 'hold', decidingReasons: ['CI pending'] },
    { number: 2, verdict: 'refuse', decidingReasons: ['every file forbidden'] },
  ], NOW);
  assert.match(payload.alarm, /should be closed rather than merged/);
  assert.match(payload.alarm, /#2/);
  assert.match(payload.alarm, /waiting on checks or a review/);
  assert.match(payload.alarm, /#1/);
});

test('buildStatusPayload: a scoped (--pr) run is marked, so a partial look cannot read as the whole board', () => {
  const full = buildStatusPayload([{ number: 1, verdict: 'merge' }], NOW);
  assert.equal(full.scoped, false);
  const part = buildStatusPayload([{ number: 1, verdict: 'merge' }], NOW, { scoped: true });
  assert.equal(part.scoped, true);
});

test('assessSupervisorStatus: a quiet SCOPED run reports unknown, not "all clear"', () => {
  // A partial run that found nothing proves nothing about the PRs it skipped.
  const quietScoped = buildStatusPayload([], new Date(NOW_MS_FOR_SCOPE - 60_000).toISOString(), { scoped: true });
  assert.deepEqual(assessSupervisorStatus(quietScoped, NOW_MS_FOR_SCOPE), { status: 'unknown', message: null });
});

test('assessSupervisorStatus: a scoped run with findings says so in the line', () => {
  const scoped = buildStatusPayload(
    [{ number: 594, verdict: 'merge' }],
    new Date(NOW_MS_FOR_SCOPE - 60_000).toISOString(),
    { scoped: true }
  );
  const v = assessSupervisorStatus(scoped, NOW_MS_FOR_SCOPE);
  assert.equal(v.status, 'warn');
  assert.match(v.message, /partial check/);
});

test('assessSupervisorStatus: a FUTURE-dated file is an error, not treated as fresh forever', () => {
  const future = buildStatusPayload([{ number: 1, verdict: 'merge' }],
    new Date(NOW_MS_FOR_SCOPE + 48 * 3600 * 1000).toISOString());
  const v = assessSupervisorStatus(future, NOW_MS_FOR_SCOPE);
  assert.equal(v.status, 'error');
  assert.match(v.message, /future/);
});

test('assessSupervisorStatus: a non-string alarm is an error, not "[object Object]"', () => {
  const v = assessSupervisorStatus({ at: new Date(NOW_MS_FOR_SCOPE).toISOString(), alarm: { oops: true } }, NOW_MS_FOR_SCOPE);
  assert.equal(v.status, 'error');
  assert.ok(!/\[object Object\]/.test(v.message), 'must not leak a stringified object into the owner email');
});

test('listPrs/phrase: rows with no usable id drop the parenthetical instead of printing "()"', () => {
  const payload = buildStatusPayload([{ verdict: 'merge' }], NOW);
  assert.ok(!/\(\)/.test(payload.alarm), `empty parenthetical leaked: ${payload.alarm}`);
  assert.match(payload.alarm, /1 finished agent PR is green/);
});

test('buildStatusPayload: no open PRs is quiet, not an alarm', () => {
  const payload = buildStatusPayload([], NOW);
  assert.equal(payload.alarm, null);
  assert.equal(payload.total, 0);
  assert.deepEqual(payload.verdicts, []);
});

test('buildStatusPayload: singular/plural read correctly in both halves', () => {
  const one = buildStatusPayload([{ number: 7, verdict: 'escalate', decidingReasons: ['x'] }], NOW);
  assert.match(one.alarm, /1 needs a decision/);
  const many = buildStatusPayload([
    { number: 7, verdict: 'merge', decidingReasons: [] },
    { number: 8, verdict: 'merge', decidingReasons: [] },
  ], NOW);
  assert.match(many.alarm, /2 finished agent PRs are green/);
});

test('buildStatusPayload: carries the SHA each verdict was decided against', () => {
  // Evidence in this system is SHA-bound; a payload that dropped the sha would let
  // a stale verdict be read as covering a newer push.
  const payload = buildStatusPayload([
    { number: 596, title: 't', verdict: 'escalate', headSha: 'f941450917113ee', decidingReasons: ['mixed diff'] },
  ], NOW);
  assert.equal(payload.verdicts[0].headSha, 'f941450917113ee');
  assert.deepEqual(payload.verdicts[0].decidingReasons, ['mixed diff']);
});

test('buildStatusPayload: tolerates a verdict row missing optional fields', () => {
  const payload = buildStatusPayload([{ number: 3, verdict: 'merge' }], NOW);
  assert.equal(payload.verdicts[0].title, null);
  assert.equal(payload.verdicts[0].headSha, null);
  assert.deepEqual(payload.verdicts[0].decidingReasons, []);
});

// ── malformed input (adversarial review, 2026-08-17) ─────────────────────────
//
// The first version of these tests only walked the happy path, so a bug in
// verdict mapping could silently drop every actionable row and the "alarm is
// null when quiet" test would still pass. These cover the shapes that produce a
// WRONG owner-facing sentence rather than an obviously broken one.

test('buildStatusPayload: an UNRECOGNISED verdict is surfaced, never silently dropped', () => {
  // A new verdict added to the core without updating this function must not
  // vanish from the only line a human reads while still looking handled in JSON.
  const payload = buildStatusPayload([
    { number: 10, verdict: 'quarantine', decidingReasons: ['new state'] },
  ], NOW);
  assert.match(payload.alarm, /unrecognised verdict/);
  assert.match(payload.alarm, /#10/);
  assert.equal(payload.total, 1);
});

test('buildStatusPayload: a row with no PR number never renders as "#undefined"', () => {
  const payload = buildStatusPayload([
    { verdict: 'merge', decidingReasons: [] },
    { number: 12, verdict: 'merge', decidingReasons: [] },
  ], NOW);
  assert.ok(!/#undefined|#null|#NaN/.test(payload.alarm), `leaked a bad id: ${payload.alarm}`);
  assert.match(payload.alarm, /#12/);
  assert.equal(payload.verdicts[0].number, null, 'the unusable id is normalised to null in the payload');
});

test('buildStatusPayload: a long list is truncated so the digest line stays readable', () => {
  const many = Array.from({ length: MAX_LISTED_PRS + 4 }, (_, i) => ({
    number: 100 + i, verdict: 'escalate', decidingReasons: ['x'],
  }));
  const payload = buildStatusPayload(many, NOW);
  assert.match(payload.alarm, new RegExp(`${MAX_LISTED_PRS + 4} need`));
  assert.match(payload.alarm, /and 4 more/);
  assert.equal((payload.alarm.match(/#\d+/g) || []).length, MAX_LISTED_PRS);
});

test('buildStatusPayload: null and undefined rows are ignored rather than crashing', () => {
  const payload = buildStatusPayload([null, undefined, { number: 5, verdict: 'merge' }], NOW);
  assert.equal(payload.total, 1);
  assert.match(payload.alarm, /#5/);
});

// ── assessSupervisorStatus — the reader half ─────────────────────────────────
//
// Without this, `at` is written and never read, and a week-old "green and
// waiting" line renders as current forever.

const NOW_MS = Date.parse(NOW);

test('assessSupervisorStatus: absent status file is unknown, never an alarm', () => {
  assert.deepEqual(assessSupervisorStatus(null, NOW_MS), { status: 'unknown', message: null });
  assert.deepEqual(assessSupervisorStatus(undefined, NOW_MS), { status: 'unknown', message: null });
});

test('assessSupervisorStatus: a STALE payload is an error, not its own cheerful contents', () => {
  const stale = buildStatusPayload(
    [{ number: 594, verdict: 'merge', decidingReasons: [] }],
    new Date(NOW_MS - STATUS_STALE_AFTER_MS - 60_000).toISOString()
  );
  const v = assessSupervisorStatus(stale, NOW_MS);
  assert.equal(v.status, 'error');
  assert.match(v.message, /not current/);
  // The stale contents must NOT be presented as the current situation.
  assert.ok(!/waiting to be merged/.test(v.message),
    'a stale payload must not render its own contents as though they were current');
});

test('assessSupervisorStatus: a fresh payload with work waiting warns, in plain English', () => {
  const fresh = buildStatusPayload(
    [{ number: 594, verdict: 'merge', decidingReasons: [] }],
    new Date(NOW_MS - 60_000).toISOString()
  );
  const v = assessSupervisorStatus(fresh, NOW_MS);
  assert.equal(v.status, 'warn');
  assert.match(v.message, /green and waiting to be merged \(#594\)/);
  assert.ok(!/verdict|escalate|deterministic/i.test(v.message),
    'the digest line must not leak internal vocabulary to a non-technical reader');
});

test('assessSupervisorStatus: a fresh, quiet payload renders nothing at all', () => {
  const quiet = buildStatusPayload([], new Date(NOW_MS - 60_000).toISOString());
  assert.deepEqual(assessSupervisorStatus(quiet, NOW_MS), { status: 'ok', message: null });
});

test('assessSupervisorStatus: an unparseable timestamp is an error, not treated as fresh', () => {
  const v = assessSupervisorStatus({ at: 'not-a-date', alarm: 'something urgent' }, NOW_MS);
  assert.equal(v.status, 'error');
  assert.match(v.message, /unreadable/);
});
