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
  assert.equal(e.line, 'A Few Good Men: published by the regular pipeline; TheWrap fixed by hand at 12:42am; 21 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; TheWrap went live at 1:24am (late); the first review was not live until 11:40pm (38 min after release); emails ready. Failed.');
  assert.equal(e.verdict, 'FAIL');
  assert.deepEqual(e.misses.map((m) => m.kind), ['review']);
});

test('missing review (The Heart, real record): Theater Pizzazz late, Is Something Of A Miracle never live', () => {
  const live = { 'the-heart-off-broadway-2026': { score: 75, reviewCount: 4 } }; // below the Off-Broadway Reddit bar of 5
  const e = lineFor(HEART(), HEART_SHOW, { live });
  assert.equal(e.line, 'The Heart: published by the regular pipeline; 2 of 4 reviews live by 12:00am; Theater Pizzazz went live at 12:50am (late); Is Something Of A Miracle not live by 3:55am. Failed.');
  assert.deepEqual(e.misses.map((m) => m.key), ['review:theater-pizzazz:Ron Fassler', 'review:is-something-of-a-miracle:']);
});

test('stale email drafts (A Few Good Men): Resend draft and Reddit draft built with 23 reviews, site shows 24', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const e = lineFor(AFGM(), AFGM_SHOW, { sentShows: sentWithDraft(), redditDrafts: redditEmailed(60, 23), live });
  assert.equal(e.line, 'A Few Good Men: published by the regular pipeline; TheWrap fixed by hand at 12:42am; 21 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; TheWrap went live at 1:24am (late); the first review was not live until 11:40pm (38 min after release); opening-night email draft is out of date (built with 23 reviews, the site shows 24 reviews); Reddit draft emailed to you is out of date (score 60 from 23 reviews, the site shows score 60 from 24 reviews). Failed.');
  assert.deepEqual(e.misses.filter((m) => m.kind === 'email').map((m) => m.key), ['email:broadcast:stale', 'email:reddit:stale']);
});

test('no draft: a miss after the 10am deadline, "not due" before it', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const after = lineFor(AFGM(), AFGM_SHOW, { live, nowMs: AFTER_DEADLINE });
  assert.match(after.line, /; no opening-night email draft; no Reddit draft emailed\. Failed\.$/);
  const before = lineFor(AFGM(), AFGM_SHOW, { live, nowMs: MORNING });
  assert.match(before.line, /; opening-night email draft not due until 10:00am; Reddit draft not due until 10:00am\. Failed\.$/);
  assert.equal(before.misses.filter((m) => m.kind === 'email').length, 0);
});

// The AFGM record with the three first reviews moved to 11:20pm ET and TheWrap to 12:50am ET, in both live series.
function afgmOnTime() {
  const rec = AFGM();
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
  return rec;
}

test('pass: the A Few Good Men record with TheWrap and the first reviews on time', () => {
  const rec = afgmOnTime();
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 } };
  const sent = sentWithDraft();
  sent['a-few-good-men-2026'].reviewCount = 24;
  sent['broadway:a-few-good-men-2026'].reviewCount = 24;
  const e = lineFor(rec, AFGM_SHOW, { sentShows: sent, redditDrafts: redditEmailed(60, 24), live });
  assert.equal(e.line, 'A Few Good Men: published by the regular pipeline; TheWrap fixed by hand at 12:42am; 22 of 22 reviews live by 1:02am; reviews came out at 11:02pm, not the expected 10:00pm, so they were timed from 11:02pm; emails ready, passed.');
  assert.equal(e.verdict, 'PASS');
  assert.deepEqual(e.misses, []);
});

