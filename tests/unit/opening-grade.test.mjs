/**
 * BRO-7082: opening grade. Requires the real modules (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const og = require(path.join(repoRoot, 'scripts/lib/opening-grade.js'));
const pm = require(path.join(repoRoot, 'scripts/lib/press-night-manual-actions.js'));

const SHOW = { id: 'test-show-2026', title: 'Test Show', category: 'broadway', openingDate: '2026-10-29' };
const EMB = '2026-10-30T02:00:00.000Z'; // 22:00 New York on Oct 29
const NOW = Date.parse('2026-11-20T00:00:00Z');
const BOT = { author: 'GitHub Action', email: 'action@github.com' };
const files = [
  { _file: 'test-show-2026/nytimes--a.json', firstSeenAt: '2026-10-30T02:30:00Z', ingestOrigin: 'automated' },
  { _file: 'test-show-2026/variety--b.json', firstSeenAt: '2026-10-30T03:00:00Z' },
];
const routine = { sha: 'aaaaaaaa11', at: '2026-10-30T03:00:00Z', ...BOT, subject: 'data: Opening night poller — collected review texts', files: ['test-show-2026/variety--b.json'] };
const grade = (extra) => og.gradeOpening({ show: SHOW, files, commits: [routine], nowMs: NOW, ...extra });

test('a pipeline-only opening ran on its own', () => {
  const g = grade({});
  assert.equal(g.verdict, 'on-its-own');
  assert.equal(g.embargoAt, EMB, '22:00 local estimate without a press-night record');
  assert.equal(g.signals.length, 0);
  assert.match(og.gradeLine(g), /ran on its own\.$/);
});

test('a hand ingest-urls dispatch (AFGM 2026-10-29, d2aad044 TheWrap) needs hands', () => {
  const c = { sha: 'd2aad04400', at: '2026-10-30T04:45:37Z', ...BOT, subject: 'ingest-urls: 1 review(s) for test-show-2026', files: ['test-show-2026/thewrap--c.json'] };
  const g = grade({ commits: [routine, c] });
  assert.equal(g.verdict, 'needed-hands');
  assert.equal(g.signals[0].kind, 'ingest-dispatch');
  assert.equal(g.signals[0].outletId, 'thewrap');
  assert.equal(g.onlyIngestDispatches, true);
  // The record's own log of the same fix (sha in its source) is not double-counted.
  const rec = { showId: SHOW.id, night: '2026-10-29', embargoAt: EMB, manualActions: [{ at: '2026-10-30T04:42:00Z', outletId: 'thewrap', source: 'BRO-5955 comment 235dd1d8 (hand ingest-urls d2aad044)' }] };
  assert.equal(grade({ commits: [routine, c], pressNight: rec }).signals.length, 1);
});

test('a caller-tagged scheduled ingest (ingest-urls(tic-daily):) is not a hand fix', () => {
  const c = { sha: 'bbbbbbbb22', at: '2026-10-31T14:20:00Z', ...BOT, subject: 'ingest-urls(tic-daily): 1 review(s) for test-show-2026', files: ['test-show-2026/tic--d.json'] };
  assert.equal(grade({ commits: [routine, c] }).verdict, 'on-its-own');
});

test('the ingest-urls.yml fallback commit (data: Ingest URLs for) counts as a hand dispatch', () => {
  const c = { sha: 'ffffffff66', at: '2026-10-31T14:20:00Z', ...BOT, subject: 'data: Ingest URLs for test-show-2026', files: ['test-show-2026/fb--e.json'] };
  const g = grade({ commits: [routine, c] });
  assert.equal(g.verdict, 'needed-hands');
  assert.equal(g.signals[0].kind, 'ingest-dispatch');
  const other = { ...c, files: ['other-show-2026/fb--e.json'] };
  assert.equal(grade({ commits: [routine, other] }).verdict, 'on-its-own');
});

test('a person committing to the show during opening week needs hands; outside the window does not', () => {
  const c = (at) => ({ sha: 'cccccccc33', at, author: 'Tom Pryor', email: 'x@example.com', subject: 'fix publishDate', files: ['test-show-2026/variety--b.json'] });
  const g = grade({ commits: [c('2026-11-02T10:00:00Z')] });
  assert.equal(g.verdict, 'needed-hands');
  assert.equal(g.signals[0].kind, 'hand-commit');
  assert.equal(grade({ commits: [c('2026-11-12T10:00:00Z')] }).verdict, 'on-its-own', 'after opening week');
});

test('a corpus-wide sweep touching many shows is not a fix of this opening', () => {
  const sweep = { sha: 'dddddddd44', at: '2026-11-01T10:00:00Z', author: 'Tom Pryor', email: 'x@example.com', subject: 'BRO-6745 reverify', files: ['test-show-2026/a--b.json', 'x-2026/a--b.json', 'y-2026/a--b.json', 'z-2026/a--b.json'] };
  assert.equal(grade({ commits: [sweep] }).verdict, 'on-its-own');
  assert.equal(og.SWEEP_SHOWS, 3);
});

test('file-level hand steps: approvedFixes in the window and hand-created files', () => {
  const fixed = [...files, { _file: 'test-show-2026/x--y.json', firstSeenAt: '2026-10-29T10:00:00Z', approvedFixes: [{ field: 'publishDate', at: '2026-10-30T05:04:04Z' }] }];
  assert.equal(grade({ files: fixed }).signals[0].kind, 'approved-fix');
  const cosmetic = [...files, { _file: 'test-show-2026/x--y.json', firstSeenAt: '2026-10-29T10:00:00Z', approvedFixes: [{ field: 'criticName', at: '2026-10-30T05:04:04Z' }] }];
  assert.equal(grade({ files: cosmetic }).verdict, 'on-its-own', 'a criticName fix does not gate going live');
  const hand = [...files, { _file: 'test-show-2026/x--y.json', firstSeenAt: '2026-10-31T10:00:00Z', ingestOrigin: 'manual', ingestOriginBy: 'execute-approved-fix' }];
  assert.equal(grade({ files: hand }).signals[0].kind, 'hand-created-file');
});

test('history that does not reach back to the window is not-gradable, never a pass', () => {
  const g = grade({ historyFromMs: Date.parse('2026-10-29T00:00:00Z') });
  assert.equal(g.verdict, 'not-gradable');
  assert.equal(grade({ historyFromMs: Date.parse('2026-10-01T00:00:00Z') }).verdict, 'on-its-own');
});

test('no live reviews, excluded files, open window wording, known count', () => {
  assert.equal(grade({ files: [{ _file: 'test-show-2026/a--b.json', wrongShow: true }] }).verdict, 'no-reviews');
  const open = grade({ nowMs: Date.parse('2026-11-01T00:00:00Z'), gapResult: { censusVerdict: { candidateCount: 5 } } });
  assert.equal(open.windowClosed, false);
  assert.match(og.gradeLine(open), /2 reviews live of 5 known, ran on its own so far\./);
  assert.doesNotMatch(og.gradeLine(grade({ gapResult: { censusVerdict: { candidateCount: 1 } } })), /known/, 'a lagging census is not shown');
});

test('West End embargo estimate is 22:00 London', () => {
  assert.equal(new Date(og.estimateEmbargoMs('2026-10-20', 'west-end')).toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(new Date(og.estimateEmbargoMs('2026-11-05', 'off-west-end')).toISOString(), '2026-11-05T22:00:00.000Z');
  assert.equal(og.estimateEmbargoMs('TBA', 'broadway'), null);
});

test('selectOpenings: four markets, dated, not cancelled', () => {
  const shows = [SHOW, { ...SHOW, id: 'tour', category: 'tour' }, { ...SHOW, id: 'c', status: 'cancelled' }, { ...SHOW, id: 'tba', openingDate: null }];
  assert.deepEqual(og.selectOpenings(shows, { fromDate: '2026-10-01', toDate: '2026-10-31' }).map((s) => s.id), ['test-show-2026']);
});

test('summary, tally and digest block (missing snapshot says not checked yet)', () => {
  const gs = [grade({}), grade({ commits: [{ sha: 'eeeeeeee55', at: '2026-11-02T10:00:00Z', author: 'Tom', email: 'x@example.com', subject: 's', files: ['test-show-2026/a--b.json'] }] })];
  const sum = og.summarize(gs);
  assert.equal(sum.broadway.openings, 2);
  assert.equal(sum.broadway.onItsOwn, 1);
  assert.equal(og.tallyLine(sum, 14), 'Openings in the last 14 days that ran on their own: Broadway 1 of 2.');
  assert.match(og.renderOpeningGradesBlock(null), /not checked yet/);
  const html = og.renderOpeningGradesBlock({ from: '2026-10-20', to: '2026-11-03', grades: gs, summary: sum }, { nowMs: Date.parse('2026-11-03T12:00:00Z') });
  assert.match(html, /needed a person or a Claude session/);
  assert.match(html, /Broadway 1 of 2/);
  // No-reviews and not-gradable openings stay out of the denominator.
  const extra = { ...sum, broadway: { ...sum.broadway, openings: 4, noReviews: 1, notGradable: 1 } };
  assert.equal(og.tallyLine(extra, 14), 'Openings in the last 14 days that ran on their own: Broadway 1 of 2.');
  // A no-reviews line shows only when reviews are known to exist (a miss).
  const nr = (known) => ({ showId: 'x', title: 'X', category: 'broadway', openingDate: '2026-11-02', live: 0, known, verdict: 'no-reviews', signals: [], windowClosed: false });
  const opts = { nowMs: Date.parse('2026-11-03T12:00:00Z') };
  assert.doesNotMatch(og.renderOpeningGradesBlock({ from: '2026-10-20', to: '2026-11-03', grades: [nr(0)] }, opts), /0 reviews live/);
  assert.match(og.renderOpeningGradesBlock({ from: '2026-10-20', to: '2026-11-03', grades: [nr(5)] }, opts), /0 reviews live of 5 known, reviews are out but none are on the site yet/);
});

test('ingest dispatches use the same isBotAuthor rule as the press-night record', () => {
  assert.equal(pm.isBotAuthor('GitHub Action', 'action@github.com'), true);
});
