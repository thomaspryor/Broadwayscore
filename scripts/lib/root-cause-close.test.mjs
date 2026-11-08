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
  'EFFECT: stale-fixture failures on main went from 3 a week to 0 in the 7 days after landing',
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
  const r = rcc.checkRootCauseClose({ title: 'Poller failed', texts: ['NO-ROOT-CAUSE: one-off upstream outage, nothing to guard', 'NO-EFFECT-CHECK: the outage ended upstream, nothing of ours to measure'] });
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

// BRO-7132: closes written in the PREVENTION format (bsc-runner prompt, global
// close rule) read as all-missing. The alias reads them; the bar does not drop.
test('PREVENTION aliases CLASS-GUARD and its ; cousins: tail fills COUSINS', () => {
  const p = rcc.parseRootCauseBlock(['- **PREVENTION:** scripts/lib/a.test.mjs fails on any stale stamp ; cousins: grepped scripts/lib/b.js, fixed it']);
  assert.equal(p.fields['CLASS-GUARD'], 'scripts/lib/a.test.mjs fails on any stale stamp');
  assert.equal(p.fields.COUSINS, 'grepped scripts/lib/b.js, fixed it');
  // `**NAME**:` bold form reads too.
  assert.equal(rcc.parseRootCauseBlock(['**ROOT-CAUSE**: the clone was shallow here']).fields['ROOT-CAUSE'], 'the clone was shallow here');
  // A PREVENTION-only close still lacks ROOT-CAUSE and RED-THEN-GREEN.
  const r = rcc.checkRootCauseClose({ title: 'Stale copy bug', texts: ['PREVENTION: scripts/lib/a.test.mjs ; cousins: looked in scripts/lib, none'] });
  assert.deepEqual(r.missing, ['ROOT-CAUSE', 'RED-THEN-GREEN', 'EFFECT']);
});

test('a path named only in the cousins tail never counts as the guard', () => {
  const texts = [
    'ROOT-CAUSE: the clone was shallow so origin/main was missing',
    'PREVENTION: a new fixture test for it ; cousins: patched scripts/setup-local-data.sh, nothing else',
    'RED-THEN-GREEN: the test failed without the fix and passed with it',
  ];
  const r = rcc.checkRootCauseClose({ title: 'Stale copy bug', texts, landedFiles: ['scripts/setup-local-data.sh'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['CLASS-GUARD', 'EFFECT']);
  assert.match(r.notes.join(), /names no file path/);
  // Same for an explicit CLASS-GUARD line carrying the tail.
  const g = rcc.parseRootCauseBlock(['CLASS-GUARD: a unit test ; cousins: scripts/x.js']);
  assert.equal(g.fields['CLASS-GUARD'], 'a unit test');
  assert.equal(g.fields.COUSINS, 'scripts/x.js');
});

test('an explicit CLASS-GUARD or COUSINS line beats PREVENTION in either order', () => {
  const explicit = 'CLASS-GUARD: scripts/lib/real.test.mjs catches the class';
  const later = 'PREVENTION: the new guard (no path) ; cousins: looked around';
  for (const texts of [[explicit, later], [later, explicit]]) {
    const p = rcc.parseRootCauseBlock(texts);
    assert.equal(p.fields['CLASS-GUARD'], 'scripts/lib/real.test.mjs catches the class');
    assert.equal(p.fields.COUSINS, 'looked around');
  }
  const p = rcc.parseRootCauseBlock(['COUSINS: searched data/ and src/, two found and fixed', 'PREVENTION: scripts/a.js ; cousins: short']);
  assert.equal(p.fields.COUSINS, 'searched data/ and src/, two found and fixed');
  // A full block written in the PREVENTION format passes.
  const full = rcc.checkRootCauseClose({ title: 'Fixture date bug', landedFiles: ['scripts/lib/fixture-dates.test.mjs'], texts: [
    'ROOT-CAUSE: the fixture hardcoded a date that aged past the TTL',
    'PREVENTION: scripts/lib/fixture-dates.test.mjs fails on absolute dates ; cousins: grepped tests/unit, fixed 2',
    'RED-THEN-GREEN: failed with the fix reverted, passed with it',
    'EFFECT: 0 of 12 fixtures stale on main after landing (12 of 12 before)',
  ] });
  assert.deepEqual([full.ok, full.kind], [true, 'root-cause']);
});

test('the one-line summary names what is missing and never reads as a refused close', () => {
  const r = { applies: true, ok: false, missing: ['ROOT-CAUSE', 'RED-THEN-GREEN'], notes: [] };
  for (const blocking of [false, true]) {
    const s = rcc.rootCauseCloseSummary('BRO-1', r, blocking);
    assert.match(s, /BRO-1 closed without ROOT-CAUSE, RED-THEN-GREEN/);
    assert.equal(s.includes('\n'), false);
    assert.doesNotMatch(s, /\bREFUSED\b|❌/); // verify-edits.sh _CLOSEOUT_REFUSED_RE
  }
  assert.equal(rcc.rootCauseCloseSummary('BRO-1', { applies: true, ok: true }, false), null);
  assert.match(rcc.rootCauseCloseMessage('BRO-1', r, false), /PREVENTION: <path> ; cousins:/);
});

test('linear-brain update Done on a fix card repeats the advisory as the last output line', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const run = (comment) => spawnSync(process.execPath, ['-e', `
    const { main } = require('./scripts/linear-brain.js');
    main(['update', 'BRO-1', '--state', 'Done', '--comment', ${JSON.stringify(comment)}], {
      getIssue: async () => ({ id: 'u', identifier: 'BRO-1', title: 'Opening night poller failed', description: '', state: { name: 'In Progress', type: 'started' }, comments: { nodes: [] }, relations: { nodes: [] } }),
      getTeam: async () => ({ states: [{ id: 's-d', name: 'Done', type: 'completed' }, { id: 's-t', name: 'Todo', type: 'unstarted' }] }),
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
      verifyEvidence: () => ({ verified: true, reason: 'stub' }),
      verifyCmdEvidence: () => ({ verified: true, reason: 'stub' }),
      landedFiles: null,
    });`], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, ROOT_CAUSE_CLOSE_GATE: 'advisory', LINEAR_DONE_GATE_DISABLED: '' } });
  const bare = run('PR-EVIDENCE: merged deployed checked (https://github.com/o/r/commit/abc1234)\nPREVENTION: scripts/a.test.mjs ; cousins: none');
  assert.match(bare.stderr, /UPDATE_ISSUE_CALLED/, bare.stderr);
  const last = bare.stderr.trim().split('\n').pop();
  assert.match(last, /ROOT-CAUSE CHECK: BRO-1 closed without ROOT-CAUSE, RED-THEN-GREEN/, bare.stderr);
  assert.match(bare.stdout, /"rootCauseMissing"/);
  const full = run(`PR-EVIDENCE: merged deployed checked (https://github.com/o/r/commit/abc1234)\n${FULL}`);
  assert.match(full.stderr, /UPDATE_ISSUE_CALLED/, full.stderr);
  assert.doesNotMatch(full.stderr, /ROOT-CAUSE CHECK/);
});

