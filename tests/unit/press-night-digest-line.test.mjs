// BRO-6645: the morning email's one-line grade per opening night, and the fix-card filer.
// Records are the real Oct 29 press-night records (copied from data/audit/press-night so a later
// re-capture cannot change these sentences under the test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const D = require(path.join(ROOT, 'scripts/lib/press-night-digest.js'));

const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/press-night', f), 'utf8'));
const AFGM = () => load('a-few-good-men-2026-2026-10-29.json');
const HEART = () => load('the-heart-off-broadway-2026-2026-10-29.json');

const AFGM_SHOW = { id: 'a-few-good-men-2026', title: 'A Few Good Men', category: 'broadway', openingDate: '2026-10-29' };
const HEART_SHOW = { id: 'the-heart-off-broadway-2026', title: 'The Heart', category: 'off-broadway', openingDate: '2026-10-29' };
const AFTER_DEADLINE = Date.parse('2026-10-30T16:00:00Z'); // past the 10am ET draft deadline
const MORNING = Date.parse('2026-10-30T11:30:00Z'); // 7:30am ET, before it

// The real tracker entry for AFGM's Resend draft (built with 23 reviews, no stamped numbers).
const AFGM_DRAFT = { draftCreatedAt: '2026-10-30T14:34:06.741Z', draftStatus: 'draft', draftId: '9810ae5f', method: 'resend-draft', reviewCount: 23, completed: true, sentAt: null, broadcastKey: 'broadway:a-few-good-men-2026' };
const sentWithDraft = () => ({ 'a-few-good-men-2026': { ...AFGM_DRAFT }, 'broadway:a-few-good-men-2026': { ...AFGM_DRAFT, broadcastKey: undefined } });
const redditEmailed = (score, reviewCount) => ({ 'a-few-good-men-2026': { status: 'ready', emailedAt: '2026-10-30T14:00:41Z', emailedScore: score, emailedReviewCount: reviewCount, score, reviewCount, createdAt: '2026-10-30T07:46:43Z' } });
const numbers = (map) => (id) => map[id] || null;

function lineFor(rec, show, { sentShows = {}, redditDrafts = {}, live = {}, nowMs = AFTER_DEADLINE } = {}) {
  const section = D.buildSection({ night: '2026-10-29', records: [{ showId: show.id, rec }], shows: [show], sentShows, redditDrafts, readNumbers: numbers(live), nowMs });
  return section.entries[0];
}

test('late review (A Few Good Men, real record): observed release, TheWrap late, emails current', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 23 } };
  const e = lineFor(AFGM(), AFGM_SHOW, { sentShows: sentWithDraft(), redditDrafts: redditEmailed(60, 23), live });
  assert.equal(e.line, 'A Few Good Men: 21 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; TheWrap went live at 1:24am (late); the first review was not live until 11:40pm (38 min after release); emails ready. Failed.');
  assert.equal(e.verdict, 'FAIL');
  assert.deepEqual(e.misses.map((m) => m.kind), ['review']);
});

test('missing review (The Heart, real record): Theater Pizzazz late, Is Something Of A Miracle never live', () => {
  const live = { 'the-heart-off-broadway-2026': { score: 75, reviewCount: 4 } }; // below the Off-Broadway Reddit bar of 5
  const e = lineFor(HEART(), HEART_SHOW, { live });
  assert.equal(e.line, 'The Heart: 2 of 4 reviews live by 12:00am; Theater Pizzazz went live at 12:50am (late); Is Something Of A Miracle not live by 3:55am. Failed.');
  assert.deepEqual(e.misses.map((m) => m.key), ['review:theater-pizzazz:Ron Fassler', 'review:is-something-of-a-miracle:']);
});

