// BRO-7872: the per-gap answer check behind review-coverage --record. Requires the real module (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { shipCheckReport, codeEditIndices } from './skeptic-review-stop.mjs';

import { isSkepticReviewCall } from './review-coverage.mjs';
const { parseSkepticReport, answerLines, verifyRan, skepticStats, concreteReason } = createRequire(import.meta.url)('./skeptic-gap-answers.js');

test('parses the real ship-check report (round trip with shipCheckReport)', () => {
  const text = shipCheckReport({ gaps: [
    { what: 'never ran the CLI on a missing file', why: 'unit only', check: 'node scripts/archive-show-images.js --force --show=x', severity: 'material' },
    { what: 'sweep untested', check: 'node scripts/archive-show-images.js --force', severity: 'material' },
    { what: 'typo', check: '', severity: 'minor' },
  ] });
  const r = parseSkepticReport(text);
  assert.equal(r.verdict, 'gaps');
  assert.equal(r.count, 2, 'minor gaps are not counted');
  assert.deepEqual(r.gaps.map((g) => g.n), [1, 2]);
  assert.match(r.gaps[0].check, /archive-show-images\.js --force --show=x/);
  assert.equal(parseSkepticReport(shipCheckReport({ gaps: [] })).verdict, 'clean');
  assert.equal(parseSkepticReport(shipCheckReport({ error: 'timeout' })).verdict, 'unavailable');
  assert.equal(parseSkepticReport('nothing here').verdict, 'none');
});

test('answer lines: three forms, decorations tolerated, code fences ignored, last answer wins', () => {
  const a = answerLines([
    '- **GAP 1:** ran node scripts/a.js --x',
    '> GAP #2) cannot run here: it sends real email to subscribers',
    '```\nGAP 3: not a gap: inside a fence\n```',
    'GAP 4: fixed it',
    'GAP 1: not a gap: the reviewer misread the diff, a.js is never called on this path',
  ]);
  assert.equal(a.get(1).kind, 'not-a-gap', 'later answer replaces the earlier one');
  assert.equal(a.get(2).kind, 'cannot');
  assert.equal(a.has(3), false, 'fenced text is not an answer');
  assert.equal(a.get(4).kind, 'invalid');
});

test('concrete reasons: real cost passes, schedule-only fails', () => {
  assert.ok(concreteReason('it sends real email to 900 subscribers'));
  assert.ok(!concreteReason('we will see after the nightly run'));
  assert.ok(!concreteReason('<reason>'));
  assert.ok(!concreteReason('n/a'));
});

test('verifyRan: needs a successful run naming the gap\'s file, as a command (not an argument)', () => {
  const gap = { n: 1, what: 'x', check: 'node scripts/lib/image-source-match.js --role=hero' };
  const bash = (id, command) => ({ kind: 'assistant_tool_use', name: 'Bash', id, input: { command } });
  const ok = (id) => ({ kind: 'tool_result', tool_use_id: id, content: 'done', isError: false });
  const events = [bash('a', 'cd /w && node scripts/lib/image-source-match.js --role=hero'), ok('a'),
    bash('b', 'echo node scripts/lib/image-source-match.js --role=poster'), ok('b')];
  assert.equal(verifyRan('node scripts/lib/image-source-match.js --role=hero', gap, events, -1).ok, true);
  assert.equal(verifyRan('node scripts/lib/image-source-match.js --role=poster', gap, events, -1).ok, false, 'only echoed, never run');
  assert.equal(verifyRan('node scripts/lib/image-source-match.js --role=hero', gap, events, 1).ok, false, 'ran before the window');
});

test('skepticStats counts runs, gaps found/answered and unavailable runs', () => {
  const call = (id) => ({ kind: 'assistant_tool_use', name: 'Bash', id, input: { command: 'node scripts/lib/skeptic-review-stop.mjs --ship-check' } });
  const out = (id, content) => ({ kind: 'tool_result', tool_use_id: id, content, isError: false });
  const two = 'SKEPTIC REVIEW: 2 material gap(s).\n1. a (b)\n   check: node scripts/q.js\n2. c (d)\n   check: node scripts/q.js --all';
  const events = [call('1'), out('1', 'SKEPTIC REVIEW UNAVAILABLE (timeout); this does not count as a review.'), call('2'), out('2', two),
    { kind: 'assistant_text', text: 'GAP 2: cannot run here: the full run spends real money on paid image APIs' }];
  const opts = { isSkepticCall: isSkepticReviewCall, codeEditIndices };
  assert.deepEqual(skepticStats(events, opts), { runs: 2, gapsFound: 2, gapsAnswered: 1, gapsRanBeforeLastEdit: 0, errors: 1 });
  assert.deepEqual(skepticStats([], opts), { runs: 0, gapsFound: 0, gapsAnswered: 0, gapsRanBeforeLastEdit: 0, errors: 0 });
  assert.throws(() => skepticStats(events), /pass isSkepticCall/, 'no silent loose fallback matcher');
  assert.throws(() => skepticStats(events, { isSkepticCall: isSkepticReviewCall }), /pass codeEditIndices/, 'no weaker default edit matcher');
});

