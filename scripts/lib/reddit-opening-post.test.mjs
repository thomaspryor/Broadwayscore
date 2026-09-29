// BRO-4333: tests for the Reddit opening-post drafter's pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./reddit-opening-post.js');
const mail = require('../send-reddit-post-email.js');
const { classifySubject } = require('./scheduled-email-count-rules.js');

function slim({ cs = 36.4, n = 10, buckets = ['Rave', 'Negative'] } = {}) {
  const rv = [];
  for (let i = 0; i < n; i++) {
    const b = buckets[i % buckets.length];
    rv.push({ o: `Outlet ${i}`, cn: `Critic ${i}`, s: b === 'Rave' ? 90 - i : 30 + i, b, t: i < 4 ? 1 : 3, q: `Quote number ${i} about the show and its cast.` });
  }
  return { id: 'x', cs, rc: n, rv, au: { score: 70, sources: { a: { c: 20 } } }, cn: { t: 'Critics blamed the format, not the cast.' } };
}

const show = { id: 'trainspotting-west-end-2026', slug: 'trainspotting-west-end', title: 'Trainspotting', category: 'west-end', openingDate: '2026-09-27', venue: 'Theatre Royal Haymarket', status: 'open' };

test('buildFacts uses the slim-file score and rank', () => {
  const peers = [60, 70, 80, 90].map((cs, i) => ({ id: `p${i}`, cs }));
  const f = lib.buildFacts(show, slim(), peers);
  assert.equal(f.score, 36);
  assert.equal(f.subreddit, 'TheWestEnd');
  assert.equal(f.url, 'https://westendscorecard.com/show/trainspotting-west-end');
  assert.match(f.rankNote, /^lowest critic score .* the West End$/);
  assert.equal(f.audienceGrade, 'B-');
});

test('selectCandidates respects age window, review minimum and OB cap', () => {
  const ob = n => ({ id: `ob${n}`, title: `OB ${n}`, category: 'off-broadway', openingDate: '2026-09-27' });
  const shows = [show, ob(1), ob(2), { ...show, id: 'old', openingDate: '2026-09-01' }, { ...show, id: 'bway', category: 'broadway' }];
  const slims = new Map([[show.id, slim()], ['ob1', slim({ n: 6 })], ['ob2', slim({ n: 6 })], ['old', slim()], ['bway', slim()]]);
  const picked = lib.selectCandidates({ shows, slims, drafts: { drafts: {} }, peersByMarket: {}, today: '2026-09-29' });
  const ids = picked.map(c => c.show.id);
  assert.ok(ids.includes(show.id));
  assert.equal(ids.filter(i => i.startsWith('ob')).length, 1, 'one Off-Broadway draft per run');
  assert.ok(!ids.includes('old') && !ids.includes('bway'));
  // Already drafted → skipped.
  const again = lib.selectCandidates({ shows, slims, drafts: { drafts: { [show.id]: {} } }, peersByMarket: {}, today: '2026-09-29' });
  assert.ok(!again.some(c => c.show.id === show.id));
  // Too few reviews → skipped.
  const thin = lib.selectCandidates({ shows: [show], slims: new Map([[show.id, slim({ n: 4 })]]), drafts: { drafts: {} }, peersByMarket: {}, today: '2026-09-29' });
  assert.equal(thin.length, 0);
});

