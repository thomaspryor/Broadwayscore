// BRO-4333: tests for the Reddit opening-post drafter's pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./reddit-opening-post.js');
const digest = require('../send-opening-digest.js');
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

test('digest subject leads with Reddit drafts and still classifies as the opening digest', () => {
  const sections = { needsHelp: [{}], broadcastReady: [], comingUp: [], redditPosts: [{}] };
  const subject = digest.buildSubject(sections);
  assert.match(subject, /^1 Reddit post ready · 1 needs help · /);
  assert.equal(classifySubject(subject).key, 'opening-digest');
});