test('ship-check review: reading a file or a failing run is not "ran"; natural answer forms are accepted', () => {
  const gap = { n: 1, what: 'x', check: 'node scripts/lib/foo.test.mjs' };
  const call = (id, c) => ({ kind: 'assistant_tool_use', name: 'Bash', id, input: { command: c } });
  const out = (id, t) => ({ kind: 'tool_result', tool_use_id: id, content: t, isError: false });
  const ev = [call('a', 'cd /w && node --test scripts/lib/foo.test.mjs 2>&1 | tail -3'), out('a', '# pass 12\n# fail 0'),
    call('b', 'cat scripts/lib/foo.test.mjs'), out('b', 'x'),
    call('c', 'node scripts/lib/foo.test.mjs | tail -2'), out('c', 'not ok 3 - y\n# fail 1')];
  assert.equal(verifyRan('cat scripts/lib/foo.test.mjs', gap, ev, -1).ok, false, 'cat is not a run');
  assert.equal(verifyRan('node scripts/lib/foo.test.mjs', gap, ev, -1).ok, false, 'a run that printed failing tests does not count');
  for (const c of ['`node --test scripts/lib/foo.test.mjs` (passed 12/12)', 'node --test scripts/lib/foo.test.mjs.', 'cd /w && node --test scripts/lib/foo.test.mjs']) {
    assert.equal(verifyRan(c, gap, ev, -1).ok, true, c);
  }
  const kinds = (t) => [...answerLines([t]).values()].map((a) => a.kind);
  assert.deepEqual(kinds('**GAP 1:** ran node x y z'), ['ran']);
  assert.deepEqual(kinds('1. GAP 2: not a gap: because reasons here ok'), ['not-a-gap']);
  assert.deepEqual(kinds('GAP 3 — cannot run here: sends real email to subscribers'), ['cannot']);
});

test('answers passed to review-coverage --record --answer count (chat text can be missing from the transcript)', () => {
  const { answerArgs, evaluateGapAnswers } = createRequire(import.meta.url)('./skeptic-gap-answers.js');
  assert.deepEqual(answerArgs(`node scripts/lib/review-coverage.mjs --record --answer='GAP 1: not a gap: the report is the final run' --answer="GAP 2: cannot run here: sends \\"real\\" email"`),
    ['GAP 1: not a gap: the report is the final run', 'GAP 2: cannot run here: sends "real" email']);
  assert.deepEqual(answerArgs(`echo --answer='GAP 1: not a gap: an echo is not the record command'`), [], 'only the record command counts');
  const report = 'SKEPTIC REVIEW: 1 material gap(s).\n1. a (b)\n   check: node scripts/q.js';
  const events = [
    { kind: 'assistant_tool_use', name: 'Bash', id: 's', input: { command: 'node scripts/lib/skeptic-review-stop.mjs --ship-check' } },
    { kind: 'tool_result', tool_use_id: 's', content: report, isError: false },
    { kind: 'assistant_tool_use', name: 'Bash', id: 'r', input: { command: `node scripts/lib/review-coverage.mjs --record --answer='GAP 1: cannot run here: it sends real email to subscribers'` } },
  ];
  assert.deepEqual(evaluateGapAnswers(events, { firstIdx: 0, lastIdx: 0, reportText: report }).answered, [1], 'read from the persisted record command');
  assert.deepEqual(evaluateGapAnswers(events.slice(0, 2), { firstIdx: 0, lastIdx: 0, reportText: report }).answered, [], 'nothing answered without it');
});

