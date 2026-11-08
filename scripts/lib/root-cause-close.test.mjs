// BRO-7103 item 8: close-time root-cause check. Requires the real modules (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rcc = require('./root-cause-close.js');
const { checkLinearDoneTransition } = require('./linear-done-gate.js');

const FULL = [
  'ROOT-CAUSE: the fixture hardcoded a date that aged past the 14-day TTL',
  'CLASS-GUARD: scripts/lib/fixture-dates.test.mjs (fails on any absolute date in fixtures)',
  'RED-THEN-GREEN: with the fix reverted the guard failed on 3 fixtures; with it, passed',
  'COUSINS: grepped tests/unit for 2026- literals, found 2 more, fixed both',
].join('\n');

test('fix cards are told apart from new work by title', () => {
  for (const t of ['P1: main test.yml red: E2E Tests', 'Opening night poller failed', 'BSC Daily: Quality: star-vs-score mismatch',
    'Critics\' Take overcounts vs the on-site count', 'Dispatch flow is DEAD', 'Root cause: "x" keeps coming back (4 cards in 30 days)']) {
    assert.equal(rcc.isFixCard({ title: t }), true, t);
  }
  for (const t of ['Add missing Claude skills', 'Make critic byline distinct from pull quote', 'P2: Build the weekly grosses page', 'Backfill broken images']) {
    assert.equal(rcc.isFixCard({ title: t }), false, t);
  }
});

test('the newest value of each field wins; NO-ROOT-CAUSE is a spot fix', () => {
  const p = rcc.parseRootCauseBlock(['ROOT-CAUSE: old reason here', 'ROOT-CAUSE: newer reason here']);
  assert.equal(p.fields['ROOT-CAUSE'], 'newer reason here');
  const r = rcc.checkRootCauseClose({ title: 'Poller failed', texts: ['NO-ROOT-CAUSE: one-off upstream outage, nothing to guard'] });
  assert.deepEqual([r.applies, r.ok, r.kind], [true, true, 'spot']);
  const short = rcc.checkRootCauseClose({ title: 'Poller failed', texts: ['NO-ROOT-CAUSE: n/a'] });
  assert.equal(short.ok, false);
});

test('a full block passes; the guard must name a path that is in the landed diff when known', () => {
  const ok = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: ['', FULL] });
  assert.deepEqual([ok.ok, ok.kind], [true, 'root-cause']);
  assert.match(ok.notes.join(), /landed diff unknown/);
  const inDiff = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [FULL], landedFiles: ['scripts/lib/fixture-dates.test.mjs', 'x.js'] });
  assert.deepEqual([inDiff.ok, inDiff.notes.length], [true, 0]);
  const notIn = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [FULL], landedFiles: ['tests/unit/other.test.mjs'] });
  assert.deepEqual([notIn.ok, notIn.missing], [false, ['CLASS-GUARD']]);
  const noPath = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [FULL.replace(/CLASS-GUARD:.*/, 'CLASS-GUARD: a new unit test for it')] });
  assert.equal(noPath.ok, false);
  const noRed = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [FULL.replace(/RED-THEN-GREEN:.*/, 'RED-THEN-GREEN: checked it by hand, all good')] });
  assert.deepEqual(noRed.missing, ['RED-THEN-GREEN']);
  assert.equal(rcc.checkRootCauseClose({ title: 'Add a page', texts: [] }).applies, false);
});

test('advisory before the blocking date, refusing after it, rollback switch wins', () => {
  const before = Date.parse('2026-11-10T00:00:00Z');
  const after = Date.parse(`${rcc.ROOT_CAUSE_CLOSE_BLOCKING_FROM}T01:00:00Z`);
  assert.equal(rcc.rootCauseCloseBlocking(before, {}), false);
  assert.equal(rcc.rootCauseCloseBlocking(after, {}), true);
  assert.equal(rcc.rootCauseCloseBlocking(after, { ROOT_CAUSE_CLOSE_GATE: 'advisory' }), false);
  const msg = rcc.rootCauseCloseMessage('BRO-1', { applies: true, ok: false, missing: ['ROOT-CAUSE'], notes: [] }, false);
  assert.match(msg, new RegExp(`blocking from ${rcc.ROOT_CAUSE_CLOSE_BLOCKING_FROM}`));
});

