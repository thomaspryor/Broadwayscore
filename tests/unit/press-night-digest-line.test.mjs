// BRO-6645: the morning email's one-line grade per opening night, and the fix cards its misses file.
// Uses the real Oct 29 press-night records; trackers are small fixtures in the real file shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../scripts/lib/press-night-digest-line.js');
const { outletName } = require('../../scripts/produce-press-night-grade-snapshot.js');

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'audit', 'press-night');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const AFGM = load('a-few-good-men-2026-2026-10-29.json');
const HEART = load('the-heart-off-broadway-2026-2026-10-29.json');

const afgmShow = { id: 'a-few-good-men-2026', title: 'A Few Good Men', category: 'broadway', openingDate: '2026-10-29' };
const heartShow = { id: 'the-heart-off-broadway-2026', title: 'The Heart', category: 'off-broadway', openingDate: '2026-10-29' };
const MORNING1 = Date.parse('2026-10-30T11:30:00Z'); // reviews graded, emails not due yet
const MORNING2 = Date.parse('2026-10-31T11:30:00Z'); // emails graded too
const NUM = { score: 60, reviewCount: 24 };

const REVIEW_LINE = 'A Few Good Men: Reviews came out at 11:02pm, not 10:00pm as assumed; 17 of 18 reviews live by 1:02am; '
  + 'TheWrap went live at 1:24am (late); the first review took 33 to 38 minutes to go live (limit 30)';

function grade(show, rec, { nowMs = MORNING1, sentShows = {}, redditDrafts = {}, numbersNow = NUM } = {}) {
  return L.gradeShow({ show, rec, numbersNow, readNumbers: () => numbersNow, sentShows, redditDrafts, nowMs, outletName });
}

// A passing night, derived from the real AFGM record: TheWrap live in time and a looser first-live bar.
function afgmPassing() {
  const rec = structuredClone(AFGM);
  for (const r of rec.perReview) if (r.outlet === 'TheWrap') r.firstLiveAt = '2026-10-30T04:50:00.000Z';
  for (const d of (rec.laneShadow && rec.laneShadow.discoveries) || []) if (d.outlet === 'TheWrap') d.at = '2026-10-30T04:48:00.000Z';
  return rec;
}

test('late review (real AFGM record): exact sentence, observed release, emails pending the first morning', () => {
  const e = grade(afgmShow, AFGM);
  assert.equal(e.line, `${REVIEW_LINE}; emails due by 12:00pm today. Failed.`);
  assert.equal(e.verdict, 'FAIL');
  assert.deepEqual(e.misses.map((m) => m.key), ['review:thewrap', 'review:first-live']);
});

test('missing review (real The Heart record): never-live outlet named, Off-Broadway has no email clause', () => {
  const e = grade(heartShow, HEART);
  assert.equal(e.line, 'The Heart: 2 of 4 reviews live by 12:00am; Is Something Of A Miracle still not live when the check ended at 3:55am, '
    + 'Theater Pizzazz went live at 12:50am (late). Failed.');
  assert.deepEqual(e.misses.map((m) => m.key).sort(), ['review:is-something-of-a-miracle', 'review:theater-pizzazz']);
  assert.equal(e.emails, 'none');
});

test('pass: every review live in time, the release time is only mentioned because it moved', () => {
  const rv = L.reviewGrade(afgmPassing(), { outletName, gates: { firstLiveWithinMin: 60 } });
  assert.equal(rv.verdict, 'PASS');
  assert.equal(rv.text, 'reviews came out at 11:02pm, not 10:00pm as assumed; 18 of 18 reviews live by 1:02am');
  assert.deepEqual(rv.misses, []);
});

const draftRecord = (over) => ({
  'broadway:a-few-good-men-2026': { completed: true, draftId: 'd1', draftStatus: 'draft', draftNumbers: { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } }, ...over },
  'a-few-good-men-2026': { broadcastKey: 'broadway:a-few-good-men-2026' },
});
const reddit = (score, reviewCount) => ({ 'a-few-good-men-2026': { emailedAt: '2026-10-30T14:00:41Z', emailedScore: score, emailedReviewCount: reviewCount, score, reviewCount } });

