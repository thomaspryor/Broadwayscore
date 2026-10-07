// BRO-4333: tests for the Reddit opening-post drafter's pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./reddit-opening-post.js');
const mail = require('./reddit-post-email.js');
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
  const good = lib.lintDraft({ title: 'Reviews are in for Trainspotting — 36/100', body: 'Outlet 0 called it "quote number 0 about the show." Anyone been?' }, f);
  assert.ok(good.ok, good.problems.join('; '));
  assert.ok(!/[—–]/.test(good.draft.title));
  assert.ok(good.draft.body.endsWith(f.url));

  assert.ok(!lib.lintDraft({ title: 'Trainspotting scores 41/100', body: 'x' }, f).ok, 'wrong score');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'It is 41/100 really' }, f).ok, 'wrong body score');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'The Times called it "a total mess of a night"' }, f).ok, 'invented quote');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'We saw it last week.' }, f).ok, 'fake personal experience');
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'Let us delve in. #theatre' }, f).ok, 'AI tells / hashtags');
  assert.ok(lib.lintDraft({ title: '36/100, #2 of 20', body: 'ok' }, { ...f, rankNote: '#2 of 20 West End shows currently running', rankPosition: 2, rankOf: 20 }).ok, '#2 is not a hashtag');
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
  const drafts = { drafts: { a: { showTitle: 'Trainspotting', subreddit: 'TheWestEnd', status: 'ready', createdAt: '2026-09-28T06:00:00Z' } } };
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
  const drafts = { drafts: { r: { showTitle: 'Rent', subreddit: 'Broadway', status: 'ready', createdAt: '2026-09-28T06:00:00Z' } } };
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
  const shows = [mk('we-ok', 'west-end', 'open'), mk('we-thin', 'west-end', 'open'), mk('ob-thin', 'off-broadway', 'open'), mk('ob-ok', 'off-broadway', 'open'), mk('ob-previews', 'off-broadway', 'previews'), mk('ob-closed', 'off-broadway', 'closed')];
  const slims = new Map([['we-ok', slim({ n: 8 })], ['we-thin', slim({ n: 7 })], ['ob-thin', slim({ n: 3 })], ['ob-ok', slim({ n: 5 })], ['ob-previews', slim({ n: 20 })], ['ob-closed', slim({ n: 20 })]]);
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

test('lintDraft catches the ship-check bad-draft set (BRO-4360)', () => {
  // slim(): 10 reviews alternating Rave/Negative -> 5 raves, 5 negative; quotes "Quote number N about the show and its cast." from "Outlet N".
  const f = lib.buildFacts(show, slim(), [60, 70, 80, 90].map((cs, i) => ({ id: `p${i}`, cs })));
  const bad = (body, extra = {}) => !lib.lintDraft({ title: '36/100', body, ...extra }, f).ok;
  const good = (body, extra = {}) => lib.lintDraft({ title: '36/100', body, ...extra }, f).ok;
  // quotes
  assert.ok(bad("Outlet 0 called it 'utterly dreadful stuff'."), 'single-quoted fake');
  assert.ok(bad('Outlet 0 called it ‘utterly dreadful stuff’.'), 'curly single fake');
  assert.ok(bad('Outlet 0 called it *utterly dreadful stuff*.'), 'italic fake');
  assert.ok(bad('Outlet 0 said "utterly dreadful".'), 'two-word fake');
  assert.ok(bad('x', { title: 'Critics say "utterly dreadful", 36/100' }), 'fake quote in title');
  assert.ok(bad('The Guardian said "quote number 0 about the show".'), 'real quote, wrong outlet');
  assert.ok(bad('Outlet 0 said "blamed the format".'), 'consensus is not a critic quote');
  assert.ok(good('Outlet 0 said "quote number 0 about the show".'), 'real quote, right outlet');
  assert.ok(good("It's the show's big night and they're thrilled."), 'apostrophes are not quotes');
  // numbers tied to what they count
  assert.ok(bad('24 raves and 5 negative.'), '24 raves (24 is only the opening day)');
  assert.ok(bad('Twelve raves and five pans.'), 'word numbers are checked');
  assert.ok(bad('It has 90 reviews.'), 'a quote score is not a review count');
  assert.ok(good('Five raves, five pans, 10 reviews.'), 'correct word/digit counts');
  // grades without +/-
  assert.ok(bad('Audiences give it a B.'), 'plain B grade (fact sheet: B-)');
  assert.ok(bad('Audiences give it an F.'), 'plain F grade');
  assert.ok(good('A strange night. Audiences are at a B- so far.'), 'correct grade; sentence-initial article A is fine');
  // rank claims need a rank
  const noRank = lib.buildFacts(show, slim(), []);
  assert.ok(!lib.lintDraft({ title: '36/100', body: 'The lowest-rated show in the West End right now.' }, noRank).ok, 'superlative with no rank');
  // reply and personal lines get the same checks
  assert.ok(bad('ok', { suggestedReply: 'It got 42 reviews and a B+.' }), 'wrong facts in the reply');
  assert.ok(bad('ok', { personalLines: ["I've seen it twice."] }), "I've seen it without history");
  assert.ok(good('ok', { personalLines: ["[if true] We've seen it twice."] }), 'explicit [if true] option is allowed');
  assert.ok(bad('ok', { personalLines: ['We saw it last week.'] }), 'unmarked seen claim in a personal line');
});