// BRO-7887: the 24h audit's rubber-stamp class. A "GAP n: ran X" answer was credited for any run after the FIRST skeptic
// run, even when the code it tested was edited again before the answer. Advisory: the gap stays answered, but
// ranBeforeLastEdit names it and the retro row / digest count it.
test('ranBeforeLastEdit: a run older than a code edit made before the answer is flagged (advisory, still answered)', () => {
  const { evaluateGapAnswers, ranBeforeLastEditAdvice } = createRequire(import.meta.url)('./skeptic-gap-answers.js');
  const W = '/Users/x/Broadwayscore/.claude/worktrees/job-a';
  const report = 'SKEPTIC REVIEW: 1 material gap(s).\n1. sweep untested (b)\n   check: node --test scripts/lib/q.test.mjs';
  const call = (id, command) => ({ kind: 'assistant_tool_use', name: 'Bash', id, input: { command } });
  const out = (id, content) => ({ kind: 'tool_result', tool_use_id: id, content, isError: false });
  const edit = (id) => ({ kind: 'assistant_tool_use', name: 'Edit', id, input: { file_path: `${W}/scripts/lib/q.js` } });
  const sk = [call('s', 'node scripts/lib/skeptic-review-stop.mjs --ship-check'), out('s', report)];
  const run = [call('t', 'node --test scripts/lib/q.test.mjs'), out('t', '# pass 3\n# fail 0')];
  const answer = { kind: 'assistant_text', text: 'GAP 1: ran node --test scripts/lib/q.test.mjs' };
  const judge = (events) => evaluateGapAnswers(events, { firstIdx: 0, lastIdx: 0, reportText: report, editIndices: codeEditIndices(events, -1) });

  // skeptic -> run -> edit -> answer: stale (the reported proof predates the code change)
  const stale = judge([...sk, ...run, edit('e'), answer]);
  assert.deepEqual(stale.answered, [1], 'advisory: still answered');
  assert.deepEqual(stale.ranBeforeLastEdit, [1]);
  assert.match(ranBeforeLastEditAdvice(stale.ranBeforeLastEdit), /gap\(s\) 1 .*Re-run/);
  // skeptic -> edit -> run -> answer: fresh
  assert.deepEqual(judge([...sk, edit('e'), ...run, answer]).ranBeforeLastEdit, []);
  // run -> edit -> run again -> answer: the LATEST run is credited, so fresh
  assert.deepEqual(judge([...sk, ...run, edit('e'), call('t2', 'node --test scripts/lib/q.test.mjs'), out('t2', '# pass 3'), answer]).ranBeforeLastEdit, []);
  // skeptic -> run -> chat answer -> edit -> --record: still stale (ship-check review: the record must not stamp a
  // receipt on proof that predates the edit just because the answer was written before it)
  assert.deepEqual(judge([...sk, ...run, answer, edit('e')]).ranBeforeLastEdit, [1]);
  // answer given on the record command (lastMessage, not yet in the transcript)
  const viaRecord = [...sk, ...run, edit('e')];
  assert.deepEqual(evaluateGapAnswers(viaRecord, { firstIdx: 0, lastIdx: 0, reportText: report, lastMessage: 'GAP 1: ran node --test scripts/lib/q.test.mjs', editIndices: codeEditIndices(viaRecord, -1) }).ranBeforeLastEdit, [1]);
  // edits only BEFORE the skeptic run never make an answer stale
  assert.deepEqual(judge([edit('e0'), ...sk, ...run, answer]).ranBeforeLastEdit, []);
  // a shell write (sed -i) counts as an edit, same matcher as the Stop gate
  assert.deepEqual(judge([...sk, ...run, call('w', "sed -i '' 's/a/b/' scripts/lib/q.js"), out('w', ''), answer]).ranBeforeLastEdit, [1]);
  // not measured without editIndices
  assert.equal(evaluateGapAnswers([...sk, ...run, edit('e'), answer], { firstIdx: 0, lastIdx: 0, reportText: report }).ranBeforeLastEdit, null);
  assert.equal(ranBeforeLastEditAdvice(null), '');
  // skepticStats carries the count into the retro row
  assert.equal(skepticStats([...sk, ...run, edit('e'), answer], { isSkepticCall: isSkepticReviewCall, codeEditIndices }).gapsRanBeforeLastEdit, 1);
});

test('evaluateCoverage passes editIndices through (review-coverage --record prints the advisory from this)', async () => {
  const { evaluateCoverage } = await import('./review-coverage.mjs');
  const report = 'SKEPTIC REVIEW: 1 material gap(s).\n1. sweep untested (b)\n   check: node --test scripts/lib/q.test.mjs';
  const call = (id, command) => ({ kind: 'assistant_tool_use', name: 'Bash', id, input: { command } });
  const out = (id, content) => ({ kind: 'tool_result', tool_use_id: id, content, isError: false });
  const events = [
    { kind: 'assistant_tool_use', name: 'Skill', id: 'k', input: { skill: 'ship-check' } }, out('k', 'Launching skill: ship-check'),
    call('s', 'node scripts/lib/skeptic-review-stop.mjs --ship-check'), out('s', report),
    call('t', 'node --test scripts/lib/q.test.mjs'), out('t', '# pass 3\n# fail 0'),
    { kind: 'assistant_tool_use', name: 'Write', id: 'w', input: { file_path: 'scripts/lib/q.js' } }, out('w', 'ok'),
  ];
  const lastMessage = 'GAP 1: ran node --test scripts/lib/q.test.mjs';
  assert.deepEqual(evaluateCoverage(events, { lastMessage, editIndices: codeEditIndices(events, -1) }).ranBeforeLastEdit, [1]);
  assert.equal(evaluateCoverage(events, { lastMessage }).ranBeforeLastEdit, null, 'not measured without editIndices (land-ready, Stop)');
});