test('emails ready the second morning: draft current and Reddit emailed with current numbers', () => {
  const rv = L.reviewGrade(afgmPassing(), { outletName, gates: { firstLiveWithinMin: 60 } });
  const em = L.emailGrade({ show: afgmShow, sentShows: draftRecord({}), redditDrafts: reddit(60, 24), numbersNow: NUM, nowMs: MORNING2 });
  assert.equal(em.status, 'ok');
  assert.equal(em.text, 'opening-night email draft ready at 60, Reddit draft emailed');
  assert.equal(rv.verdict, 'PASS');
});

test('stale draft fails the night: the email draft says 23 reviews, the Reddit draft says score 59, the site says 60 from 24', () => {
  const e = grade(afgmShow, AFGM, {
    nowMs: MORNING2,
    sentShows: draftRecord({ draftNumbers: { 'a-few-good-men-2026': { score: 60, reviewCount: 23 } } }),
    redditDrafts: reddit(59, 23),
  });
  assert.equal(e.line, `${REVIEW_LINE}; the opening-night email draft is out of date (it says score 60, 23 reviews, the site says score 60, 24 reviews), `
    + 'the Reddit draft is out of date (it says score 59, 23 reviews, the site says score 60, 24 reviews). Failed.');
  assert.deepEqual(e.misses.filter((m) => m.key.startsWith('email:')).map((m) => m.key), ['email:broadcast-stale', 'email:reddit-stale']);
  // Same score, one review behind: the Reddit draft is fine.
  const em = L.emailGrade({ show: afgmShow, sentShows: draftRecord({}), redditDrafts: reddit(60, 23), numbersNow: NUM, nowMs: MORNING2 });
  assert.equal(em.status, 'ok');
});

test('missing draft past the deadline is a miss; an unreadable tracker is unknown, never "no draft"', () => {
  const missing = L.emailGrade({ show: afgmShow, sentShows: {}, redditDrafts: reddit(60, 24), numbersNow: NUM, nowMs: MORNING2 });
  assert.equal(missing.status, 'miss');
  assert.equal(missing.text, 'Reddit draft emailed, no opening-night email draft was made');
  const blind = L.emailGrade({ show: afgmShow, sentShows: null, redditDrafts: {}, numbersNow: NUM, nowMs: MORNING2 });
  assert.equal(blind.status, 'unknown');
  assert.deepEqual(blind.misses, []);
  const sent = L.emailGrade({ show: afgmShow, sentShows: draftRecord({ sentAt: '2026-10-30T15:00:00Z', draftStatus: 'sent' }), redditDrafts: reddit(60, 24), numbersNow: NUM, nowMs: MORNING2 });
  assert.equal(sent.text, 'opening-night email sent, Reddit draft emailed');
});

test('no record fails once the probe had time to report; nothing published is not graded', () => {
  const x = { ...heartShow, id: 'x', title: 'X' };
  // 05:00Z the morning after: the late job (embargo +6h) may not have committed yet.
  const early = grade(x, null, { nowMs: Date.parse('2026-10-30T05:00:00Z') });
  assert.equal(early.line, 'X: The overnight review check did not run, so reviews could not be graded. Not graded.');
  assert.deepEqual(early.misses, []);
  const late = grade(x, null);
  assert.equal(late.line, 'X: The overnight review check did not run, so reviews could not be graded. Failed.');
  assert.deepEqual(late.misses.map((m) => m.key), ['review:no-check']);
  const plan = L.planFiling([{ ...late, night: '2026-10-30' }], L.emptyLedger());
  assert.equal(plan[0].priority, 1);
  const empty = load('the-greatest-story-ever-off-broadway-2026-2026-10-29.json');
  assert.equal(grade({ ...heartShow, title: 'The Greatest Story Ever' }, empty).line,
    'The Greatest Story Ever: No reviews came out overnight, so there was nothing to grade. Not graded.');
});

test('gradeOpenings keeps a night 48h, then drops it', () => {
  const recs = { 'a-few-good-men-2026': AFGM, 'the-heart-off-broadway-2026': HEART };
  const run = (nowMs) => L.gradeOpenings({ shows: [afgmShow, heartShow, { id: 'old', openingDate: '2026-10-01' }], readRecord: (id) => recs[id] || null, readNumbers: () => NUM, sentShows: {}, nowMs, outletName });
  assert.deepEqual(run(MORNING1).map((e) => e.showId), ['a-few-good-men-2026', 'the-heart-off-broadway-2026']);
  assert.deepEqual(run(Date.parse('2026-11-01T11:30:00Z')).map((e) => e.showId), []);
});