test('rank ties on the rounded score block rank claims', () => {
  const tied = lib.buildFacts(show, slim({ cs: 89.9 }), [{ id: 'm', cs: 89.8 }, ...[50, 60, 70, 80].map((cs, i) => ({ id: `p${i}`, cs }))]);
  assert.equal(tied.rankNote, null, '89.9 and 89.8 both show as 90');
  const clear = lib.buildFacts(show, slim({ cs: 91 }), [{ id: 'm', cs: 89.8 }, ...[50, 60, 70, 80].map((cs, i) => ({ id: `p${i}`, cs }))]);
  assert.match(clear.rankNote, /^highest/);
});

test('templateDraft skips a consensus that would fail the checks', () => {
  const s2 = slim(); s2.cn = { t: "Sting's passion project dazzles." };
  const f = lib.buildFacts(show, s2, []);
  const t = lib.templateDraft(f);
  assert.ok(!/passion project/.test(t.body));
  assert.ok(lib.lintDraft(t, f).ok, lib.lintDraft(t, f).problems.join('; '));
});

test('posted detection: exact slug, same subreddit, removed posts ignored', () => {
  const at = Date.parse('2026-09-28T12:00:00Z') / 1000;
  const d = { showTitle: 'Kimberly Akimbo', subreddit: 'TheWestEnd', url: 'https://westendscorecard.com/show/kimberly-akimbo-west-end', status: 'ready', createdAt: '2026-09-28T06:00:00Z' };
  const run = post => lib.applyPostedDetection({ drafts: { k: d } }, [{ created_utc: at, ...post }]).drafts.k.status;
  assert.equal(run({ title: 'Kimberly Akimbo scores 84', subreddit: 'Broadway' }), 'ready', 'Broadway post about the Broadway production');
  assert.equal(run({ title: 'x', selftext: 'see broadwayscorecard.com/show/kimberly-akimbo-west-end-2019' }), 'ready', 'slug prefix of a longer slug');
  assert.equal(run({ title: 'Kimberly Akimbo 84/100', subreddit: 'TheWestEnd', removed_by_category: 'automod_filtered' }), 'ready', 'removed post');
  assert.equal(run({ title: 'x', subreddit: 'Broadway', selftext: 'westendscorecard.com/show/kimberly-akimbo-west-end.' }), 'posted', 'crosspost that links the page');
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
  assert.equal(pick({ ...base, lintProblems: ['title does not state the score 36'], emailedAt: '2026-09-29T06:00:00Z' }), 1, 'emailed, reminder not sent: refreshed (BRO-4597)');
  assert.equal(pick({ ...base, lintProblems: ['title does not state the score 36'], emailedAt: '2026-09-29T06:00:00Z', reminderAt: '2026-09-30T06:00:00Z' }), 0, 'reminder already sent: left alone');
  assert.equal(pick({ ...base, status: 'posted', lintProblems: ['llm error: x'] }), 0);
});

test('an unsent draft is redrafted when its numbers go stale, kept when still accurate', () => {
  const shows = [show];
  const slims = new Map([[show.id, slim()]]);
  const f = lib.buildFacts(show, slim(), []);
  const pick = d => lib.selectCandidates({ shows, slims, drafts: { drafts: { [show.id]: d } }, peersByMarket: {}, today: '2026-09-29' }).length;
  const accurate = { status: 'ready', source: 'claude', subreddit: 'TheWestEnd', title: `Trainspotting scores ${f.score}/100`, body: `${f.reviewCount} reviews.` };
  assert.equal(pick(accurate), 0, 'still matches today');
  assert.equal(pick({ ...accurate, body: `${f.reviewCount - 1} reviews, ${f.buckets.rave + 1} raves.` }), 1, 'counts moved: redraft');
  assert.equal(pick({ ...accurate, body: 'Now #3 of 24 shows.' }), 1, 'stale rank: redraft');
  assert.equal(pick({ ...accurate, body: 'Now #3 of 24 shows.', emailedAt: '2026-09-29T06:00:00Z' }), 1, 'emailed but unposted: refreshed before the reminder');
  assert.equal(pick({ ...accurate, emailedAt: '2026-09-29T06:00:00Z' }), 0, 'emailed and still accurate: kept');
  assert.equal(pick({ ...accurate, body: 'Now #3 of 24 shows.', emailedAt: '2026-09-29T06:00:00Z', reminderAt: '2026-09-30T06:00:00Z' }), 0, 'reminder sent: never redrafted');
});