test('no record for a Broadway show that opened: reviews not graded, never a pass; the emails still are', () => {
  const show = { id: 'x-2026', title: 'X', category: 'broadway', openingDate: '2026-10-29' };
  const sent = { 'x-2026': { draftId: 'd1', draftStatus: 'sent', sentAt: '2026-10-30T15:00:00Z' } };
  const ok = D.buildSection({ night: '2026-10-29', records: [], shows: [show], sentShows: sent, readNumbers: () => null, nowMs: AFTER_DEADLINE });
  assert.equal(ok.entries[0].line, 'X: not graded, the overnight check did not run; emails ready.');
  assert.equal(ok.entries[0].verdict, 'UNKNOWN');
  // A stopped probe must not hide a missing draft.
  const miss = D.buildSection({ night: '2026-10-29', records: [], shows: [show], readNumbers: () => ({ score: 70, reviewCount: 14 }), nowMs: AFTER_DEADLINE });
  assert.equal(miss.entries[0].line, 'X: reviews not graded, the overnight check did not run; no opening-night email draft; no Reddit draft emailed. Failed.');
  assert.deepEqual(miss.entries[0].misses.map((m) => m.key), ['email:broadcast:missing', 'email:reddit:missing']);
  // Below the broadcast's review floor no draft is owed yet: said, not failed.
  const early = D.buildSection({ night: '2026-10-29', records: [], shows: [show], readNumbers: () => ({ score: null, reviewCount: 5 }), nowMs: AFTER_DEADLINE });
  assert.equal(early.entries[0].line, 'X: not graded, the overnight check did not run; no opening-night email draft yet (the site has 5 of the 12 reviews a draft needs).');
});

test('emails: unreadable site numbers are "could not check", never "ready"; a stale draft is not a miss before 10am', () => {
  const r = D.gradeEmails({ show: AFGM_SHOW, sentShows: sentWithDraft(), redditDraft: redditEmailed(60, 23)['a-few-good-men-2026'], readNumbers: () => null, nowMs: AFTER_DEADLINE });
  assert.deepEqual(r.map((e) => e.status), ['pending', 'pending']);
  assert.match(r[0].text, /could not check the opening-night email draft/);
  const early = D.gradeEmails({ show: AFGM_SHOW, sentShows: sentWithDraft(), redditDraft: redditEmailed(60, 24)['a-few-good-men-2026'], readNumbers: numbers({ 'a-few-good-men-2026': { score: 60, reviewCount: 24 } }), nowMs: Date.parse('2026-10-30T11:30:00Z') });
  assert.equal(early[0].status, 'pending');
  assert.match(early[0].text, /out of date/);
});

test('lastNight: the ET calendar day before the email', () => {
  assert.equal(D.lastNight(Date.parse('2026-10-30T11:30:00Z')), '2026-10-29');
  assert.equal(D.lastNight(Date.parse('2026-10-31T02:00:00Z')), '2026-10-29'); // 10pm ET Oct 30
});

// In-memory Linear: cards keep their description and comments across runs, in any state (like the real
// lookup, which reads archived and closed issues by their key line).
function fakeLinear() {
  const cards = [];
  const created = [];
  const comments = [];
  return {
    cards, created, comments,
    lookupCards: async (keySlug) => cards.filter((c) => D.cardKeyOf(c.description) === keySlug),
    createCard: async (c) => {
      created.push(c);
      const card = { identifier: `BRO-${9000 + created.length}`, description: c.notes, comments: [], completedAt: null };
      cards.push(card);
      return card.identifier;
    },
    commentCard: async (card, text) => { comments.push({ id: card.identifier, text }); card.comments.push(text); },
  };
}