test('auto-filer: files once per show-night, nothing on re-run, a new miss is one comment on the same card', async () => {
  const late = { ...grade(afgmShow, AFGM), night: '2026-11-08' };
  const filed = [];
  const commented = [];
  const deps = { fileCard: async (c) => { filed.push(c); return 'BRO-9001'; }, commentCard: async (card, text) => { commented.push({ card, text }); } };

  const a1 = L.planFiling([late], L.emptyLedger());
  assert.equal(a1.length, 1);
  assert.equal(a1[0].priority, 1);
  assert.match(a1[0].notes, /press-night-grade-key: a-few-good-men-2026:2026-11-08/);
  assert.match(a1[0].notes, /## Acceptance criteria/);
  assert.doesNotMatch(a1[0].notes, /VERIFY: node scripts\/press-night-record/);
  const { ledger } = await L.applyFiling(a1, L.emptyLedger(), deps);
  assert.equal(filed.length, 1);

  // Re-run with the same misses: nothing.
  assert.deepEqual(L.planFiling([late], ledger), []);

  // Next morning the emails also miss: one comment, no second card.
  const withEmail = { ...late, misses: [...late.misses, { key: 'email:reddit-stale', text: 'the Reddit draft is out of date' }] };
  const a2 = L.planFiling([withEmail], ledger);
  assert.deepEqual(a2.map((a) => [a.type, a.card]), [['comment', 'BRO-9001']]);
  const { ledger: ledger2 } = await L.applyFiling(a2, ledger, deps);
  assert.equal(filed.length, 1);
  assert.equal(commented.length, 1);
  assert.deepEqual(L.planFiling([withEmail], ledger2), []);
});

test('auto-filer: email-only misses are P2; nights before launch and a failed create are never recorded', async () => {
  const emailOnly = { showId: 's', night: '2026-11-09', title: 'S', line: 'S: x. Failed.', misses: [{ key: 'email:broadcast-missing', text: 'no draft' }] };
  assert.equal(L.planFiling([emailOnly], L.emptyLedger())[0].priority, 2);
  assert.deepEqual(L.planFiling([{ ...emailOnly, night: '2026-10-29' }], L.emptyLedger()), []);
  const { ledger, results } = await L.applyFiling(L.planFiling([emailOnly], L.emptyLedger()), L.emptyLedger(), { fileCard: async () => { throw new Error('Linear down'); }, commentCard: async () => {} });
  assert.equal(results[0].ok, false);
  assert.deepEqual(ledger.filed, {});
});

test('etClock reads Eastern time across the DST change', () => {
  assert.equal(L.etClock('2026-10-30T05:24:12Z'), '1:24am');
  assert.equal(L.etClock('2026-11-09T05:24:12Z'), '12:24am');
});

test('email block: graded lines first, quiet nights folded into one line, nothing on an empty window', () => {
  const empty = load('the-greatest-story-ever-off-broadway-2026-2026-10-29.json');
  const items = [grade(afgmShow, AFGM), grade({ ...heartShow, title: 'The Greatest Story Ever' }, empty), grade({ ...heartShow, title: 'Kelly McCaughan: Catholic Guilt' }, empty)];
  const html = L.renderPressNightGradesBlock({ items });
  assert.match(html, /Last night's openings/);
  assert.match(html, /A Few Good Men: Reviews came out at 11:02pm/);
  assert.match(html, /No reviews came out overnight for The Greatest Story Ever and Kelly McCaughan: Catholic Guilt, so there was nothing to grade\./);
  assert.equal((html.match(/nothing to grade/g) || []).length, 1);
  assert.equal(L.renderPressNightGradesBlock({ items: [] }), '');
  assert.equal(L.renderPressNightGradesBlock(null), '');
});

test('scoreboard over every record graded through Oct 29: exact sentence, shown above the lines', () => {
  const recs = fs.readdirSync(DIR).filter((f) => /-2026-10-(2[2-9])\.json$/.test(f)).map(load);
  const b = L.scoreboard(recs);
  assert.equal(b.line, 'Openings that passed on their own: 0 of 15 graded so far (6 failed, 9 could not be graded).');
  const html = L.renderPressNightGradesBlock({ scoreboard: b, items: [grade(afgmShow, AFGM)] });
  assert.ok(html.indexOf('Openings that passed on their own') < html.indexOf('A Few Good Men:'));
  assert.match(L.renderPressNightGradesBlock({ scoreboard: b, items: [] }), /0 of 15 graded so far/);
});