// BRO-7132 class guard: every place that teaches sessions or workers the close
// format must name lines this parser reads. The check read 0 of 7 fix closes
// because the worker prompt and wrap-up template taught other formats.
test('every close-format instruction names the fields the check reads', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { buildBudgetPreamble } = require('./bsc-runner.js');
  const sources = {
    'bsc-runner worker prompt': buildBudgetPreamble(60 * 60 * 1000),
    'wrap-up Fix template': fs.readFileSync(`${root}.claude/commands/wrap-up.md`, 'utf8').split('\n').find((l) => l.includes('**Fix:**')) || '',
    'CLAUDE.md rule 21': fs.readFileSync(`${root}CLAUDE.md`, 'utf8').split('### 21.')[1]?.split('\n### ')[0] || '',
    'recurrence root-card template': fs.readFileSync(`${root}scripts/recurrence-detector.js`, 'utf8').split('## What to do')[1]?.split('RECHECK-AFTER date')[0] || '',
  };
  for (const [name, text] of Object.entries(sources)) {
    for (const field of ['ROOT-CAUSE:', 'RED-THEN-GREEN:', 'NO-ROOT-CAUSE:', 'EFFECT:', 'NO-EFFECT-CHECK:']) assert.ok(text.includes(field), `${name} must name ${field}`);
    assert.ok(/CLASS-GUARD:|PREVENTION:/.test(text), `${name} must name CLASS-GUARD: or PREVENTION:`);
    assert.ok(/COUSINS:|cousins:/.test(text), `${name} must name COUSINS: or a ; cousins: tail`);
  }
});