test('lintDraft fixes dashes, adds the link, and refuses wrong facts', () => {
  const f = lib.buildFacts(show, slim(), []);
  const good = lib.lintDraft({ title: 'Reviews are in for Trainspotting — 36/100', body: 'Critics blamed "the format, not the cast." Anyone been?' }, f);
  assert.ok(good.ok, good.problems.join('; '));
  assert.ok(!/[—–]/.test(good.draft.title));
  assert.ok(good.draft.body.endsWith(f.url));

  assert.ok(!lib.lintDraft({ title: 'Trainspotting scores 41/100', body: 'x' }, f).ok, 'wrong score');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'It is 41/100 really' }, f).ok, 'wrong body score');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'The Times called it "a total mess of a night"' }, f).ok, 'invented quote');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'We saw it last week.' }, f).ok, 'fake personal experience');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'Let us delve in. #theatre' }, f).ok, 'AI tells / hashtags');
  assert.ok(lib.lintDraft({ title: '36/100, #2 of 20', body: 'ok' }, { ...f, reviewCount: 20 }).ok, '#2 is not a hashtag');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'ok', suggestedReply: 'Rankings also consider audience grade.' }, f).ok, 'made-up method in reply');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'ok', personalLines: ['Would love to hear more!'] }, f).ok, 'AI tell in personal line');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'Big night. The big talking point? Critics loved it.' }, f).ok, 'dramatic fragment');
  assert.ok(lib.lintDraft({ title: '36/100', body: 'Anyone seen it? The reviews are mixed.' }, f).ok, 'a real question to the sub is fine');
});

test('templateDraft always passes its own lint', () => {
  const f = lib.buildFacts(show, slim({ cs: 87.2 }), []);
  const t = lib.templateDraft(f);
  const r = lib.lintDraft(t, f);
  assert.ok(r.ok, r.problems.join('; '));
  assert.match(t.body, /an 87\/100/);
});

test('submitUrl pre-fills title and body', () => {
  const u = new URL(lib.submitUrl('TheWestEnd', 'T & t', 'Body\nline'));
  assert.equal(u.pathname, '/r/TheWestEnd/submit');
  assert.equal(u.searchParams.get('title'), 'T & t');
  assert.equal(u.searchParams.get('text'), 'Body\nline');
});

test('applyPostedDetection marks a draft posted from the owner\'s post history', () => {
  const drafts = { drafts: { a: { showTitle: 'Trainspotting', status: 'ready', createdAt: '2026-09-28T06:00:00Z' } } };
  const posts = [{ title: 'Reviews are in for Trainspotting the Musical. 36/100', created_utc: Date.parse('2026-09-28T12:00:00Z') / 1000, permalink: '/r/TheWestEnd/comments/abc/x/', subreddit: 'TheWestEnd', score: 95 }];
  const out = lib.applyPostedDetection(drafts, posts);
  assert.equal(out.drafts.a.status, 'posted');
  assert.equal(out.drafts.a.postedScore, 95);
  assert.equal(drafts.drafts.a.status, 'ready', 'input not mutated');
  // An old post about the same title (a previous production) doesn't count.
  const old = lib.applyPostedDetection(drafts, [{ ...posts[0], created_utc: Date.parse('2026-01-01T00:00:00Z') / 1000 }]);
  assert.equal(old.drafts.a.status, 'ready');
});

test('applyPostedDetection title match is whole-word and theater-sub only', () => {
  const drafts = { drafts: { r: { showTitle: 'Rent', status: 'ready', createdAt: '2026-09-28T06:00:00Z' } } };
  const at = Date.parse('2026-09-28T12:00:00Z') / 1000;
  const post = (title, subreddit = 'Broadway') => ({ title, subreddit, created_utc: at });
  assert.equal(lib.applyPostedDetection(drafts, [post('Lowest scoring show currently running')]).drafts.r.status, 'ready');
  assert.equal(lib.applyPostedDetection(drafts, [post('Rent scores 80 with critics', 'nyc')]).drafts.r.status, 'ready');
  assert.equal(lib.applyPostedDetection(drafts, [post('Rent scores 80 with critics')]).drafts.r.status, 'posted');
});

test('lintDraft refuses numbers and grades not in the fact sheet', () => {
  const f = lib.buildFacts(show, slim(), [60, 70, 80, 90].map((cs, i) => ({ id: `p${i}`, cs })));
  const bad = (title, body) => lib.lintDraft({ title, body }, f).ok === false;
  assert.ok(bad('36/100', '22 reviews in and it scored a 36/100.'), 'wrong review count');
  assert.ok(bad('36/100', 'Audiences give it a C+.'), 'wrong grade');
  assert.ok(bad('36/100', 'Critic Score of 9/100.'), 'single-digit wrong score');
  assert.ok(bad('36 percent of critics hated it, 36/100', 'x'), 'percent');
  assert.ok(!bad(`36/100 from ${f.reviewCount} reviews, the lowest in the West End`, `Audiences are at ${f.audienceGrade}. ${f.buckets.rave} raves.`));
  // Rank totals are allowed when the fact sheet has them.
  const g = lib.buildFacts(show, slim({ cs: 85 }), Array.from({ length: 24 }, (_, i) => ({ id: `q${i}`, cs: 50 + i })).concat([{ id: 'top', cs: 99 }]));
  assert.equal(g.rankPosition, 2);
  assert.ok(lib.lintDraft({ title: `Trainspotting scores 85/100, #2 of ${g.rankOf} West End shows`, body: 'ok' }, g).ok);
});