test('stale email drafts (A Few Good Men): Resend draft and Reddit draft built with 23 reviews, site shows 24', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const e = lineFor(AFGM(), AFGM_SHOW, { sentShows: sentWithDraft(), redditDrafts: redditEmailed(60, 23), live });
  assert.equal(e.line, 'A Few Good Men: 21 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; TheWrap went live at 1:24am (late); the first review was not live until 11:40pm (38 min after release); opening-night email draft is out of date (built with 23 reviews, the site shows 24 reviews); Reddit draft emailed to you is out of date (score 60 from 23 reviews, the site shows score 60 from 24 reviews). Failed.');
  assert.deepEqual(e.misses.filter((m) => m.kind === 'email').map((m) => m.key), ['email:broadcast', 'email:reddit']);
});

test('no draft: a miss after the 10am deadline, "not due" before it', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const after = lineFor(AFGM(), AFGM_SHOW, { live, nowMs: AFTER_DEADLINE });
  assert.match(after.line, /; no opening-night email draft; no Reddit draft emailed\. Failed\.$/);
  const before = lineFor(AFGM(), AFGM_SHOW, { live, nowMs: MORNING });
  assert.match(before.line, /; opening-night email draft not due until 10:00am; Reddit draft not due until 10:00am\. Failed\.$/);
  assert.equal(before.misses.filter((m) => m.kind === 'email').length, 0);
});

test('pass: the A Few Good Men record with TheWrap and the first reviews on time', () => {
  const rec = AFGM();
  // Move the three first reviews to 11:20pm ET and TheWrap to 12:50am ET, in both live series.
  const early = new Set(['Time Out New York', "Talkin' Broadway", 'New York Theater']);
  for (const p of rec.perReview) {
    if (early.has(p.outlet)) p.firstLiveAt = '2026-10-30T03:20:00.000Z';
    if (p.outlet === 'TheWrap') p.firstLiveAt = '2026-10-30T04:50:00.000Z';
  }
  for (const r of rec.laneShadow.liveFirstSeen) {
    if (early.has(r.outlet)) r.at = '2026-10-30T03:20:00.000Z';
    if (r.outlet === 'TheWrap') r.at = '2026-10-30T04:50:00.000Z';
  }
  rec.reference['2h-observed'] = undefined;
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const sent = sentWithDraft();
  sent['a-few-good-men-2026'].reviewCount = 24;
  sent['broadway:a-few-good-men-2026'].reviewCount = 24;
  const e = lineFor(rec, AFGM_SHOW, { sentShows: sent, redditDrafts: redditEmailed(60, 24), live });
  assert.equal(e.line, 'A Few Good Men: 22 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; emails ready, passed.');
  assert.equal(e.verdict, 'PASS');
  assert.deepEqual(e.misses, []);
});

test('no record for a Broadway show that opened: not graded, never a pass', () => {
  const show = { id: 'x-2026', title: 'X', category: 'broadway', openingDate: '2026-10-29' };
  const s = D.buildSection({ night: '2026-10-29', records: [], shows: [show], readNumbers: () => null, nowMs: AFTER_DEADLINE });
  assert.equal(s.entries[0].line, 'X: not graded, the overnight check did not run.');
  assert.equal(s.entries[0].verdict, 'UNKNOWN');
});

test('lastNight: the ET calendar day before the email', () => {
  assert.equal(D.lastNight(Date.parse('2026-10-30T11:30:00Z')), '2026-10-29');
  assert.equal(D.lastNight(Date.parse('2026-10-31T02:00:00Z')), '2026-10-29'); // 10pm ET Oct 30
});