test('pickRecentExamples takes the owner recent top roundup posts, newest window first', () => {
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
  assert.match(lib.buildUserPrompt(lib.buildFacts(show, slim(), []), ex), /TOM'S MOST RECENT WELL-RECEIVED POSTS[\s\S]*Trainspotting/);
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

test('resend: listed unposted drafts go out again whatever their age; posted, missing, broken never do', () => {
  const base = { status: 'ready', title: 't', body: 'b', subreddit: 'Broadway', submitUrl: 'https://a', showTitle: 'X', score: 80 };
  const drafts = { drafts: {
    old: { ...base, showId: 'old', createdAt: '2026-09-20T06:00:00Z', emailedAt: '2026-09-20T06:01:00Z', reminderAt: '2026-09-21T06:00:00Z' },
    posted: { ...base, showId: 'posted', status: 'posted' },
    broken: { status: 'ready', showId: 'broken' },
  } };
  const r = mail.resendEmails(drafts, ['old', 'old', 'posted', 'gone', 'broken']);
  assert.deepEqual(r.due.map(x => `${x.draft.showId}:${x.kind}`), ['old:new'], 'once, as a fresh email');
  assert.deepEqual(r.skipped.map(x => `${x.showId}:${x.reason}`), ['posted:already posted', 'gone:no draft', 'broken:incomplete draft']);
  assert.deepEqual(mail.resendEmails(null, ['a']).due, []);
});

test('forceShowId takes several shows at once ("a,b" or an array)', () => {
  const shows = ['s1', 's2', 's3'].map(id => ({ id, title: id, category: 'west-end', openingDate: '2026-09-27', status: 'open' }));
  const slims = new Map(shows.map(x => [x.id, slim({ cs: 80, n: 30 })]));
  const ids = f => lib.selectCandidates({ shows, slims, drafts: { drafts: {} }, peersByMarket: {}, today: '2026-09-29', forceShowId: f }).map(c => c.show.id).sort();
  assert.deepEqual(ids('s1, s3'), ['s1', 's3']);
  assert.deepEqual(ids(['s2']), ['s2']);
  assert.deepEqual(ids('s2'), ['s2']);
});

test('a redraft that fell back to the template never replaces an unposted voiced draft', () => {
  assert.equal(lib.keepPreviousDraft({ status: 'ready', source: 'claude-sonnet-5-5' }, 'template'), true);
  assert.equal(lib.keepPreviousDraft({ status: 'ready', source: 'claude-sonnet-5-5' }, 'gpt-5.4'), false, 'a new voiced draft wins');
  assert.equal(lib.keepPreviousDraft({ status: 'ready', source: 'template' }, 'template'), false, 'template over template is fine (fresh numbers)');
  assert.equal(lib.keepPreviousDraft(undefined, 'template'), false, 'a first draft always saves');
});

test('reddit email subjects classify as their own sender, not the opening digest', () => {
  const d = { showTitle: 'Delirium', score: 87, subreddit: 'Broadway' };
  assert.equal(mail.buildSubject(d, 'new'), 'Reddit post ready: Delirium (87/100) for r/Broadway');
  assert.equal(classifySubject(mail.buildSubject(d, 'new')).key, 'reddit-post-ready');
  assert.equal(classifySubject(mail.buildSubject(d, 'reminder')).key, 'reddit-post-ready');
});

test('crosspost: West End shows with a current/recent Broadway production also get r/Broadway', () => {
  const we = { id: 'ka-we', title: 'Kimberly Akimbo', category: 'off-west-end', openingDate: '2026-09-27', status: 'open' };
  const old = { id: 'ayli-we', title: 'As You Like It', category: 'west-end', openingDate: '2026-09-27', status: 'open' };
  const ob = { id: 'x-ob', title: 'Kimberly Akimbo', category: 'off-broadway', openingDate: '2026-09-27', status: 'open' };
  const shows = [we, old, ob,
    { id: 'ka-bw', title: 'Kimberly Akimbo', category: 'broadway', openingDate: '2022-11-10', status: 'closed' },
    { id: 'ayli-bw', title: 'As You Like It', category: 'broadway', openingDate: '1974-12-03', status: 'closed' }];
  const slims = new Map(shows.map(x => [x.id, slim({ cs: 80, n: 30 })]));
  const pick = id => lib.selectCandidates({ shows, slims, drafts: { drafts: {} }, peersByMarket: {}, today: '2026-09-29', forceShowId: id })[0].facts;
  assert.equal(pick('ka-we').crosspostSubreddit, 'Broadway');
  assert.equal(pick('ayli-we').crosspostSubreddit, null, 'a 1974 Broadway revival is not a reason');
  assert.equal(pick('x-ob').subreddit, 'offbroadwayNYC', 'Off-Broadway goes to r/offbroadwayNYC');
  assert.equal(pick('x-ob').crosspostSubreddit, 'Broadway', 'with r/Broadway as the second button');
  const html = mail.buildHtml({ showTitle: 'Kimberly Akimbo', score: 80, reviewCount: 30, subreddit: 'TheWestEnd', title: 't', body: 'b', submitUrl: 'https://a', oldRedditSubmitUrl: 'https://b', crosspostSubreddit: 'Broadway', crosspostSubmitUrl: 'https://c' }, 'new');
  assert.match(html, /Also post to r\/Broadway/);
});

test('an unsent draft aimed at the old subreddit is redrafted; a crosspost counts as posted', () => {
  const ob = { id: 'ob1', title: 'Delirium', category: 'off-broadway', openingDate: '2026-09-27', status: 'open' };
  const slims = new Map([['ob1', slim({ cs: 87, n: 7 })]]);
  const f = lib.buildFacts(ob, slim({ cs: 87, n: 7 }), []);
  const accurate = { status: 'ready', source: 'claude', title: `Delirium scores ${f.score}/100`, body: `${f.reviewCount} reviews.` };
  const pick = d => lib.selectCandidates({ shows: [ob], slims, drafts: { drafts: { ob1: d } }, peersByMarket: {}, today: '2026-09-29' }).length;
  assert.equal(pick({ ...accurate, subreddit: 'offbroadwayNYC' }), 0);
  assert.equal(pick({ ...accurate, subreddit: 'Broadway' }), 1, 'old target: redraft');
  const d = { showTitle: 'Delirium', subreddit: 'offbroadwayNYC', crosspostSubreddit: 'Broadway', status: 'ready', createdAt: '2026-09-28T06:00:00Z' };
  const out = lib.applyPostedDetection({ drafts: { ob1: d } }, [{ title: 'Delirium scores 87/100', subreddit: 'Broadway', created_utc: Date.parse('2026-09-28T12:00:00Z') / 1000 }]);
  assert.equal(out.drafts.ob1.status, 'posted');
  const html = mail.buildHtml({ ...d, market: 'off-broadway', score: 87, reviewCount: 7, title: 't', body: 'b', submitUrl: 'https://a', oldRedditSubmitUrl: 'https://b', crosspostSubmitUrl: 'https://c' }, 'new');
  assert.match(html, /r\/offbroadwayNYC/);
  assert.match(html, /Also post to r\/Broadway/);
});

// BRO-4597: the owner rewrote the first two drafts in first person ("I found
// 11 reviews"), with the count in the title, the audience sites named and a
// line about whether he has seen it. The template now writes that way.
test('templateDraft speaks as the person who collected the reviews', () => {
  const s = slim({ cs: 84.2, n: 11 });
  s.au = { score: 85, sources: { mz: { c: 12 }, sp: { c: 40 }, rd: { c: 3 }, ss: { c: 0 } } };
  const f = lib.buildFacts(show, s, []);
  assert.deepEqual(f.audienceSources, ['Seatplan', 'Mezzanine', 'Reddit'], 'biggest first, empty sources dropped');
  const t = lib.templateDraft(f);
  assert.match(t.title, /^11 reviews are in for Trainspotting\. 84\/100/);
  assert.match(t.body, /I found 11 reviews: /);
  assert.match(t.body, /\(across Seatplan, Mezzanine, and Reddit\)/);
  assert.match(t.body, /I haven't seen it yet\./);
  assert.ok(!/That's a \d+\/100 for/.test(t.body), 'no detached analyst line');
  assert.equal(t.personalLines.length, 2);
  const r = lib.lintDraft(t, f);
  assert.ok(r.ok, r.problems.join('; '));
});

test('templateDraft closer follows the shows-seen list, never claims more', () => {
  const seen = lib.buildFacts(show, slim(), [], { seen: { seen: true, rating: 4, upcomingDate: null } });
  const tix = lib.buildFacts(show, slim(), [], { seen: { seen: false, rating: null, upcomingDate: '2026-10-20' } });
  assert.equal(seen.ownerStance, 'seen');
  assert.equal(tix.ownerStance, 'has-tickets');
  assert.match(lib.templateDraft(seen).body, /I saw this one\./);
  assert.match(lib.templateDraft(tix).body, /I've got tickets/);
  assert.deepEqual(lib.templateDraft(seen).personalLines, []);
  const q = lib.buildFacts({ ...show, title: "Who's Afraid of Virginia Woolf?" }, slim(), []);
  assert.match(lib.templateDraft(q).title, /Woolf\? \d+\/100/, 'no "Woolf?." double stop');
  for (const f of [seen, tix]) { const r = lib.lintDraft(lib.templateDraft(f), f); assert.ok(r.ok, r.problems.join('; ')); }
});

test('no audience grade: the template says why instead of a grade', () => {
  const s = slim();
  s.au = { sources: {} };
  const f = lib.buildFacts(show, s, []);
  assert.equal(f.audienceGrade, null);
  assert.match(lib.templateDraft(f).body, /No audience grade yet, since hardly any users have reviewed it/);
});

test('audienceSourceNames and ownerStance edge cases', () => {
  assert.deepEqual(lib.audienceSourceNames(null), []);
  assert.deepEqual(lib.audienceSourceNames({ sources: { zz: { c: 9 }, lb: { c: 2 } } }), ['London Box Office'], 'unknown keys dropped');
  assert.equal(lib.ownerStance(null), 'not-seen');
  assert.equal(lib.ownerStance({ seen: false, upcomingDate: null }), 'not-seen');
});

test('a refresh never takes a new opening\'s slot', () => {
  const mk = id => ({ ...show, id, slug: id, title: id });
  const shows = ['big', 'n1', 'n2'].map(mk);
  const slims = new Map([['big', slim({ cs: 95, n: 30 })], ['n1', slim({ n: 9 })], ['n2', slim({ n: 9 })]]);
  const stale = { status: 'ready', source: 'claude', subreddit: 'TheWestEnd', title: 'big 12/100', body: 'old', emailedAt: '2026-09-28T06:00:00Z' };
  const picked = lib.selectCandidates({ shows, slims, drafts: { drafts: { big: stale } }, peersByMarket: {}, today: '2026-09-29' }).map(c => c.show.id);
  assert.deepEqual(picked.sort(), ['n1', 'n2'], 'two new openings fill the run; the refresh waits');
});

test('the style guide carries both of the owner\'s hand-edited posts', () => {
  assert.match(lib.STYLE_GUIDE, /THE VOICE TOM WANTS/);
  assert.match(lib.STYLE_GUIDE, /Who's Afraid of Virginia Woolf\? 84\/100 from 24 critics/);
  assert.match(lib.STYLE_GUIDE, /11 reviews are in for Creation Stories/);
});

test('reddit email: screenshots section and refreshed-numbers note', () => {
  const d = { status: 'ready', title: 't 36/100', body: 'b', subreddit: 'TheWestEnd', submitUrl: 'https://www.reddit.com/r/TheWestEnd/submit', showTitle: 'Trainspotting', score: 38, reviewCount: 12, refreshedAt: '2026-09-30T06:00:00Z', previousReviewCount: 9, previousScore: 36 };
  const noImg = mail.buildHtml(d, 'new');
  assert.ok(!noImg.includes('cid:'), 'no image section without images');
  const html = mail.buildHtml(d, 'reminder', [{ cid: 'shot1', label: 'Score card' }, { cid: 'shot2', label: 'Critic reviews' }]);
  assert.ok(html.includes('src="cid:shot1"') && html.includes('src="cid:shot2"'));
  assert.match(html, /phone width/);
  assert.match(html, /now 12 reviews and 38\/100 \(was 9 and 36\)/);
  const same = mail.buildHtml({ ...d, previousReviewCount: 12, previousScore: 38 }, 'reminder');
  assert.ok(!/updated them/.test(same), 'no update note when nothing moved');
  const unknown = mail.buildHtml({ ...d, previousReviewCount: undefined }, 'reminder');
  assert.ok(!/undefined/.test(unknown) && !/updated them/.test(unknown), 'no note without the old numbers');
});
