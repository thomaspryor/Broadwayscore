// BRO-7147: an opening whose review window closed with aggregator-cited reviews
// still missing must not grade "on-its-own", and "known" must not be the census
// candidate count (which includes other productions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const og = require('./opening-grade.js');

const show = { id: 'medea-off-broadway-2026', title: 'Medea', category: 'off-broadway', openingDate: '2026-10-20' };
const files = Array.from({ length: 6 }, (_, i) => ({ _file: `${show.id}/r${i}.json`, firstSeenAt: '2026-10-21T03:00:00Z', fullText: 'A sharp, funny and moving night at the theater. '.repeat(20) }));
const embargo = og.estimateEmbargoMs(show.openingDate, show.category);
const closed = embargo + (og.AFTER_H + 24) * 3600000;
const open = embargo + 24 * 3600000;
const gapResult = { showId: show.id, censusVerdict: { candidateCount: 11 }, computedAt: new Date(closed - 3600000).toISOString() };

test('closed window with cited reviews still missing grades incomplete, not on-its-own', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 2, nowMs: closed });
  assert.equal(g.verdict, 'incomplete');
  assert.equal(g.known, 8);
  assert.equal(g.missing, 2);
  assert.match(og.gradeLine(g), /6 reviews live of 8 cited, opening week ended with 2 cited reviews still missing/);
  const s = og.summarize([g])['off-broadway'];
  assert.equal(s.onItsOwn, 0);
  assert.equal(s.incomplete, 1);
  assert.match(og.tallyLine(og.summarize([g]), 14), /Off-Broadway 0 of 1/);
});

test('census candidates (other productions) never inflate known', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 0, nowMs: closed });
  assert.equal(g.verdict, 'on-its-own');
  assert.equal(g.known, 6);
  assert.equal(g.censusCandidates, 11);
  assert.doesNotMatch(og.gradeLine(g), /cited/);
});

test('open window with missing reviews still reads on-its-own so far', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 3, nowMs: open });
  assert.equal(g.verdict, 'on-its-own');
  assert.match(og.gradeLine(g), /6 reviews live of 9 cited, ran on its own so far/);
});

test('no audit row leaves known unknown', () => {
  const g = og.gradeOpening({ show, files, gapResult: null, missingCited: null, nowMs: closed });
  assert.equal(g.known, null);
  assert.equal(g.verdict, 'coverage-unknown'); // BRO-7161 F18: unknown is not "nothing missing"
});

