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