test('the Done gate warns before the date and refuses after, only for fix cards', () => {
  const base = { targetStateType: 'completed', identifier: 'BRO-1', description: 'PR-EVIDENCE: merged deployed checked (https://x)', recurrenceSnapshot: null, landedFiles: null };
  const RealNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-10T00:00:00Z');
    const w = checkLinearDoneTransition({ ...base, title: 'Poller failed' });
    assert.match(w.warning || '', /root cause/);
    const allowedBefore = w.allowed;
    Date.now = () => Date.parse(`${rcc.ROOT_CAUSE_CLOSE_BLOCKING_FROM}T01:00:00Z`);
    const b = checkLinearDoneTransition({ ...base, title: 'Poller failed' });
    if (allowedBefore !== false) assert.deepEqual([b.allowed, b.verdict], [false, 'root-cause-missing']);
    const fine = checkLinearDoneTransition({ ...base, title: 'Poller failed', commentText: FULL });
    assert.notEqual(fine.verdict, 'root-cause-missing');
    const feature = checkLinearDoneTransition({ ...base, title: 'Add a weekly page' });
    assert.ok(!/root cause/.test(feature.warning || ''));
    const noTitle = checkLinearDoneTransition({ ...base });
    assert.ok(!/root cause/.test(noTitle.warning || ''));
  } finally {
    Date.now = RealNow;
  }
});

test('landed files come only from commits whose subject names the card, never reverts', () => {
  const landings = [
    JSON.stringify({ ts: '2026-11-01', branch: 'land/bro-77-x', sha: 'aaa' }),
    JSON.stringify({ ts: '2026-11-02', branch: 'land/revert-bro-77', sha: 'rrr' }),
  ].join('\n');
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'log') return args[3] === 'aaa'
      ? 'c1\tBRO-77: fix it\nc2\tBRO-78: someone else\nc3\tRevert "BRO-77: fix it"\nc4\tBRO-770: not this card'
      : '';
    if (args[0] === 'show') return args[3] === 'c1' ? 'a.js\nb.test.mjs\n' : 'WRONG\n';
    return '';
  };
  assert.deepEqual(rcc.landedFilesForCard('BRO-77', { landingsText: landings, exec }), ['a.js', 'b.test.mjs']);
  assert.ok(!calls.some((c) => c.includes('rrr')), 'revert landing is not read');
  assert.equal(rcc.landedFilesForCard('BRO-9', { landingsText: '', exec: () => '' }), null);
});

test('grader replies parse safely and the share leaves unclear out', () => {
  assert.deepEqual(rcc.parseGrade('{"grade":"spot-fix","confidence":0.97,"reason":"bumps a date","guard_file":null}').grade, 'spot-fix');
  assert.equal(rcc.parseGrade('```json\n{"grade":"root-cause","confidence":2}\n```').confidence, 1);
  assert.equal(rcc.parseGrade('not json').grade, 'unclear');
  assert.equal(rcc.parseGrade('{"grade":"great"}').grade, 'unclear');
  assert.deepEqual(rcc.summarizeSample([{ grade: 'root-cause' }, { grade: 'spot-fix' }, { grade: 'spot-fix' }, { grade: 'unclear' }]),
    { graded: 4, rootCause: 1, spot: 2, unclear: 1, share: 33.3 });
  assert.equal(rcc.summarizeSample([]).share, null);
  const g = (grade, confidence = 0.9) => ({ grade, confidence, reason: grade, guardFile: null });
  assert.deepEqual(rcc.majorityGrade([g('spot-fix', 0.98), g('root-cause'), g('spot-fix', 0.9)]).grade, 'spot-fix');
  assert.equal(rcc.majorityGrade([g('spot-fix', 0.98), g('root-cause'), g('spot-fix', 0.9)]).confidence, 0.94);
  assert.equal(rcc.majorityGrade([g('spot-fix'), g('root-cause'), g('unclear')]).grade, 'unclear', 'a three-way split is unclear');
  const ids = ['BRO-1', 'BRO-2', 'BRO-3', 'BRO-4', 'BRO-5'];
  assert.deepEqual(rcc.seededPick(ids, 3, 'w1'), rcc.seededPick(ids, 3, 'w1'));
  assert.equal(new Set(rcc.seededPick(ids, 5, 'w1')).size, 5);
});

