/**
 * done-evidence-audit.test.mjs — BRO-3426's daily evidence re-verification
 * sweep.
 *
 * Every test require()s the REAL functions (CLAUDE.md rule 15) — no logic is
 * restated here, so a change to the production classifier fails this file.
 * That matters more than usual for this card: the thing being built is a
 * detector of false completion claims, and a test that carried its own copy of
 * the rules would keep passing while the detector drifted, which is the exact
 * self-certification failure the card was filed about.
 *
 * The verdict expectations below are pinned to a real measurement, not taste.
 * Hand-run of 75 live cards against a fresh origin/main, 2026-09-15:
 *   Done 23 pass / 2 fail · In Review 14 pass / 11 fail · In Progress 8 pass / 17 fail
 * All 28 open-card failures were "the test file this card is going to write
 * does not exist yet". Hence the asymmetry these tests lock in: an open card's
 * FAIL is not a defect, a Done card's FAIL is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VERDICTS,
  EVIDENCE,
  evaluatePrEvidence,
  evaluateVerifyRun,
  combineEvidence,
  classifyCard,
  summarize,
  doneTally,
  buildDigestSnapshot,
  isNonProbativeCommand,
  isEnvironmentFailure,
  tidyDetail,
  scrubSandboxPaths,
  adjudicateMisArmed,
  MIS_ARMED,
} = require('../../scripts/lib/done-evidence-audit.js');
const {
  cleanUrl,
  parseEvidenceUrl,
  commitIsOnMain,
  pullIsOnMain,
  resolveEvidenceUrl,
  pathPredatesCard,
} = require('../../scripts/lib/done-evidence-remote.js');
const {
  mapIssueToCard,
  selectCandidates,
  buildCandidatesQuery,
  fetchDoneEvidenceCandidates,
  CANDIDATE_STATES,
} = require('../../scripts/lib/done-evidence-source.js');

const doneCard = (over = {}) => ({ id: 'BRO-1', name: 'a done card', url: 'https://linear.app/x/BRO-1', state: 'Done', ...over });
const openCard = (over = {}) => ({ id: 'BRO-2', name: 'an open card', url: 'https://linear.app/x/BRO-2', state: 'In Progress', ...over });
const PASS = { status: 'pass', detail: null };
const FAIL = { status: 'fail', detail: "Could not find 'tests/unit/x.test.mjs'" };
const CANNOT = { status: 'unverifiable', detail: 'checkout has no node_modules' };

// ── the four classification branches BRO-3426 names ────────────────────────

test('Done + its own check passes on main -> VERIFIED', () => {
  const r = classifyCard({ card: doneCard(), cmd: 'node --test tests/unit/x.test.mjs', runResult: PASS });
  assert.equal(r.verdict, VERDICTS.VERIFIED);
  assert.equal(r.evidence, EVIDENCE.HOLDS);
  assert.deepEqual(r.channels, ['verify-command']);
});

test('Done + its own check FAILS on main -> FAILED (the claim the board makes is false)', () => {
  const r = classifyCard({ card: doneCard(), cmd: 'node --test tests/unit/x.test.mjs', runResult: FAIL });
  assert.equal(r.verdict, VERDICTS.FAILED);
  assert.match(r.detail, /Could not find/);
});

test('In Progress/In Review + its own check PASSES -> STUCK, never flipped (shadow mode)', () => {
  for (const state of ['In Progress', 'In Review']) {
    const r = classifyCard({ card: openCard({ state }), cmd: 'node --test tests/unit/x.test.mjs', runResult: PASS });
    assert.equal(r.verdict, VERDICTS.STUCK, state);
    assert.match(r.detail, /looks finished/);
  }
});

test('no PR-EVIDENCE and no runnable command -> UNVERIFIABLE, not an accusation', () => {
  const r = classifyCard({ card: doneCard() });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.equal(r.evidence, EVIDENCE.UNKNOWN);
});

// ── the asymmetry: the single most load-bearing rule in the classifier ─────

test('an OPEN card whose check fails is NOT reported as a defect — 28 of 28 such live failures were just unwritten test files', () => {
  const r = classifyCard({ card: openCard(), cmd: 'node --test tests/unit/not-written-yet.test.mjs', runResult: FAIL });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.FAILED);
  assert.match(r.detail, /expected for unfinished work/);
});

test('the SAME failing command on a Done card IS a defect — the polarity is what the state decides', () => {
  const cmd = 'node --test tests/unit/not-written-yet.test.mjs';
  assert.equal(classifyCard({ card: openCard(), cmd, runResult: FAIL }).verdict, VERDICTS.UNVERIFIABLE);
  assert.equal(classifyCard({ card: doneCard(), cmd, runResult: FAIL }).verdict, VERDICTS.FAILED);
});

// ── vacuous checks (BRO-3378 detector, refined) ────────────────────────────

const VACUOUS = { kind: 'test-f-satisfied', polarity: 'never-fails', paths: ['scripts/lib/old.js'], reason: 'already passes on origin/main' };

test('a vacuous check outranks its own PASS — a check that cannot fail proves nothing (the BRO-423 shape)', () => {
  const r = classifyCard({ card: doneCard(), cmd: 'test -f scripts/lib/old.js', runResult: PASS, vacuous: VACUOUS });
  assert.equal(r.verdict, VERDICTS.VACUOUS);
  assert.notEqual(r.verdict, VERDICTS.VERIFIED);
});

test('a vacuous check on an OPEN card is still VACUOUS, not silently dropped like an open FAIL', () => {
  const r = classifyCard({ card: openCard(), cmd: 'test -f scripts/lib/old.js', runResult: PASS, vacuous: VACUOUS });
  assert.equal(r.verdict, VERDICTS.VACUOUS);
});

test('an independent PR-EVIDENCE proof outranks a vacuous command — that channel is untainted by the weak check', () => {
  const r = classifyCard({
    card: doneCard(),
    prRef: { merged: true, deployed: true, checked: true, url: 'https://github.com/thomaspryor/Broadwayscore/commit/abc1234' },
    ancestry: EVIDENCE.HOLDS,
    cmd: 'test -f scripts/lib/old.js',
    vacuous: VACUOUS,
  });
  assert.equal(r.verdict, VERDICTS.VERIFIED);
});

// ── fail-open: an unresolved probe must never accuse ───────────────────────

test('runVerify "unverifiable" (no node_modules / exit 3) is UNKNOWN, never a FAILED verdict', () => {
  const r = classifyCard({ card: doneCard(), cmd: 'node --test tests/unit/x.test.mjs', runResult: CANNOT });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.FAILED);
});

test('a command that was not re-run this sweep is reported, not dropped', () => {
  const r = classifyCard({ card: doneCard(), cmd: 'node --test tests/unit/x.test.mjs', runResult: null });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.match(r.detail, /not re-run/);
});

test('a PR-EVIDENCE line with no URL is UNKNOWN — there was never anything to re-prove', () => {
  const e = evaluatePrEvidence({ merged: true, deployed: true, checked: true, url: null }, null);
  assert.equal(e.state, EVIDENCE.UNKNOWN);
  assert.equal(classifyCard({ card: doneCard(), prRef: { merged: true, url: null } }).verdict, VERDICTS.UNVERIFIABLE);
});

test('unresolvable ancestry is UNKNOWN, never BROKEN — landing-verify.js s tri-state, for the same reason', () => {
  assert.equal(evaluatePrEvidence({ url: 'https://github.com/thomaspryor/Broadwayscore/commit/abc1234' }, EVIDENCE.UNKNOWN).state, EVIDENCE.UNKNOWN);
  assert.equal(evaluatePrEvidence({ url: 'https://github.com/thomaspryor/Broadwayscore/commit/abc1234' }, EVIDENCE.BROKEN).state, EVIDENCE.BROKEN);
});

test('a broken PR-EVIDENCE url never overrides a passing check — a typo must not accuse working code', () => {
  const r = classifyCard({
    card: doneCard(),
    prRef: { merged: true, url: 'https://github.com/thomaspryor/Broadwayscore/commit/deadbee' },
    ancestry: EVIDENCE.BROKEN,
    cmd: 'node --test tests/unit/x.test.mjs',
    runResult: PASS,
  });
  assert.equal(r.verdict, VERDICTS.VERIFIED);
  assert.deepEqual(combineEvidence({ state: EVIDENCE.BROKEN, detail: 'x' }, { state: EVIDENCE.HOLDS, detail: null }).state, EVIDENCE.HOLDS);
});

test('evaluateVerifyRun: no command at all is UNKNOWN, not a pass', () => {
  assert.equal(evaluateVerifyRun(PASS, null).state, EVIDENCE.UNKNOWN);
});

// ── the two defects the first live sweep exposed (2026-09-15, 371 cards) ──

test('a repo-wide tsc/lint check is never proof: it is green on main for every card at once', () => {
  for (const cmd of ['npx tsc --noEmit', 'npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json', 'npx next lint']) {
    assert.equal(isNonProbativeCommand(cmd), true, cmd);
    // Would otherwise have produced 6 false VERIFIED and 10 false STUCK.
    assert.equal(classifyCard({ card: doneCard(), cmd, runResult: PASS }).verdict, VERDICTS.UNVERIFIABLE, cmd);
    assert.equal(classifyCard({ card: openCard(), cmd, runResult: PASS }).verdict, VERDICTS.UNVERIFIABLE, cmd);
  }
  assert.match(classifyCard({ card: doneCard(), cmd: 'npx tsc --noEmit' }).detail, /green on main for every card/);
});

test('a card-specific check is still proof — the non-probative rule must not swallow real commands', () => {
  for (const cmd of ['node --test tests/unit/x.test.mjs', 'test -f docs/x.md', 'node scripts/audit-thing.js', 'npx tsx --test tests/unit/y.test.ts']) {
    assert.equal(isNonProbativeCommand(cmd), false, cmd);
  }
  assert.equal(classifyCard({ card: doneCard(), cmd: 'node --test tests/unit/x.test.mjs', runResult: PASS }).verdict, VERDICTS.VERIFIED);
});

test('a failure caused by the missing PRIVATE review corpus is never a FAILED verdict', () => {
  // Verbatim from the first live sweep, which accused BRO-2200/2050/2044 —
  // three finished P0 fixes — of being broken purely because the sandboxed
  // checkout has no data/review-texts (a separate private repo).
  const detail = '\nFAIL: scanned 0 review files — data/review-texts is missing or empty. The gate cannot pass vacuously.';
  assert.equal(isEnvironmentFailure(detail), true);
  const r = classifyCard({ card: doneCard(), cmd: 'node scripts/audit-flagged-file-contamination.js', runResult: { status: 'fail', detail } });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.FAILED);
  assert.match(r.detail, /private review-texts corpus/);
});

test('a check cut short by this sweep s own time cap is never FAILED — observed live on BRO-258', () => {
  for (const detail of ['spawnSync node ETIMEDOUT', 'check killed by SIGTERM after 60000ms (timeout — no verdict)']) {
    assert.equal(isEnvironmentFailure(detail), true, detail);
    const r = classifyCard({ card: doneCard(), cmd: 'node scripts/slow-audit.js', runResult: { status: 'fail', detail } });
    assert.equal(r.verdict, VERDICTS.UNVERIFIABLE, detail);
    assert.match(r.detail, /time limit|cut short/);
  }
});

test('an ordinary assertion failure that merely mentions a filename is still a real FAILED', () => {
  assert.equal(isEnvironmentFailure("Could not find 'tests/unit/x.test.mjs'"), false);
  assert.equal(isEnvironmentFailure('expected 3 review files, got 2'), false);
  assert.equal(isEnvironmentFailure(''), false);
  assert.equal(isEnvironmentFailure(null), false);
  assert.equal(classifyCard({ card: doneCard(), cmd: 'node --test a.mjs', runResult: FAIL }).verdict, VERDICTS.FAILED);
});

test('digest details are one line and clipped — a raw stack trace with a /private/var temp path shipped in the first sweep', () => {
  const stack = "node:internal/modules/cjs/loader:1478\n  throw err;\n  ^\n\nError: Cannot find module '/private/var/folders/__/n5f8n1yj2wnch4lpmz1138840000gn/T/done-evidence-rEYhSm/main/scripts/audit-worktree-unpushed.js'\n    at Module._resolveFilename";
  const tidy = tidyDetail(stack);
  assert.ok(!tidy.includes('\n'), 'must be a single line');
  assert.ok(tidy.length <= 180, `must be clipped, got ${tidy.length}`);
  const snap = buildDigestSnapshot({ generatedAt: 'x', results: [classifyCard({ card: doneCard(), cmd: 'node --test a.mjs', runResult: { status: 'fail', detail: stack } })] });
  assert.ok(!snap.items[0].detail.includes('\n'));
  assert.equal(tidyDetail(null), null);
  assert.equal(tidyDetail('   '), null);
});

test('the disposable checkout path is scrubbed — the report is committed nightly and must not diff on a random temp dir', () => {
  const raw = "Error: Cannot find module '/private/var/folders/__/n5f8n1yj2wnch4lpmz1138840000gn/T/done-evidence-9HYDGn/main/scripts/audit-worktree-unpushed.js'";
  const scrubbed = scrubSandboxPaths(raw);
  assert.ok(!scrubbed.includes('done-evidence-9HYDGn'), 'the random component must be gone');
  assert.ok(scrubbed.includes('<checkout>/scripts/audit-worktree-unpushed.js'), 'the repo-relative path must survive');
  // Two runs of the same failure must produce byte-identical report text, or
  // the committed JSON diffs every night for no reason.
  const runA = scrubSandboxPaths(raw);
  const runB = scrubSandboxPaths(raw.replace('done-evidence-9HYDGn', 'done-evidence-rEYhSm'));
  assert.equal(runA, runB);
  // The sibling runners' prefixes are covered too — they share the helper.
  assert.ok(!scrubSandboxPaths('/tmp/acceptance-check-abc123/main/x.js').includes('abc123'));
  assert.equal(scrubSandboxPaths(null), '');
});

test('a scrubbed path reaches the verdict detail, not just the digest', () => {
  const detail = "Error: Cannot find module '/private/var/folders/x/T/done-evidence-AbC123/main/scripts/x.js'";
  const r = classifyCard({ card: doneCard(), cmd: 'node scripts/x.js', runResult: { status: 'fail', detail } });
  assert.equal(r.verdict, VERDICTS.FAILED);
  assert.ok(!r.detail.includes('done-evidence-AbC123'));
  assert.ok(r.detail.includes('<checkout>/scripts/x.js'));
});

// ── the four defects the adversarial pre-ship review caught ───────────────

test('REVERTED work is FAILED, not VERIFIED: a revert preserves ancestry, so the command must win', () => {
  // `git revert` leaves the original commit reachable from main forever, so the
  // compare API keeps answering "behind" long after the change was undone. An
  // earlier version returned VERIFIED here — laundering the exact regression
  // this sweep exists to catch.
  const r = classifyCard({
    card: doneCard(),
    prRef: { merged: true, url: 'https://github.com/thomaspryor/Broadwayscore/commit/abc1234' },
    ancestry: EVIDENCE.HOLDS,
    cmd: 'node --test tests/unit/x.test.mjs',
    runResult: FAIL,
  });
  assert.equal(r.verdict, VERDICTS.FAILED);
  assert.deepEqual(r.channels, ['verify-command']);
});

test('...but the asymmetry does not invert: a broken ancestry still loses to a passing command', () => {
  const r = classifyCard({
    card: doneCard(),
    prRef: { merged: true, url: 'https://github.com/thomaspryor/Broadwayscore/commit/deadbee' },
    ancestry: EVIDENCE.BROKEN,
    cmd: 'node --test tests/unit/x.test.mjs',
    runResult: PASS,
  });
  assert.equal(r.verdict, VERDICTS.VERIFIED, 'a typo in a hand-typed URL must not accuse working code');
});

test('an unresolvable path-age is UNVERIFIABLE, never VERIFIED — an outage must not upgrade the weakest evidence', () => {
  const unresolved = { ...VACUOUS, unresolvedAge: true, reason: 'could not be resolved this run' };
  const r = classifyCard({ card: doneCard(), cmd: 'test -f scripts/lib/old.js', runResult: PASS, vacuous: unresolved });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.VERIFIED);
  // A RESOLVED vacuous verdict still reports as VACUOUS — the two must stay distinguishable.
  assert.equal(classifyCard({ card: doneCard(), cmd: 'test -f scripts/lib/old.js', runResult: PASS, vacuous: VACUOUS }).verdict, VERDICTS.VACUOUS);
});

test('a partial run SAYS SO in the banner — an incomplete inventory must never read as a clean board', () => {
  const clean = buildDigestSnapshot(REPORT);
  assert.ok(!clean.bannerText.includes('PARTIAL RUN'), 'a complete run must not cry wolf');

  for (const [field, value, expected] of [
    ['truncated', true, /listing was cut short/],
    ['fetchError', 'linear 500', /fetch failed partway/],
    ['notReRun', 12, /12 checks not re-run/],
    ['unresolvedProbes', 3, /3 GitHub lookups failed/],
  ]) {
    const snap = buildDigestSnapshot({ ...REPORT, [field]: value });
    assert.match(snap.bannerText, /PARTIAL RUN/, field);
    assert.match(snap.bannerText, expected, field);
    assert.match(snap.bannerText, /understate the board/, field);
  }
});

test('a foreign-repo PR url is never resolved against our own repo — PR numbers collide across repos', () => {
  const foreign = 'https://github.com/someone/other-repo/pull/827';
  assert.equal(parseEvidenceUrl(foreign).kind, 'other');
  assert.equal(parseEvidenceUrl(foreign).foreignRepo, 'someone/other-repo');
  // Must not make ANY api call for a foreign url.
  assert.equal(resolveEvidenceUrl(foreign, { runGh: () => { throw new Error('must not be called'); } }), 'unknown');
  // Our own repo still resolves normally.
  assert.equal(parseEvidenceUrl('https://github.com/thomaspryor/Broadwayscore/pull/827').kind, 'pull');
});

test('a MIS-ARMED card is not accused: a check naming a path that never existed is UNVERIFIABLE, not FAILED', () => {
  // The live P0. BRO-2304 is armed `test -f scripts/push-with-retry.sh`; the
  // real file is scripts/lib/push-with-retry.sh and always was, so the command
  // could never have passed on any day. BRO-2421 is the same shape. Both were
  // reported FAILED in the first live run — accusing finished work.
  const r = classifyCard({
    card: doneCard({ id: 'BRO-2304' }),
    cmd: 'test -f scripts/push-with-retry.sh',
    runResult: { status: 'fail', detail: 'Command failed: test -f scripts/push-with-retry.sh' },
    misArmed: { path: 'scripts/push-with-retry.sh' },
  });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.FAILED);
  assert.match(r.detail, /never existed/);
  // A path that DID exist and is now gone is still a real regression.
  assert.equal(classifyCard({ card: doneCard(), cmd: 'node --test a.mjs', runResult: FAIL, misArmed: null }).verdict, VERDICTS.FAILED);
});

test('refineVacuous: the Done-card createdAt refinement, end to end', () => {
  const runner = require('../../scripts/audit-done-evidence.js');
  const { refineVacuous } = runner;
  const exists = () => true; // the path is on main
  const done = { id: 'BRO-1', state: 'Done', createdAt: '2026-09-01T00:00:00Z' };
  const open = { id: 'BRO-2', state: 'In Progress', createdAt: '2026-09-01T00:00:00Z' };
  const cmd = 'test -f scripts/lib/thing.js';

  // OPEN card: work unfinished + check already green = vacuous, no date needed.
  const o = refineVacuous(open, cmd, exists, { remoteOpts: { runGh: () => { throw new Error('no call needed'); } } });
  assert.equal(o.kind, 'test-f-satisfied');
  assert.ok(!o.unresolvedAge);

  // DONE card whose work CREATED the file (no commit before it was filed) -> legitimate.
  assert.equal(refineVacuous(done, cmd, exists, { remoteOpts: { runGh: () => '0' } }), null);

  // DONE card whose path predates the card -> genuinely vacuous.
  const v = refineVacuous(done, cmd, exists, { remoteOpts: { runGh: () => '1' } });
  assert.match(v.reason, /already in the repo before this card was filed/);
  assert.ok(!v.unresolvedAge);

  // DONE card whose path age could NOT be resolved -> unresolved, never verified.
  const u = refineVacuous(done, cmd, exists, { remoteOpts: { runGh: () => null } });
  assert.equal(u.unresolvedAge, true);
  assert.equal(classifyCard({ card: doneCard(), cmd, runResult: PASS, vacuous: u }).verdict, VERDICTS.UNVERIFIABLE);

  // A non-`test -f` command is never in scope at all.
  assert.equal(refineVacuous(done, 'node --test a.mjs', exists, {}), null);
});

test('pathNeverExisted distinguishes "wrong path" from "deleted path", and fails open', () => {
  const { pathNeverExisted } = require('../../scripts/lib/done-evidence-remote.js');
  assert.equal(pathNeverExisted('scripts/typo.sh', { runGh: () => '0' }), true, 'no commit ever = mis-armed');
  assert.equal(pathNeverExisted('scripts/real.sh', { runGh: () => '1' }), false, 'had commits = genuinely removed');
  assert.equal(pathNeverExisted('scripts/x.sh', { runGh: () => null }), null, 'unresolved is never a verdict');
  assert.equal(pathNeverExisted(null, { runGh: () => '0' }), null);
});

// ── remote evidence resolution ─────────────────────────────────────────────

test('cleanUrl strips the markdown trailing paren — 13 of 16 live PR-EVIDENCE urls end in ")"', () => {
  assert.equal(cleanUrl('https://github.com/thomaspryor/Broadwayscore/commit/abc1234)'), 'https://github.com/thomaspryor/Broadwayscore/commit/abc1234');
  assert.equal(parseEvidenceUrl('https://github.com/thomaspryor/Broadwayscore/commit/abc1234)').sha, 'abc1234');
  assert.equal(parseEvidenceUrl('https://github.com/thomaspryor/Broadwayscore/pull/827)').number, '827');
});

test('a non-git evidence url (a prod data JSON, like BRO-3247) resolves UNKNOWN, never BROKEN', () => {
  assert.equal(parseEvidenceUrl('https://broadwayscorecard.com/data/shows/x.json').kind, 'other');
  assert.equal(resolveEvidenceUrl('https://broadwayscorecard.com/data/shows/x.json', { runGh: () => { throw new Error('must not be called'); } }), 'unknown');
});

test('commitIsOnMain maps the compare API status: behind/identical = landed, ahead/diverged = not', () => {
  assert.equal(commitIsOnMain('abc', { runGh: () => 'behind' }), 'holds');
  assert.equal(commitIsOnMain('abc', { runGh: () => 'identical' }), 'holds');
  assert.equal(commitIsOnMain('abc', { runGh: () => 'ahead' }), 'broken');
  assert.equal(commitIsOnMain('abc', { runGh: () => 'diverged' }), 'broken');
});

test('a gh failure or an unrecognised status is UNKNOWN — rate limits must not accuse anyone', () => {
  assert.equal(commitIsOnMain('abc', { runGh: () => null }), 'unknown');
  assert.equal(commitIsOnMain('abc', { runGh: () => '' }), 'unknown');
  assert.equal(commitIsOnMain('abc', { runGh: () => 'something-new' }), 'unknown');
});

test('a merged PR still has its merge commit ancestry-checked — merged is not the same as on main', () => {
  const calls = [];
  const runGh = (args) => {
    calls.push(args.join(' '));
    if (args[1].includes('/pulls/')) return 'true\tmergesha1';
    return 'behind';
  };
  assert.equal(pullIsOnMain('827', { runGh }), 'holds');
  assert.equal(calls.length, 2, 'must make the second, ancestry call');
  assert.match(calls[1], /compare\/main\.\.\.mergesha1/);
});

test('an unmerged PR is BROKEN; an unreadable one is UNKNOWN', () => {
  assert.equal(pullIsOnMain('1', { runGh: () => 'false\t' }), 'broken');
  assert.equal(pullIsOnMain('1', { runGh: () => null }), 'unknown');
});

test('pathPredatesCard: a commit before the card = vacuous; none = the card created it; unreadable = null', () => {
  const at = '2026-09-01T00:00:00Z';
  assert.equal(pathPredatesCard('scripts/lib/x.js', at, { runGh: () => '1' }), true);
  assert.equal(pathPredatesCard('scripts/lib/x.js', at, { runGh: () => '0' }), false);
  assert.equal(pathPredatesCard('scripts/lib/x.js', at, { runGh: () => null }), null);
  assert.equal(pathPredatesCard('scripts/lib/x.js', 'not-a-date', { runGh: () => '1' }), null);
  assert.equal(pathPredatesCard(null, at, { runGh: () => '1' }), null);
});

// ── candidate source ───────────────────────────────────────────────────────

test('the query asks for exactly the three buckets BRO-3426 names, with comments', () => {
  const q = buildCandidatesQuery();
  for (const s of CANDIDATE_STATES) assert.ok(q.includes(`"${s}"`), `${s} must be in the filter`);
  assert.match(q, /comments\(first: 50/, 'PR-EVIDENCE and corrected VERIFY lines live in comments (BRO-2796)');
  assert.match(q, /createdAt/, 'createdAt is load-bearing for the vacuous refinement');
  assert.ok(!/orderBy:\s*updatedAt/.test(q), 'a mutable orderBy can skip/duplicate rows mid-pagination');
});

test('mapIssueToCard keeps the human identifier and the fields the sweep judges on', () => {
  const c = mapIssueToCard({
    identifier: 'BRO-9', title: 'T', url: 'u', description: 'd',
    createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z',
    state: { name: 'Done', type: 'completed' },
    comments: { nodes: [{ body: 'first', createdAt: '2026-01-02T00:00:00Z' }] },
  });
  assert.equal(c.id, 'BRO-9');
  assert.equal(c.state, 'Done');
  assert.equal(c.createdAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(c.comments, ['first']);
  assert.equal(mapIssueToCard(null), null);
  assert.equal(mapIssueToCard({ title: 'no identifier' }), null);
});

test('selectCandidates keeps every open card and cuts Done past the window', () => {
  const now = Date.parse('2026-09-15T00:00:00Z');
  const cards = [
    { id: 'A', state: 'Done', completedAt: '2026-09-14T00:00:00Z' },
    { id: 'B', state: 'Done', completedAt: '2026-08-01T00:00:00Z' },
    { id: 'C', state: 'In Progress', completedAt: null },
    { id: 'D', state: 'In Review', completedAt: null },
  ];
  assert.deepEqual(selectCandidates(cards, { now }).map((c) => c.id), ['A', 'C', 'D']);
});

test('a Done card with no completedAt is KEPT — dropping it would silently shrink the denominator', () => {
  const now = Date.parse('2026-09-15T00:00:00Z');
  assert.deepEqual(selectCandidates([{ id: 'A', state: 'Done', completedAt: null }], { now }).map((c) => c.id), ['A']);
});

test('fetchDoneEvidenceCandidates never throws, keeps earlier pages, and reports the failure', async () => {
  let call = 0;
  const client = {
    TEAM_KEY: 'BRO',
    graphql: async () => {
      call++;
      if (call === 1) {
        return { issues: { nodes: [{ identifier: 'BRO-1', title: 'a', state: { name: 'Done', type: 'completed' } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
      }
      throw new Error('linear is down');
    },
  };
  const r = await fetchDoneEvidenceCandidates(client, {});
  assert.equal(r.cards.length, 1, 'page 1 is real and kept');
  assert.equal(r.truncated, true);
  assert.match(r.error, /linear is down/, 'a real failure must not be swallowed into an empty array');
});

// ── report + digest shaping ────────────────────────────────────────────────

const REPORT = {
  generatedAt: '2026-09-15T06:00:00.000Z',
  results: [
    classifyCard({ card: doneCard({ id: 'BRO-10', name: 'ok' }), cmd: 'node --test a.mjs', runResult: PASS }),
    classifyCard({ card: doneCard({ id: 'BRO-11', name: 'broke' }), cmd: 'node --test b.mjs', runResult: FAIL }),
    classifyCard({ card: openCard({ id: 'BRO-12', name: 'finished really' }), cmd: 'node --test c.mjs', runResult: PASS }),
    classifyCard({ card: doneCard({ id: 'BRO-13', name: 'weak check' }), cmd: 'test -f old.js', runResult: PASS, vacuous: VACUOUS }),
    classifyCard({ card: doneCard({ id: 'BRO-14', name: 'no evidence' }) }),
  ],
};

test('summarize and doneTally count every verdict, including a quiet zero', () => {
  const c = summarize(REPORT.results);
  assert.deepEqual(c, { VERIFIED: 1, FAILED: 1, STUCK: 1, VACUOUS: 1, UNVERIFIABLE: 1, total: 5 });
  assert.deepEqual(doneTally(REPORT.results), { done: 4, verified: 1 });
  assert.deepEqual(summarize([]), { VERIFIED: 0, FAILED: 0, STUCK: 0, VACUOUS: 0, UNVERIFIABLE: 0, total: 0 });
});

test('the digest line reads the way BRO-3426 asked for it, and names the FAILED and STUCK cards', () => {
  const snap = buildDigestSnapshot(REPORT);
  assert.match(snap.bannerText, /1\/4 Done\(14d\) verified on main/);
  assert.match(snap.bannerText, /1 FAILED/);
  assert.match(snap.bannerText, /1 vacuous/);
  assert.match(snap.bannerText, /1 stuck-but-done/);
  const titles = snap.items.map((i) => i.title);
  assert.ok(titles.some((t) => t.startsWith('FAILED BRO-11')), 'FAILED must be named');
  assert.ok(titles.some((t) => t.startsWith('STUCK BRO-12')), 'STUCK must be named');
  assert.equal(titles[0].startsWith('FAILED'), true, 'FAILED sorts first — it is the only verdict disputing a live claim');
});

test('VERIFIED and UNVERIFIABLE are counted but never listed — a block the eye skips is the same as no block', () => {
  const titles = buildDigestSnapshot(REPORT).items.map((i) => i.title);
  assert.ok(!titles.some((t) => t.includes('BRO-10')), 'the quiet majority stays in the headline count');
  assert.ok(!titles.some((t) => t.includes('BRO-14')));
});

test('a clean board still emits a STANDING line, so silence can never be mistaken for a dead producer', () => {
  const snap = buildDigestSnapshot({ generatedAt: 'x', results: [classifyCard({ card: doneCard(), cmd: 'node --test a.mjs', runResult: PASS })] });
  assert.ok(snap, 'must not be null on a quiet night');
  assert.deepEqual(snap.items, []);
  assert.match(snap.bannerText, /1\/1 Done\(14d\) verified on main/);
});

test('the digest snapshot is the shape renderNamedDigestBlock already renders', () => {
  const snap = buildDigestSnapshot(REPORT);
  for (const k of ['generatedAt', 'bannerText', 'items', 'moreCount']) assert.ok(k in snap, `missing ${k}`);
  assert.ok(Array.isArray(snap.items));
  assert.equal(typeof snap.moreCount, 'number');
});

test('items are capped and the rest roll into moreCount', () => {
  const many = { generatedAt: 'x', results: Array.from({ length: 12 }, (_, i) => classifyCard({ card: doneCard({ id: `BRO-${i}` }), cmd: 'node --test a.mjs', runResult: FAIL })) };
  const snap = buildDigestSnapshot(many, { maxItems: 8 });
  assert.equal(snap.items.length, 8);
  assert.equal(snap.moreCount, 4);
});

// ── BRO-3476: the mis-armed adjudication must be keyed on the PATH, not on the
// ── command's SHAPE.
//
// BRO-3426 shipped the mis-armed rule wired to card-premises-auditor's
// extractCheckFilePaths, which only recognises `node --test` and `test -f`.
// The owner hand-checked the first live sweep and 2 of its 5 FAILED verdicts
// were false accusations against finished work. Both were this same hole seen
// from different sides, which is why these tests assert on all three shapes at
// once: a rule that is right for one command shape and silent for the next is
// how the sweep learned to lie in the first place.

test('BRO-3476: the phantom-path rule reaches EVERY command shape, not just `node --test` and `test -f`', () => {
  const { extractCheckPaths } = require('../../scripts/lib/autonomous-triage-core.js');
  const { extractCheckFilePaths } = require('../../scripts/lib/card-premises-auditor.js');

  // THE REGRESSION. BRO-3335 is armed `node scripts/audit-worktree-unpushed.js`
  // — a script with zero commits in this repo's entire history. The narrow
  // extractor returns nothing for it, so the mis-armed branch never ran and a
  // finished card was reported as broken work.
  const bro3335 = 'node scripts/audit-worktree-unpushed.js';
  assert.deepEqual(extractCheckFilePaths(bro3335), [], 'the old extractor is why this shape leaked through');
  assert.deepEqual(extractCheckPaths(bro3335), ['scripts/audit-worktree-unpushed.js']);

  // The two shapes that already worked must keep working — this change is a
  // widening, and a widening that drops an old case is a regression.
  assert.deepEqual(extractCheckPaths('test -f memory/cyrus-decision.txt'), ['memory/cyrus-decision.txt']);
  assert.deepEqual(extractCheckPaths('node --test scripts/lib/gate-cold-start-rules.test.mjs'), ['scripts/lib/gate-cold-start-rules.test.mjs']);

  // A command whose failure is about DATA, not about a missing file, must keep
  // extracting nothing — BRO-472 (`check-health-row-absent`) is a genuinely
  // FAILED card and widening the extractor must not absolve it.
  assert.deepEqual(extractCheckPaths('node scripts/check-health-row-absent.js --row-b64 RGF0YQ'), []);
  assert.deepEqual(extractCheckPaths('node scripts/validate-data.js'), []);
});

test('BRO-3476: an ignored path is unverifiable, and is never described as "never existed"', () => {
  // FALSE ACCUSATION 1, from the owner's hand-check. BRO-10 is armed
  // `test -f memory/cyrus-decision.txt`. That file is on the owner's disk;
  // memory/ is excluded by .gitignore, so the fresh origin/main checkout this
  // sweep builds can never see it. Reporting FAILED accuses finished work, and
  // reporting "has never existed in this repo" tells the owner something
  // demonstrably false about a file they can open.
  const facts = { 'memory/cyrus-decision.txt': { presentOnMain: false, everExisted: false, gitignored: true } };
  const m = adjudicateMisArmed(['memory/cyrus-decision.txt'], facts);
  assert.equal(m.kind, MIS_ARMED.GITIGNORED);

  const r = classifyCard({
    card: { id: 'BRO-10', name: 'Decide: keep Cyrus after free trial', state: 'Done' },
    cmd: 'test -f memory/cyrus-decision.txt',
    runResult: { status: 'fail', detail: 'Command failed: test -f memory/cyrus-decision.txt' },
    misArmed: m,
  });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.notEqual(r.verdict, VERDICTS.FAILED);
  assert.match(r.detail, /ignored/);
  assert.doesNotMatch(r.detail, /never existed/, 'the file exists on disk — saying otherwise is the sweep being confidently wrong');
  assert.equal(r.misArmed, true);
});

test('BRO-3476: a phantom script is unverifiable, and keeps the "never existed" wording', () => {
  // FALSE ACCUSATION 2. scripts/audit-worktree-unpushed.js: 0 hits on
  // origin/main, 0 commits in all of history. A mis-armed card, not broken work.
  const facts = { 'scripts/audit-worktree-unpushed.js': { presentOnMain: false, everExisted: false, gitignored: false } };
  const m = adjudicateMisArmed(['scripts/audit-worktree-unpushed.js'], facts);
  assert.equal(m.kind, MIS_ARMED.NEVER_EXISTED);

  const r = classifyCard({
    card: { id: 'BRO-3335', name: 'OWNER WATCH 2026-09-14', state: 'Done' },
    cmd: 'node scripts/audit-worktree-unpushed.js',
    runResult: { status: 'fail', detail: "Error: Cannot find module '<checkout>/scripts/audit-worktree-unpushed.js'" },
    misArmed: m,
  });
  assert.equal(r.verdict, VERDICTS.UNVERIFIABLE);
  assert.match(r.detail, /never existed/);
  assert.equal(r.misArmed, true);
});

test('BRO-3476: a DELETED path is still a real regression — the rule must not launder one', () => {
  // The whole safety argument. BRO-2952 names
  // scripts/lib/gate-cold-start-rules.test.mjs, which is absent from main now
  // but has 3 commits in history: it existed and went away. The owner
  // hand-adjudicated this one as a genuine finding and it must stay FAILED.
  const gone = { 'scripts/lib/gate-cold-start-rules.test.mjs': { presentOnMain: false, everExisted: true, gitignored: false } };
  assert.equal(adjudicateMisArmed(['scripts/lib/gate-cold-start-rules.test.mjs'], gone), null);

  const r = classifyCard({
    card: { id: 'BRO-2952', name: 'gate-cold-start A/B split drift', state: 'Done' },
    cmd: 'node --test scripts/lib/gate-cold-start-rules.test.mjs',
    runResult: { status: 'fail', detail: "Could not find 'scripts/lib/gate-cold-start-rules.test.mjs'" },
    misArmed: adjudicateMisArmed(['scripts/lib/gate-cold-start-rules.test.mjs'], gone),
  });
  assert.equal(r.verdict, VERDICTS.FAILED);
  assert.notEqual(r.misArmed, true);
});

test('BRO-3476: multi-path commands are adjudicated unanimously, so a typo cannot camouflage a deletion', () => {
  // The corpus really does contain these, e.g.
  // `node --test scripts/lib/provider-spend-core.test.mjs scripts/lib/provider-billing.test.mjs`.
  const paths = ['tests/unit/real.test.mjs', 'tests/unit/typo.test.mjs'];

  // One present, one phantom: the command was wrong the day it was written.
  assert.equal(adjudicateMisArmed(paths, {
    'tests/unit/real.test.mjs': { presentOnMain: true, everExisted: null, gitignored: false },
    'tests/unit/typo.test.mjs': { presentOnMain: false, everExisted: false, gitignored: false },
  }).kind, MIS_ARMED.NEVER_EXISTED);

  // One genuinely DELETED, one phantom: a regression wearing a typo as
  // camouflage. Fail closed — the card stays accused.
  assert.equal(adjudicateMisArmed(paths, {
    'tests/unit/real.test.mjs': { presentOnMain: false, everExisted: true, gitignored: false },
    'tests/unit/typo.test.mjs': { presentOnMain: false, everExisted: false, gitignored: false },
  }), null, 'a deleted file bundled with a phantom one must still accuse');

  // Nothing absent at all: the command failed on CONTENTS, which is the real
  // regression this sweep exists to catch. Never mis-armed.
  assert.equal(adjudicateMisArmed(paths, {
    'tests/unit/real.test.mjs': { presentOnMain: true, everExisted: null, gitignored: false },
    'tests/unit/typo.test.mjs': { presentOnMain: true, everExisted: null, gitignored: false },
  }), null);

  // No extractable path (BRO-472's shape) — nothing to adjudicate.
  assert.equal(adjudicateMisArmed([], {}), null);
});

test('BRO-3476: an unresolved history probe absolves nothing', () => {
  // A rate-limited night must not quietly clear the whole board. `null` is the
  // absence of an answer, not a finding of innocence — the same fail-open
  // direction every other uncertainty in this module takes, pointed the other
  // way because here "fail open" would mean dropping real accusations.
  assert.equal(adjudicateMisArmed(['scripts/x.js'], {
    'scripts/x.js': { presentOnMain: false, everExisted: null, gitignored: false },
  }), null);
});

test('BRO-3476: mis-armed cards are surfaced in the banner, since UNVERIFIABLE is never given rows', () => {
  const misArmedCard = classifyCard({
    card: { id: 'BRO-3335', name: 'phantom', state: 'Done' },
    cmd: 'node scripts/audit-worktree-unpushed.js',
    runResult: { status: 'fail', detail: 'Cannot find module' },
    misArmed: { path: 'scripts/audit-worktree-unpushed.js', kind: MIS_ARMED.NEVER_EXISTED, paths: ['scripts/audit-worktree-unpushed.js'] },
  });
  const snap = buildDigestSnapshot({ generatedAt: 'x', results: [misArmedCard] });
  assert.match(snap.bannerText, /1 mis-armed/);
  // It stays out of the rows — the action is "re-arm these", not "read them".
  assert.equal(snap.items.length, 0);

  // And a board with none must not grow a "0 mis-armed" clause.
  const clean = buildDigestSnapshot({ generatedAt: 'x', results: [] });
  assert.doesNotMatch(clean.bannerText, /mis-armed/);
});

test('BRO-3476: an ignore rule can never absolve a path that WAS tracked (the laundering hole)', () => {
  // Codex adversarial review, pre-ship. The first cut asked `check-ignore`
  // first and fabricated everExisted:false from a true answer, so a file that
  // was tracked, DELETED by a regression, and separately covered by an ignore
  // rule came out mis-armed — the sweep absolving the exact thing it exists to
  // catch. Being ignored today says nothing about what was tracked yesterday.
  assert.equal(adjudicateMisArmed(['scripts/lib/deleted-and-now-ignored.js'], {
    'scripts/lib/deleted-and-now-ignored.js': { presentOnMain: false, everExisted: true, gitignored: true },
  }), null, 'history says it existed — no ignore rule may override that');

  // Same guard for the unresolved case: `check-ignore` consults
  // .git/info/exclude and the global excludesFile, neither of which exists on
  // origin/main, so one developer's personal ignore rule must not be able to
  // clear a card on its own.
  assert.equal(adjudicateMisArmed(['scripts/x.js'], {
    'scripts/x.js': { presentOnMain: false, everExisted: null, gitignored: true },
  }), null, 'only a positive "never existed" absolves; gitignored alone must not');

  // And the legitimate case still works: never tracked AND ignored.
  assert.equal(adjudicateMisArmed(['memory/notes.txt'], {
    'memory/notes.txt': { presentOnMain: false, everExisted: false, gitignored: true },
  }).kind, MIS_ARMED.GITIGNORED);
});

test('BRO-3476: duplicate paths are collapsed, so the detail line cannot inflate its own count', () => {
  // `node --test a.mjs a.mjs` is a legal command and extractCheckPaths
  // preserves both tokens (Codex adversarial review).
  const m = adjudicateMisArmed(['tests/unit/a.test.mjs', 'tests/unit/a.test.mjs'], {
    'tests/unit/a.test.mjs': { presentOnMain: false, everExisted: false, gitignored: false },
  });
  assert.deepEqual(m.paths, ['tests/unit/a.test.mjs']);

  const r = classifyCard({
    card: { id: 'BRO-1', name: 'dupe', state: 'Done' },
    cmd: 'node --test tests/unit/a.test.mjs tests/unit/a.test.mjs',
    runResult: { status: 'fail', detail: 'x' },
    misArmed: m,
  });
  assert.doesNotMatch(r.detail, /more absent path/, 'one path named twice is still one path');
});

test('BRO-3476: a path missing from facts is not treated as absent', () => {
  // The pure function must not absolve a card on incomplete input: a path the
  // runner never resolved has no entry, and "no entry" is not "confirmed
  // absent" (Codex adversarial review).
  assert.equal(adjudicateMisArmed(['scripts/unresolved.js'], {}), null);
  // b.js has no facts entry at all. "We did not look" must not read as
  // "nothing to see": absolving on the subset that happened to be resolved is
  // how a partial run would clear a card it never checked.
  assert.equal(adjudicateMisArmed(['a.js', 'b.js'], {
    'a.js': { presentOnMain: false, everExisted: false, gitignored: false },
  }), null, 'fail closed on an incomplete fact set');
});

test('BRO-3476: an unresolvable origin/main fetch absolves nothing either', () => {
  // presentOnMain === null means the tree could not be read this run. A future
  // `=== false` -> `!== true` slip would turn one fetch blip into a clean bill
  // of health for every card on the board (ship-check finding).
  assert.equal(adjudicateMisArmed(['scripts/x.js'], {
    'scripts/x.js': { presentOnMain: null, everExisted: false, gitignored: false },
  }), null);
});

test('BRO-3476: the banner names the mis-armed cards, not just how many', () => {
  // A count that asks the reader to re-arm cards while withholding which cards
  // is not actionable, and these rows are invisible otherwise (UNVERIFIABLE is
  // not REPORTABLE) — Codex adversarial review.
  const mk = (id) => classifyCard({
    card: { id, name: id, state: 'Done' },
    cmd: 'node scripts/audit-phantom.js',
    runResult: { status: 'fail', detail: 'Cannot find module' },
    misArmed: { path: 'scripts/audit-phantom.js', kind: MIS_ARMED.NEVER_EXISTED, paths: ['scripts/audit-phantom.js'] },
  });
  const few = buildDigestSnapshot({ generatedAt: 'x', results: [mk('BRO-10'), mk('BRO-3335')] });
  assert.match(few.bannerText, /2 mis-armed, needs re-arming \(BRO-10, BRO-3335\)/);
  assert.doesNotMatch(few.bannerText, /more/);

  const many = buildDigestSnapshot({ generatedAt: 'x', results: ['a', 'b', 'c', 'd', 'e'].map(mk) });
  assert.match(many.bannerText, /5 mis-armed, needs re-arming \(a, b, c, \+2 more\)/);
});