test('buildPeers: rank cohort only includes shows with a full review count', () => {
  const mk = (id, category, status) => ({ id, category, status });
  const shows = [mk('we-ok', 'west-end', 'open'), mk('we-thin', 'west-end', 'open'), mk('ob-thin', 'off-broadway', 'open'), mk('ob-ok', 'off-broadway', 'previews'), mk('ob-closed', 'off-broadway', 'closed')];
  const slims = new Map([['we-ok', slim({ n: 8 })], ['we-thin', slim({ n: 7 })], ['ob-thin', slim({ n: 3 })], ['ob-ok', slim({ n: 5 })], ['ob-closed', slim({ n: 20 })]]);
  const p = lib.buildPeers(shows, slims);
  assert.deepEqual((p['west-end'] || []).map(x => x.id), ['we-ok']);
  assert.deepEqual((p['off-broadway'] || []).map(x => x.id), ['ob-ok']);
});

test('lintDraft: small wrong numbers are refused even if some digit elsewhere matches', () => {
  const f = lib.buildFacts(show, slim(), []);
  const ok = (body) => lib.lintDraft({ title: '36/100', body }, f).ok;
  assert.ok(!ok('Only 4 critics liked it.'), '4 is not a count in the fact sheet');
  assert.ok(ok(`It opened on the ${Number(f.openingDate.slice(8, 10))}th.`), 'the opening day is allowed');
  assert.ok(ok(`${f.buckets.rave} raves and ${f.buckets.negative} pans.`));
});

test('applyPostedDetection matches a shortened title via the show-page link', () => {
  const drafts = { drafts: { r: { showTitle: 'The Rocky Horror Show', url: 'https://broadwayscorecard.com/show/rocky-horror-show', status: 'ready', createdAt: '2026-09-28T06:00:00Z' } } };
  const post = { title: 'Rocky Horror gets a 69', selftext: 'blah [link](http://broadwayscorecard.com/show/rocky-horror-show)', created_utc: Date.parse('2026-09-28T12:00:00Z') / 1000 };
  assert.equal(lib.applyPostedDetection(drafts, [post]).drafts.r.status, 'posted');
  assert.equal(lib.applyPostedDetection(drafts, [{ ...post, selftext: 'no link' }]).drafts.r.status, 'ready');
});

test('a template draft made after an LLM error is re-drafted next run', () => {
  const shows = [show];
  const slims = new Map([[show.id, slim()]]);
  const base = { status: 'ready', source: 'template' };
  const pick = d => lib.selectCandidates({ shows, slims, drafts: { drafts: { [show.id]: d } }, peersByMarket: {}, today: '2026-09-29' }).length;
  assert.equal(pick({ ...base, lintProblems: ['llm error: 529 overloaded'] }), 1);
  assert.equal(pick({ ...base, lintProblems: ['title does not state the score 36'] }), 0);
  assert.equal(pick({ ...base, status: 'posted', lintProblems: ['llm error: x'] }), 0);
});