test('auto-filer: one card per show-night, nothing on re-run, a comment only for a new miss', async () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 24 }, 'the-heart-off-broadway-2026': { score: 75, reviewCount: 4 } };
  const build = (sentShows, redditDrafts) => D.buildSection({ night: '2026-10-29', records: [{ showId: AFGM_SHOW.id, rec: AFGM() }, { showId: HEART_SHOW.id, rec: HEART() }], shows: [AFGM_SHOW, HEART_SHOW], sentShows, redditDrafts, readNumbers: numbers(live), nowMs: AFTER_DEADLINE });
  const L = fakeLinear();
  const run = (section) => D.fileFixCards({ section, lookupCards: L.lookupCards, createCard: L.createCard, commentCard: L.commentCard });

  const r1 = await run(build(sentWithDraft(), redditEmailed(60, 24))); // Reddit current: only the Resend draft is stale
  assert.deepEqual(r1.filed.sort(), ['a-few-good-men-2026|2026-10-29', 'the-heart-off-broadway-2026|2026-10-29']);
  assert.equal(L.created.length, 2);
  const afgm = L.created.find((c) => c.title.includes('A Few Good Men'));
  assert.equal(afgm.title, 'P1: Opening night miss: A Few Good Men (2026-10-29)');
  assert.equal(afgm.priority, 1);
  assert.match(afgm.notes, /TheWrap went live at 1:24am ET/);
  assert.match(afgm.notes, /opening-night email draft is out of date/);
  assert.match(afgm.notes, /^press-night-card-key: a-few-good-men-2026-2026-10-29$/m);
  assert.match(afgm.notes, /^press-night-miss: email-broadcast-stale$/m);
  assert.match(afgm.notes, /^press-night-miss: review-thewrap-robert-hofler$/m);
  // A review miss cannot be re-graded green (the record is history): no VERIFY, close with PR-EVIDENCE.
  assert.doesNotMatch(afgm.notes, /^VERIFY:/m);
  assert.match(afgm.notes, /Close with PR-EVIDENCE/);

  // Re-run with the same misses: nothing filed, nothing commented.
  const r2 = await run(build(sentWithDraft(), redditEmailed(60, 24)));
  assert.equal(L.created.length, 2);
  assert.equal(L.comments.length, 0);
  assert.deepEqual(r2.filed, []);
  assert.equal(r2.skipped.length, 2);

  // A new miss on the same show-night (the Reddit draft goes stale): a comment, not a second card.
  const r3 = await run(build(sentWithDraft(), redditEmailed(60, 23)));
  assert.equal(L.created.length, 2);
  assert.deepEqual(r3.commented, ['a-few-good-men-2026|2026-10-29']);
  assert.equal(L.comments[0].id, L.cards.find((c) => c.description === afgm.notes).identifier);
  assert.match(L.comments[0].text, /Reddit draft emailed to you is out of date/);
  assert.match(L.comments[0].text, /^press-night-miss: email-reddit-stale$/m);
  const r4 = await run(build(sentWithDraft(), redditEmailed(60, 23)));
  assert.equal(L.comments.length, 1);
  assert.deepEqual(r4.commented, []);

  // A closed card still counts: its misses are never filed again.
  for (const c of L.cards) c.completedAt = '2026-10-30T20:00:00Z';
  const r5 = await run(build(sentWithDraft(), redditEmailed(60, 23)));
  assert.equal(L.created.length, 2);
  assert.deepEqual(r5.filed, []);
  // A NEW miss after every card closed gets a new card (a comment on a closed card reaches nobody), listing
  // only that miss; the run after files nothing.
  const r6 = await run(build({}, redditEmailed(60, 23)));
  assert.equal(L.created.length, 3);
  assert.deepEqual(r6.filed, ['a-few-good-men-2026|2026-10-29']);
  assert.equal(L.created[2].priority, 2);
  assert.match(L.created[2].notes, /^- no opening-night email draft$/m);
  assert.doesNotMatch(L.created[2].notes, /^- TheWrap/m); // only the new miss is listed
  assert.match(L.created[2].notes, /^VERIFY: node scripts\/produce-press-night-digest-snapshot\.js --night=2026-10-29 --check=a-few-good-men-2026$/m);
  assert.equal((await run(build({}, redditEmailed(60, 23)))).filed.length, 0);
});

test('auto-filer: an email-only miss files at P2; a Linear failure is reported, not thrown', async () => {
  const entry = { showId: 's', night: '2026-10-29', title: 'S', line: 'S: ...', misses: [{ key: 'email:broadcast', kind: 'email', text: 'no opening-night email draft' }] };
  const L = fakeLinear();
  await D.fileFixCards({ section: { entries: [entry] }, lookupCards: L.lookupCards, createCard: L.createCard, commentCard: L.commentCard });
  assert.equal(L.created[0].priority, 2);
  assert.equal(L.created[0].title, 'P2: Opening night miss: S (2026-10-29)');
  const r = await D.fileFixCards({ section: { entries: [entry] }, lookupCards: async () => { throw new Error('Linear down'); }, createCard: L.createCard, commentCard: L.commentCard });
  assert.deepEqual(r.errors, ['s|2026-10-29: Linear down']);
  assert.equal(L.created.length, 1);
});