test('digest block colours an incomplete opening and older summaries without the field still tally', () => {
  const g = og.gradeOpening({ show, files, gapResult, missingCited: 1, nowMs: closed });
  const html = og.renderOpeningGradesBlock({ from: '2026-10-15', to: '2026-10-29', grades: [g] }, { nowMs: Date.parse('2026-10-25T00:00:00Z') });
  assert.match(html, /#b91c1c/);
  const legacy = { 'off-broadway': { openings: 1, onItsOwn: 1, neededHands: 0, noReviews: 0, notGradable: 0 } };
  assert.match(og.tallyLine(legacy, 14), /Off-Broadway 1 of 1/);
});

test('hand fixes outrank incomplete; a closed window with none live but cited ones out is incomplete', () => {
  const hand = og.gradeOpening({ show, files: [{ ...files[0], ingestOrigin: 'manual', firstSeenAt: new Date(embargo + 3600000).toISOString() }, ...files.slice(1)],
    gapResult, missingCited: 2, nowMs: closed });
  assert.equal(hand.verdict, 'needed-hands');
  const none = og.gradeOpening({ show, files: [], gapResult, missingCited: 2, nowMs: closed });
  assert.equal(none.verdict, 'incomplete');
  assert.match(og.gradeLine(none), /0 reviews live of 2 cited, opening week ended with 2 cited reviews still missing/);
  const stillOpen = og.gradeOpening({ show, files: [], gapResult, missingCited: 2, nowMs: embargo + 3600000 });
  assert.equal(stillOpen.verdict, 'no-reviews');
  assert.match(og.gradeLine(stillOpen), /cited reviews are out but none are on the site yet/);
});

test('no gap audit row means missing and known are unknown, not zero', () => {
  const g = og.gradeOpening({ show, files, gapResult: null, missingCited: null, nowMs: closed });
  assert.equal(g.missing, null);
  assert.equal(g.known, null);
  assert.equal(g.verdict, 'coverage-unknown'); // BRO-7161 F18: unknown is not "nothing missing"
});

// ---- BRO-7161 class guards (F17-F20) ----
const BODY = 'A sharp, funny and moving night at the theater. '.repeat(20);
const iso = (ms) => new Date(ms).toISOString();
const good = (i, extra = {}) => ({ _file: `${show.id}/g${i}.json`, firstSeenAt: iso(embargo + 3600000), fullText: BODY, ...extra });

test('F17: live counts only rebuild-includable files (stubs, non-reviews, placeholders are not live)', () => {
  const junk = [
    { _file: `${show.id}/s1.json`, firstSeenAt: iso(embargo + 3600000) }, // no body, no score
    { _file: `${show.id}/s2.json`, firstSeenAt: iso(embargo + 3600000), fullText: BODY, isNonReview: true },
    { _file: `${show.id}/s3.json`, firstSeenAt: iso(embargo + 3600000), fullText: BODY, isPreviewPlaceholder: true },
  ];
  const g = og.gradeOpening({ show, files: [good(1), ...junk], gapResult, missingCited: 0, nowMs: closed });
  assert.equal(g.live, 1, 'only the real review is live');
  const none = og.gradeOpening({ show, files: junk, gapResult, missingCited: 0, nowMs: closed });
  assert.equal(none.verdict, 'no-reviews', 'three bodiless/non-review files must not read as on-its-own');
  assert.equal(og.isLiveFile(good(2), show), true);
});

test('F18: no audit row, or a stale one, never grades on-its-own; closed empty weeks stay visible', () => {
  assert.equal(og.gradeOpening({ show, files: [good(1)], gapResult: null, missingCited: null, nowMs: closed }).verdict, 'coverage-unknown');
  const stale = { ...gapResult, computedAt: iso(closed - (og.STALE_AUDIT_H + 1) * 3600000) };
  const g = og.gradeOpening({ show, files: [good(1)], gapResult: stale, missingCited: 0, nowMs: closed });
  assert.equal(g.verdict, 'coverage-unknown');
  assert.equal(og.gradeOpening({ show, files: [good(1)], gapResult: { ...gapResult, computedAt: undefined }, missingCited: 0, nowMs: closed }).verdict, 'coverage-unknown', 'row without a timestamp cannot vouch');
  assert.equal(og.gradeOpening({ show, files: [], gapResult: null, missingCited: null, nowMs: closed }).verdict, 'no-reviews', 'closed empty week with no audit row stays visible');
  const empty = og.gradeOpening({ show, files: [], gapResult, missingCited: 0, nowMs: closed });
  assert.equal(empty.verdict, 'no-reviews');
  const sum = og.summarize([empty, g]);
  assert.equal(sum['off-broadway'].noReviewsClosed, 1);
  assert.equal(sum['off-broadway'].coverageUnknown, 1);
  assert.match(og.tallyLine(sum, 14), /Not counted: 1 ended opening week with no reviews found; 1 not graded clean/);
  const html = og.renderOpeningGradesBlock({ from: '2026-10-15', to: '2026-10-29', grades: [{ ...empty, openingDate: '2026-10-25' }] }, { nowMs: Date.parse('2026-10-26T00:00:00Z') });
  assert.match(html, /no reviews were found/);
});

test('F19: a person fixing four shows in one commit is hand work; a named maintenance sweep or a 13-show commit is not', () => {
  const mk = (subject, n) => ({ sha: 'eeeeeeee55', at: iso(embargo + 2 * 86400000), author: 'Tom Pryor', email: 'x@example.com', subject,
    files: [`${show.id}/a--b.json`, ...Array.from({ length: n - 1 }, (_, i) => `other-${i}/a--b.json`)] });
  const run = (c) => og.gradeOpening({ show, files: [good(1)], commits: [c], gapResult, missingCited: 0, nowMs: closed });
  assert.equal(run(mk('add missed reviews for four shows', 4)).verdict, 'needed-hands');
  assert.equal(run(mk('BRO-6745 reverify', 4)).verdict, 'on-its-own');
  for (const subj of ['fix: refresh reviews for hamlet, cats, x, y', 'Fix Hamlet, Cats, Evita, Annie reviews: stamp dates', 'Restore 4 shows reviews after migration bug', 'cleanup']) {
    assert.equal(run(mk(subj, 4)).verdict, 'needed-hands', subj);
  }
  assert.equal(run(mk('add missed reviews', og.SWEEP_CEILING + 1)).verdict, 'on-its-own');
});

test('F20: files first seen after opening week are late rescues, not part of the week; they cannot erase a gap', () => {
  const lateAt = iso(embargo + (og.AFTER_H + 48) * 3600000);
  const files2 = [good(1), good(2, { firstSeenAt: lateAt }), good(3, { firstSeenAt: lateAt })];
  const g = og.gradeOpening({ show, files: files2, gapResult, missingCited: 2, nowMs: closed + 5 * 86400000 });
  assert.equal(g.live, 1);
  assert.equal(g.lateLive, 2);
  assert.equal(g.verdict, 'incomplete', 'the week ended with cited reviews missing, whatever was rescued later');
  assert.match(og.gradeLine(g), /2 more added after opening week/);
  // Audit re-run after the rescue shows nothing missing: still not on-its-own.
  const rerun = og.gradeOpening({ show, files: files2, gapResult, missingCited: 0, nowMs: closed + 5 * 86400000 });
  assert.equal(rerun.verdict, 'incomplete');
  assert.match(og.gradeLine(rerun), /ended before 2 reviews were found/);
});