test('near-miss cousins separators split too, and an empty line never erases a value (BRO-7132 review)', () => {
  for (const line of ['PREVENTION: a unit test, cousins: scripts/b.js', 'PREVENTION: a unit test — cousins checked: scripts/b.js', 'PREVENTION: a unit test - cousins: scripts/b.js']) {
    const p = rcc.parseRootCauseBlock([line]);
    assert.equal(p.fields['CLASS-GUARD'], 'a unit test', line);
    assert.equal(p.fields.COUSINS, 'scripts/b.js', line);
  }
  // A guard path with a hyphen is never cut.
  assert.equal(rcc.parseRootCauseBlock(['PREVENTION: scripts/lib/cousins-check.test.mjs']).fields['CLASS-GUARD'], 'scripts/lib/cousins-check.test.mjs');
  const p = rcc.parseRootCauseBlock(['PREVENTION: scripts/a.test.mjs catches it', 'PREVENTION:']);
  assert.equal(p.fields['CLASS-GUARD'], 'scripts/a.test.mjs catches it');
});

test('linear-session report --status=done also repeats the advisory as the last line (BRO-7132 review)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const run = (summary) => spawnSync(process.execPath, ['-e', `
    const linear = require('./scripts/lib/linear-client.js');
    Object.assign(linear, {
      getIssue: async (id) => ({ id: 'u', identifier: id, title: 'Opening night poller failed', description: '', state: { name: 'In Progress', type: 'started' }, comments: { nodes: [] } }),
      createComment: async () => {},
      getTeam: async () => ({ id: 't', states: [{ id: 's-d', name: 'Done', type: 'completed' }, { id: 's-b', name: 'Backlog', type: 'backlog' }] }),
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); return {}; },
    });
    require('./scripts/linear-session.js').cmdReport({ issue: 'BRO-1', status: 'done', summary: ${JSON.stringify(summary)} }, {
      verifyEvidence: () => ({ verified: true, reason: 'stub' }),
      verifyCmdEvidence: () => ({ verified: true, reason: 'stub' }),
      landedFiles: null,
    }).catch((e) => { console.error('THREW ' + e.message); process.exit(9); });`], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ROOT_CAUSE_CLOSE_GATE: 'advisory', LINEAR_DONE_GATE_DISABLED: '' } });
  const bare = run('PR-EVIDENCE: merged deployed checked (https://github.com/o/r/commit/abc1234)\nPREVENTION: scripts/a.test.mjs ; cousins: none');
  assert.match(bare.stderr, /UPDATE_ISSUE_CALLED/, bare.stderr);
  assert.match(bare.stderr.trim().split('\n').pop(), /ROOT-CAUSE CHECK: BRO-1 closed without ROOT-CAUSE, RED-THEN-GREEN/, bare.stderr);
  assert.match(bare.stdout, /"rootCauseMissing"/);
  const full = run(`PR-EVIDENCE: merged deployed checked (https://github.com/o/r/commit/abc1234)\n${FULL}`);
  assert.match(full.stderr, /UPDATE_ISSUE_CALLED/, full.stderr);
  assert.doesNotMatch(full.stderr, /ROOT-CAUSE CHECK/);
});

// BRO-7138: done claims that never had their effect. A fix close must say what
// was measured on real data after landing (or NO-EFFECT-CHECK: <reason>).
test('EFFECT: required on fix closes, spot fixes included; a measurement names a number', () => {
  const noEffect = FULL.split('\n').filter((l) => !l.startsWith('EFFECT:')).join('\n');
  const r = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [noEffect] });
  // The root cause WAS fixed: the digest share keeps counting it as root-cause.
  assert.deepEqual([r.ok, r.kind, r.missing], [false, 'root-cause', ['EFFECT']]);
  assert.match(rcc.rootCauseCloseMessage('BRO-1', r, false), /does not show the fix had its effect on real data/);
  assert.match(rcc.rootCauseCloseMessage('BRO-1', r, false), /dry run over real past inputs and hit rate/);
  const vague = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [noEffect, 'EFFECT: works now, checked it'] });
  assert.deepEqual(vague.missing, ['EFFECT']);
  assert.match(vague.notes.join(), /before and after \(numbers\)/);
  const optOut = rcc.checkRootCauseClose({ title: 'Fixture date bug', texts: [noEffect, 'NO-EFFECT-CHECK: the effect shows only at the next opening night'] });
  assert.equal(optOut.ok, true);
  const spot = rcc.checkRootCauseClose({ title: 'Poller failed', texts: ['NO-ROOT-CAUSE: one-off upstream outage, nothing to guard'] });
  assert.deepEqual([spot.ok, spot.kind, spot.missing], [false, 'spot', ['EFFECT']]);
  assert.equal(rcc.checkRootCauseClose({ title: 'Add a grosses page', texts: [] }).applies, false);
});