test('card slugs: Linear-safe and diacritics folded, so a critic name cannot break the dedupe', () => {
  assert.equal(D.slug('review:le-monde:Hélène *O_Brien* | x'), 'review-le-monde-helene-o-brien-x');
  assert.equal(D.cardKeyOf('text\npress-night-card-key: a-b-2026-2026-10-30\\\nmore'), 'a-b-2026-2026-10-30');
});

test('auto-filer grace: an email miss files only after it outlived one hourly draft refresh', () => {
  const entry = { showId: 's', night: '2026-10-29', title: 'S', line: 'S: ...', misses: [
    { key: 'email:reddit', kind: 'email', text: 'no Reddit draft emailed' },
    { key: 'review:first-live', kind: 'review', text: 'late first review' },
  ] };
  const section = { entries: [entry] };
  const t0 = Date.parse('2026-10-30T16:17:00Z');
  const seen1 = D.missFirstSeen(section, {}, new Date(t0).toISOString());
  assert.deepEqual(D.settledMisses(section, seen1, t0).entries[0].misses.map((m) => m.key), ['review:first-live']);
  // Next hour: carried forward, still inside the grace; the hour after, settled.
  const seen2 = D.missFirstSeen(section, seen1, '2026-10-30T17:17:00Z');
  assert.equal(seen2['s|2026-10-29|email:reddit'], '2026-10-30T16:17:00.000Z');
  assert.equal(D.settledMisses(section, seen2, t0 + 60 * 60000).entries[0].misses.length, 1);
  assert.equal(D.settledMisses(section, seen2, t0 + 120 * 60000).entries[0].misses.length, 2);
  // A miss that cleared drops out of the carried map, so a later recurrence starts its own grace.
  assert.deepEqual(Object.keys(D.missFirstSeen({ entries: [{ ...entry, misses: [entry.misses[1]] }] }, seen2, 'x')), ['s|2026-10-29|review:first-live']);
});