test('pickRecentExamples takes his recent top roundup posts, newest window first', () => {
  const now = Date.parse('2026-09-29T00:00:00Z');
  const day = 86400;
  const body = 'x'.repeat(200);
  const posts = [
    { title: 'CATS scores 88/100', selftext: body, subreddit: 'Broadway', score: 575, created_utc: now / 1000 - 170 * day },
    { title: 'Reviews are in for Trainspotting. 36/100', selftext: body, subreddit: 'TheWestEnd', score: 95, created_utc: now / 1000 - 67 * day },
    { title: 'Paranormal Activity scores 79/100', selftext: body, subreddit: 'Broadway', score: 15, created_utc: now / 1000 - 34 * day },
    { title: 'What is my CQS', selftext: body, subreddit: 'WhatIsMyCQS', score: 1, created_utc: now / 1000 - 10 * day },
    { title: 'Scores are in 70/100', selftext: 'short', subreddit: 'Broadway', score: 50, created_utc: now / 1000 - 5 * day },
  ];
  const ex = lib.pickRecentExamples(posts, { nowMs: now, maxAgeDays: 120 });
  assert.deepEqual(ex.map(e => e.upvotes), [95, 15], 'old, off-topic and bodiless posts excluded; best first');
  assert.match(lib.buildUserPrompt(lib.buildFacts(show, slim(), []), ex), /HIS MOST RECENT WELL-RECEIVED POSTS[\s\S]*Trainspotting/);
});

test('activeDrafts hides posted and stale drafts', () => {
  const now = Date.parse('2026-09-29T11:00:00Z');
  const d = { drafts: {
    a: { status: 'ready', createdAt: '2026-09-29T06:00:00Z' },
    b: { status: 'posted', createdAt: '2026-09-29T06:00:00Z' },
    c: { status: 'ready', createdAt: '2026-09-20T06:00:00Z' },
  } };
  assert.deepEqual(lib.activeDrafts(d, now).map(x => x.createdAt), ['2026-09-29T06:00:00Z']);
  assert.deepEqual(lib.activeDrafts(null, now), []);
});

test('reddit email: one new email per complete draft, one reminder after 20h, then nothing', () => {
  const now = Date.parse('2026-09-30T06:00:00Z');
  const base = { status: 'ready', title: '<script>x</script> 36/100', body: 'b', subreddit: 'TheWestEnd', submitUrl: 'https://www.reddit.com/r/TheWestEnd/submit?a=1&b=2', showTitle: 'Trainspotting', score: 36, reviewCount: 9 };
  const drafts = { drafts: {
    fresh: { ...base, showId: 'fresh', createdAt: '2026-09-30T05:59:00Z' },
    remind: { ...base, showId: 'remind', createdAt: '2026-09-29T06:00:00Z', emailedAt: '2026-09-29T06:01:00Z' },
    tooSoon: { ...base, showId: 'tooSoon', createdAt: '2026-09-29T20:00:00Z', emailedAt: '2026-09-29T20:00:00Z' },
    done: { ...base, showId: 'done', createdAt: '2026-09-28T06:00:00Z', emailedAt: '2026-09-28T06:00:00Z', reminderAt: '2026-09-29T06:00:00Z' },
    posted: { ...base, showId: 'posted', status: 'posted', createdAt: '2026-09-30T05:00:00Z' },
    stale: { ...base, showId: 'stale', createdAt: '2026-09-20T06:00:00Z' },
    broken: { status: 'ready', showId: 'broken', createdAt: '2026-09-30T05:00:00Z' },
  } };
  const due = mail.dueEmails(drafts, now).map(x => `${x.draft.showId}:${x.kind}`).sort();
  assert.deepEqual(due, ['fresh:new', 'remind:reminder']);
  assert.deepEqual(mail.dueEmails(null, now), []);
  const html = mail.buildHtml(drafts.drafts.fresh, 'new');
  assert.ok(!html.includes('<script>'), 'LLM text is escaped');
  assert.ok(html.includes('submit?a=1&amp;b=2'));
});

test('reddit email subjects classify as their own sender, not the opening digest', () => {
  const d = { showTitle: 'Delirium', score: 87, subreddit: 'Broadway' };
  assert.equal(mail.buildSubject(d, 'new'), 'Reddit post ready: Delirium (87/100) for r/Broadway');
  assert.equal(classifySubject(mail.buildSubject(d, 'new')).key, 'reddit-post-ready');
  assert.equal(classifySubject(mail.buildSubject(d, 'reminder')).key, 'reddit-post-ready');
});