test('auto-filer: one card per show-night, nothing on re-run, a comment only for a new miss', async () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 }, 'the-heart-off-broadway-2026': { score: 75, reviewCount: 4 } };
  const build = (sentShows, redditDrafts) => D.buildSection({ night: '2026-10-29', records: [{ showId: AFGM_SHOW.id, rec: AFGM() }, { showId: HEART_SHOW.id, rec: HEART() }], shows: [AFGM_SHOW, HEART_SHOW], sentShows, redditDrafts, readNumbers: numbers(live), nowMs: AFTER_DEADLINE });
  const created = [];
  const comments = [];
  const createCard = async (c) => { created.push(c); return `BRO-${9000 + created.length}`; };
  const commentCard = async (id, text) => { comments.push({ id, text }); };
  const ledger = {};
  const fresh = build(sentWithDraft(), redditEmailed(60, 24)); // Reddit current: only the Resend draft is stale

  const r1 = await D.fileFixCards({ section: fresh, ledger, createCard, commentCard });
  assert.deepEqual(r1.filed.sort(), ['a-few-good-men-2026|2026-10-29', 'the-heart-off-broadway-2026|2026-10-29']);
  assert.equal(created.length, 2);
  const afgm = created.find((c) => c.title.includes('A Few Good Men'));
  assert.equal(afgm.title, 'P1: Opening night miss: A Few Good Men (2026-10-29)');
  assert.equal(afgm.priority, 1);
  assert.match(afgm.notes, /TheWrap went live at 1:24am ET/);
  assert.match(afgm.notes, /opening-night email draft is out of date/);
  assert.match(afgm.notes, /^VERIFY: node scripts\/press-night-record\.js --show=a-few-good-men-2026 --night=2026-10-29 --check --json$/m);

  // Re-run with the same misses (persisted ledger round-trip): nothing filed, nothing commented.
  const ledger2 = JSON.parse(JSON.stringify(ledger));
  const r2 = await D.fileFixCards({ section: build(sentWithDraft(), redditEmailed(60, 24)), ledger: ledger2, createCard, commentCard });
  assert.equal(created.length, 2);
  assert.equal(comments.length, 0);
  assert.deepEqual(r2.filed, []);

  // A new miss on the same show-night (the Reddit draft goes stale): a comment, not a second card.
  const r3 = await D.fileFixCards({ section: build(sentWithDraft(), redditEmailed(60, 23)), ledger: ledger2, createCard, commentCard });
  assert.equal(created.length, 2);
  assert.deepEqual(r3.commented, ['a-few-good-men-2026|2026-10-29']);
  assert.equal(comments[0].id, ledger2.cards['a-few-good-men-2026|2026-10-29'].identifier);
  assert.match(comments[0].text, /Reddit draft emailed to you is out of date/);
  const r4 = await D.fileFixCards({ section: build(sentWithDraft(), redditEmailed(60, 23)), ledger: ledger2, createCard, commentCard });
  assert.equal(comments.length, 1);
  assert.deepEqual(r4.commented, []);
});

test('auto-filer: an email-only miss files at P2', async () => {
  const entry = { showId: 's', night: '2026-10-29', title: 'S', line: 'S: ...', misses: [{ key: 'email:broadcast', kind: 'email', text: 'no opening-night email draft' }] };
  const created = [];
  await D.fileFixCards({ section: { entries: [entry] }, ledger: {}, createCard: async (c) => { created.push(c); return 'BRO-1'; }, commentCard: async () => {} });
  assert.equal(created[0].priority, 2);
  assert.equal(created[0].title, 'P2: Opening night miss: S (2026-10-29)');
});

test('email block: renders last night only, escapes the line, quiet when there were no openings', () => {
  const snap = { night: '2026-10-29', lines: [{ verdict: 'FAIL', line: 'A <b>Show</b>: 1 of 2 reviews live by 1:02am. Failed.' }, { verdict: 'PASS', line: 'B: 2 of 2 reviews live by 1:02am, passed.' }] };
  const html = D.renderPressNightBlock(snap, { nowMs: MORNING });
  assert.match(html, /Last night's openings/);
  assert.match(html, /A &lt;b&gt;Show&lt;\/b&gt;: 1 of 2 reviews live by 1:02am\. Failed\./);
  assert.match(html, /color:#b91c1c;/);
  assert.equal(D.renderPressNightBlock(snap, { nowMs: Date.parse('2026-11-01T11:30:00Z') }), ''); // an older night
  assert.equal(D.renderPressNightBlock({ night: '2026-10-29', lines: [] }, { nowMs: MORNING }), '');
});