test('email block: renders last night only, escapes the line, quiet when there were no openings', () => {
  const snap = { night: '2026-10-29', lines: [{ verdict: 'FAIL', line: 'A <b>Show</b>: 1 of 2 reviews live by 1:02am. Failed.' }, { verdict: 'PASS', line: 'B: 2 of 2 reviews live by 1:02am, passed.' }] };
  const html = D.renderPressNightBlock(snap, { nowMs: MORNING });
  assert.match(html, /Last night's openings/);
  assert.match(html, /A &lt;b&gt;Show&lt;\/b&gt;: 1 of 2 reviews live by 1:02am\. Failed\./);
  assert.match(html, /color:#b91c1c;/);
  // An older night: the section says the check has not run, never goes quiet.
  assert.match(D.renderPressNightBlock(snap, { nowMs: Date.parse('2026-11-01T11:30:00Z') }), /not checked yet \(the hourly check has not run since yesterday\)/);
  assert.equal(D.renderPressNightBlock({ night: '2026-10-29', lines: [] }, { nowMs: MORNING }), '');
});

// Owner decision 2026-10-30 ("Ignore NYT"): a hard-paywalled outlet passes once listed or queued.
// The real Heart record with its late and missing outlets renamed to paywalled ones.
// BRO-6652 (3b): the excuse needs the review queued by +2h, so a renamed paywalled "missing" outlet gets a
// review-text file first seen 30 min after the embargo (queued on time, text never live) unless neverQueued.
const heartAs = (late, missing, { neverQueued = false } = {}) => {
  const rec = JSON.parse(JSON.stringify(HEART()).replaceAll('"theater-pizzazz"', `"${late}"`).replaceAll('"is-something-of-a-miracle"', `"${missing}"`));
  if (D.PAYWALLED_OUTLETS.has(missing) && !neverQueued) {
    rec.fileState.files.push({ file: `${missing}--critic.json`, outletId: missing, outlet: null, critic: null, firstSeenAt: new Date(Date.parse(rec.embargoAt) + 30 * 60000).toISOString(), publishDate: '2026-10-29', includable: true, reason: null });
  }
  return rec;
};

test('paywall rule: a late NYT and a missing WSJ never fail the night or show as a miss', () => {
  const r = D.gradeReviews(heartAs('nytimes', 'wsj'), AFTER_DEADLINE);
  assert.notEqual(r.verdict, 'FAIL');
  const e = lineFor(heartAs('nytimes', 'wsj'), HEART_SHOW);
  // Named only in the two-part paywall sentence (BRO-6652), never as late or missing.
  assert.ok(!/(New York Times|Wall Street Journal)[^;.]*(went live|not live)/.test(e.line), e.line);
  assert.match(e.line, /The Wall Street Journal listed on time, text not scored by 3:55am/);
  assert.ok(!e.misses.some((m) => m.kind === 'review'), JSON.stringify(e.misses));
  assert.ok(!e.misses.some((m) => m.key === 'review:other'));
});

test('paywall rule: a non-paywalled miss on the same night still fails and is still named', () => {
  const e = lineFor(heartAs('nytimes', 'is-something-of-a-miracle'), HEART_SHOW);
  assert.equal(e.verdict, 'FAIL');
  assert.match(e.line, /Is Something Of A Miracle not live/);
  assert.ok(!/New York Times|nytimes/i.test(e.line), e.line);
  assert.deepEqual(e.misses.filter((m) => m.kind === 'review').map((m) => m.key), ['review:is-something-of-a-miracle:']);
});

test('paywall rule: the outlet list covers every hard-paywall domain', () => {
  for (const id of ['nytimes', 'newyorker', 'washpost', 'chicagotribune', 'wsj']) assert.ok(D.PAYWALLED_OUTLETS.has(id), id);
});

test('paywall rule: a coverage-2h failure from a non-paywalled census outlet is not excused', () => {
  const rec = heartAs('nytimes', 'wsj');
  const verdictWith = (missing) => {
    const r = JSON.parse(JSON.stringify(rec));
    r.reference = r.reference || {};
    r.reference['2h'] = { asOf: new Date(Date.parse(r.embargoAt) + 2 * 3600000).toISOString(), status: 'ok', count: 4, covered: 4 - missing.length, coverage: (4 - missing.length) / 4, missing, source: ['test'] };
    return D.gradeReviews(r, AFTER_DEADLINE).verdict;
  };
  assert.equal(verdictWith(['nytimes', 'theatermania', 'vulture']), 'FAIL');
  assert.notEqual(verdictWith(['nytimes', 'wsj']), 'FAIL');
  // BRO-6652 (3b): a paywalled outlet the aggregators list but we never queued is a miss.
  assert.equal(verdictWith(['nytimes', 'wsj', 'newyorker']), 'FAIL');
});

test('paywall rule: suppressed or listed-but-on-time non-paywalled census outlets still fail the night', () => {
  const base = heartAs('nytimes', 'wsj');
  const ref = base.reference && base.reference['2h'];
  assert.ok(ref, 'fixture has a +2h census');
  const withRef = (patch) => { const r = JSON.parse(JSON.stringify(base)); Object.assign(r.reference['2h'], patch); return D.gradeReviews(r, AFTER_DEADLINE).verdict; };
  assert.equal(withRef({ suppressedMissing: ['theatermania'] }), 'FAIL');
  assert.equal(withRef({ missing: [...(ref.missing || []), 'culturesauce'] }), 'FAIL');
});

test('paywall rule: a paywalled miss plus a stuck dropped review stays failed', () => {
  const r = heartAs('nytimes', 'wsj');
  r.dropped = [...(r.dropped || []), { outlet: 'NYSR', droppedAt: r.embargoAt }];
  assert.equal(D.gradeReviews(r, AFTER_DEADLINE).verdict, 'FAIL');
});

// ── BRO-6652: who published the night, hand fixes, queued and scored times ─────────────────────────────

const R = require(path.join(ROOT, 'scripts/lib/press-night-record.js'));
const laneNight = (rec) => { R.stampPublishedBy(rec, { standDown: true, reason: 'lane gha-9 holds the night', holder: 'gha-9' }, { checkedAt: '2026-10-30T05:02:00Z', label: '2h' }); return rec; };

test('path wording: a regular night and a lane night each name who published', () => {
  const live = { 'a-few-good-men-2026': { score: 60, reviewCount: 23 } };
  const opts = { sentShows: sentWithDraft(), redditDrafts: redditEmailed(60, 23), live };
  assert.match(lineFor(AFGM(), AFGM_SHOW, opts).line, /^A Few Good Men: published by the regular pipeline; /);
  assert.match(lineFor(laneNight(AFGM()), AFGM_SHOW, opts).line, /^A Few Good Men: published by the new lane; /);
  // A stamp that saw the old path on at both captures stays regular; one stand-down makes it a lane night.
  const rec = AFGM();
  R.stampPublishedBy(rec, { standDown: false, reason: 'no live lane lease' }, { checkedAt: 'a', label: '2h' });
  assert.equal(R.publishPath(rec), 'regular');
  R.stampPublishedBy(rec, { standDown: true, reason: 'lane x holds', holder: 'x' }, { checkedAt: 'b', label: 'end' });
  R.stampPublishedBy(rec, null, { checkedAt: 'c', label: 'end', error: 'lease file unreadable' });
  assert.deepEqual([R.publishPath(rec), rec.publishedBy.holder, rec.publishedBy.checks.length], ['lane', 'x', 3]);
});

test('lane night: a lane that discovered late keeps the assumed embargo (its own discovery is not the release)', () => {
  // Shadow night: the lane's 11:02pm discovery moves the release (BRO-6614).
  assert.equal(D.gradeReviews(AFGM(), AFTER_DEADLINE).release.observedFrom, 'lane-discovery');
  // Lane night, no outlet with a clock-time publish date: the assumed 10:00pm embargo stands.
  const lane = laneNight(AFGM());
  assert.equal(R.observedRelease(lane), null);
  const r = D.gradeReviews(lane, AFTER_DEADLINE);
  assert.equal(r.release, null);
  assert.equal(r.embargoAt, lane.embargoAt);
  assert.ok(!/reviews came out at/.test(lineFor(lane, AFGM_SHOW).line));
  // An outlet's own clock-time publish date still moves it.
  const exact = laneNight(AFGM());
  const p = exact.perReview.find((x) => x.outlet === 'Time Out New York');
  Object.assign(p, { publishAt: '2026-10-30T03:30:00.000Z', publishPrecision: 'exact', tier: 1 });
  assert.deepEqual(R.observedRelease(exact), { assumedAt: '2026-10-30T02:00:00.000Z', observedAt: '2026-10-30T03:30:00.000Z', lateMin: 90, observedFrom: 'outlet-publish' });
  // A review seen live before that publish time lowers it (first live only lowers, never sets alone).
  p.publishAt = '2026-10-30T03:50:00.000Z';
  assert.equal(R.observedRelease(exact).observedFrom, 'first-live');
});

test('paywall 3b: queued on time with the text missing is excused; the same outlet never queued is a miss', () => {
  const queued = heartAs('nytimes', 'wsj');
  assert.notEqual(D.gradeReviews(queued, AFTER_DEADLINE).verdict, 'FAIL');
  assert.ok(!lineFor(queued, HEART_SHOW).misses.some((m) => m.kind === 'review'));
  const never = heartAs('nytimes', 'wsj', { neverQueued: true });
  assert.equal(D.gradeReviews(never, AFTER_DEADLINE).verdict, 'FAIL');
  const e = lineFor(never, HEART_SHOW);
  assert.equal(e.verdict, 'FAIL');
  assert.match(e.line, /The Wall Street Journal not live by 3:55am/);
  assert.deepEqual(e.misses.filter((m) => m.kind === 'review').map((m) => m.key), ['review:wsj:']);
  // Queued after +2h is not on time either.
  const lateQ = heartAs('nytimes', 'wsj');
  lateQ.fileState.files.find((f) => f.outletId === 'wsj').firstSeenAt = '2026-10-30T04:30:00.000Z';
  assert.equal(D.gradeReviews(lateQ, AFTER_DEADLINE).verdict, 'FAIL');
  // On a lane night the lane's discovery counts as queued; on a shadow night it does not.
  const laneQ = heartAs('nytimes', 'wsj', { neverQueued: true });
  laneQ.laneShadow = { ...(laneQ.laneShadow || {}), discoveredByOutlet: { wsj: '2026-10-30T02:20:00.000Z' } };
  assert.equal(D.gradeReviews(laneQ, AFTER_DEADLINE).verdict, 'FAIL');
  assert.notEqual(D.gradeReviews(laneNight(laneQ), AFTER_DEADLINE).verdict, 'FAIL');
});

test('paywall 3b: the two-part sentence, listed on time then when the text was scored', () => {
  const rec = heartAs('nytimes', 'wsj');
  rec.fileState.files.find((f) => f.outletId === 'wsj').scoredAt = '2026-10-30T07:10:00.000Z';
  assert.match(lineFor(rec, HEART_SHOW).line, /The Wall Street Journal listed on time, text scored at 3:10am \(late\)/);
  rec.fileState.files.find((f) => f.outletId === 'wsj').scoredAt = '2026-10-30T03:10:00.000Z';
  assert.match(lineFor(rec, HEART_SHOW).line, /The Wall Street Journal listed on time, text scored at 11:10pm[;.]/);
  rec.fileState.files.find((f) => f.outletId === 'wsj').scoredAt = null;
  assert.match(lineFor(rec, HEART_SHOW).line, /The Wall Street Journal listed on time, text not scored by 3:55am/);
});

test('passed on their own: AFGM 10-29 (TheWrap hand-ingested 12:42am) never counts, even graded as a pass', () => {
  // The real record carries the hand fix (BRO-5955 comment 235dd1d8).
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/press-night/a-few-good-men-2026-2026-10-29.json'), 'utf8'));
  assert.deepEqual(real.manualActions.map((m) => [m.outletId, m.at]), [['thewrap', '2026-10-30T04:42:00.000Z']]);
  const pass = afgmOnTime();
  assert.equal(D.gradeReviews(pass, AFTER_DEADLINE).verdict, 'PASS');
  assert.deepEqual(D.scoreboard([{ showId: 'afgm', rec: pass }, { showId: 'heart', rec: HEART() }], AFTER_DEADLINE), { graded: 2, passed: 1, passedOnOwn: 0 });
  // The same pass with no hand fix logged counts; a record older than the stamp (no field) does not.
  const clean = afgmOnTime(); clean.manualActions = [];
  const legacy = afgmOnTime(); delete legacy.manualActions;
  assert.deepEqual(D.scoreboard([{ rec: clean }, { rec: legacy }], AFTER_DEADLINE), { graded: 2, passed: 2, passedOnOwn: 1 });
  // A fix logged outside the night window does not count against it.
  const outside = afgmOnTime(); outside.manualActions = [{ at: '2026-10-31T12:00:00Z', outletId: 'thewrap', kind: 'hand-fix' }];
  assert.deepEqual(D.scoreboard([{ rec: outside }], AFTER_DEADLINE).passedOnOwn, 1);
  // The email names the hand fix and the scoreboard line.
  assert.match(lineFor(pass, AFGM_SHOW).line, /TheWrap fixed by hand at 12:42am/);
  const html = D.renderPressNightBlock({ night: '2026-10-29', lines: [{ verdict: 'PASS', line: 'x' }], scoreboard: { graded: 5, passed: 2, passedOnOwn: 1 } }, { nowMs: MORNING });
  assert.match(html, /Press nights so far: 2 of 5 passed, 1 passed on their own \(no hand fixes\)\./);
});

test('manual action log: dedupes, sorts, refuses a bad time or no source; a new record starts with an empty list', () => {
  const rec = R.emptyRecord({ showId: 's', night: '2026-10-29', embargoAt: '2026-10-30T02:00:00Z' });
  assert.deepEqual(rec.manualActions, []);
  R.addManualAction(rec, { at: '2026-10-30T05:00:00Z', outletId: 'b', source: 'x' });
  R.addManualAction(rec, { at: '2026-10-30T04:00:00Z', outletId: 'a', source: 'x' });
  assert.equal(R.addManualAction(rec, { at: '2026-10-30T05:00:00.000Z', outletId: 'b', source: 'again' }).added, false);
  assert.deepEqual(rec.manualActions.map((m) => m.outletId), ['a', 'b']);
  assert.throws(() => R.addManualAction(rec, { at: 'soon', source: 'x' }), /ISO time/);
  assert.throws(() => R.addManualAction(rec, { at: '2026-10-30T04:00:00Z' }), /--source/);
});
