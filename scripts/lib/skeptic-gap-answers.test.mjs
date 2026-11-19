// BRO-7872: the per-gap answer check behind review-coverage --record. Requires the real module (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { shipCheckReport } from './skeptic-review-stop.mjs';

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
  assert.deepEqual(skepticStats(events, { isSkepticCall: isSkepticReviewCall }), { runs: 2, gapsFound: 2, gapsAnswered: 1, errors: 1 });
  assert.deepEqual(skepticStats([], { isSkepticCall: isSkepticReviewCall }), { runs: 0, gapsFound: 0, gapsAnswered: 0, errors: 0 });
  assert.throws(() => skepticStats(events), /pass isSkepticCall/, 'no silent loose fallback matcher');
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