test('the weekly sample grades only this week\'s fix cards from their diffs and skips when recent', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { sample } = require('../recurrence-detector.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const file = path.join(dir, 'sample.json');
  const now = Date.parse('2026-11-08T12:00:00Z');
  const done = (id, title, daysAgo) => ({ identifier: id, title, state: { type: 'completed', name: 'Done' }, completedAt: new Date(now - daysAgo * 864e5).toISOString() });
  const cards = [done('BRO-1', 'Poller failed', 1), done('BRO-2', 'Add a weekly page', 1), done('BRO-3', 'Dispatch is broken', 10),
    done('BRO-4', 'Scores are wrong', 2), done('BRO-5', 'Images missing', 3)];
  const graded = [];
  const out = await sample(cards, now, {
    file, landingsText: '{"ts":"2026-11-07T00:00:00Z","branch":"land/quick-fix","sha":"a"}\n{"ts":"2026-11-07T00:00:00Z","branch":"land/bro-4-x","sha":"b"}',
    diffFor: (id) => (id === 'BRO-5' ? null : { diff: `diff for ${id}`, files: ['a.js'], truncated: false }),
    grade: async (diff) => { graded.push(diff); return diff.includes('BRO-1') ? '{"grade":"root-cause","confidence":0.9}' : '{"grade":"spot-fix","confidence":0.9}'; },
  });
  const own = graded.filter((d) => !/BRO-70(66|98)/.test(d)).sort();
  assert.deepEqual(own, ['diff for BRO-1', 'diff for BRO-1', 'diff for BRO-1', 'diff for BRO-4', 'diff for BRO-4', 'diff for BRO-4'], 'each diff is graded 3 times');
  // Anchors: BRO-7066 and BRO-7098 are re-graded every week; this fake grader calls both spot-fix, so BRO-7098 misses.
  assert.equal(out.calibrationOk, false);
  assert.deepEqual(out.calibration.map((c) => c.got), ['spot-fix', 'spot-fix']);
  assert.deepEqual([out.poolSize, out.graded, out.rootCause, out.spot, out.share, out.noDiff, out.landingsWithoutId], [3, 2, 1, 1, 50, 1, 1]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).share, 50);
  const again = await sample(cards, now + 864e5, { file, grade: async () => { throw new Error('should not grade'); } });
  assert.equal(again, null);
});

test('show titles and build verbs do not make a fix card; "red" only as a CI state', () => {
  const showTitles = ['Dead Outlaw', 'Red Carpet', 'Never Gonna Dance', 'Hamilton'];
  for (const t of ['Dead Outlaw page shows old poster', 'Red Carpet card layout tweak', 'Never Gonna Dance show stub', 'Improve error messages in CLI', 'Retire stale cron']) {
    assert.equal(rcc.isFixCard({ title: t }, { showTitles }), false, t);
  }
  for (const t of ['P1: main test.yml red: E2E Tests', 'CI red again', 'Hamilton page shows wrong score', 'Dispatch flow is DEAD']) {
    assert.equal(rcc.isFixCard({ title: t }, { showTitles }), true, t);
  }
});

test('the Done path never fetches; a parentless (shallow-edge) commit is not graded', () => {
  const landings = JSON.stringify({ ts: '2026-11-01', branch: 'land/bro-77-x', sha: 'aaa' });
  const calls = [];
  const exec = (args) => {
    calls.push(args[0]);
    if (args[0] === 'cat-file') throw new Error('missing');
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'true\n';
    if (args[0] === 'log') return 'c1\tBRO-77: fix it';
    if (args[0] === 'rev-parse') throw new Error('no parent');
    if (args[0] === 'show') return 'x.js\n';
    return '';
  };
  rcc.landedFilesForCard('BRO-77', { landingsText: landings, exec });
  assert.ok(!calls.includes('fetch'), 'close-time read does not fetch');
  calls.length = 0;
  assert.equal(rcc.cardDiff('BRO-77', { landingsText: landings, exec }), null, 'whole-tree diff skipped');
  assert.ok(calls.includes('fetch'), 'the sampler may fetch in a shallow clone');
});
