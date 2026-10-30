// BRO-6377: Social section of the Monday traffic email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSocialReport, normalizeMetrics, attributeVisits, buildPostRows, monthlySuggestion, suggestedReply, skippedShows, upcomingPosts, postingTimeAdvice, gateWords, plainReason, showInCaption } = require('./social-report.js');
const { scoreDecision, findScoreEvents } = require('../social-autopost/select.js');
const { socialHtml, loadSocialSection } = require('./traffic-report-email.js');
const { writeLedger } = require('../social-autopost/run.js');

const NOW = Date.parse('2026-11-02T09:30:00Z'); // a first Monday of the month
const m = (o) => Object.entries(o).map(([type, value]) => ({ type, value }));
const ledger = {
  posts: [
    { type: 'score', date: '2026-11-01', showId: 'x', skipped: 'backlog at go-live' },
    {
      type: 'score', showId: 'invalid-2026', slug: 'the-imaginary-invalid', title: 'The Imaginary Invalid',
      text: "... a Critic Score of 67 (Worth Seeing) from 20 critics' reviews.",
      channels: { threads: { postId: 't1', link: 'https://threads/t1' }, instagram: { postId: 'i1' }, bluesky: { postId: 'b1' } },
    },
  ],
};
const buffer = [
  { id: 't1', service: 'threads', sentAt: '2026-10-30T17:00:00Z', text: 'x\nhttps://broadwayscorecard.com/show/the-imaginary-invalid?utm_source=threads', metrics: m({ views: 10, reactions: 1, comments: 2 }) },
  { id: 'i1', service: 'instagram', sentAt: '2026-10-30T17:00:00Z', externalLink: 'https://ig/i1', text: 'link in bio', metrics: m({ views: 50, reach: 20, reactions: 3, saves: 1 }) },
  { id: 'b1', service: 'bluesky', sentAt: '2026-10-30T17:00:00Z', text: 'x', metrics: m({ reactions: 0, comments: 0, reposts: 0 }) },
  { id: 'v1', service: 'youtube', sentAt: '2026-10-31T16:00:00Z', isVideo: true, text: "Here's how we score a show.", metrics: m({ views: 0 }) },
];

test('normalizeMetrics: views fall back to impressions; Bluesky has none', () => {
  assert.deepEqual(normalizeMetrics(m({ impressions: 7, clicks: 2, reactions: 1, shares: 1 })), { views: 7, interactions: 2, clicks: 2, comments: 0 });
  assert.equal(normalizeMetrics(m({ reactions: 0, reposts: 0 })).views, null);
});

test('lanes come from the ledger, hand-posted videos from the asset type', () => {
  const rows = buildPostRows(buffer, ledger);
  assert.deepEqual(rows.map((r) => r.lane), ['score', 'score', 'score', 'video']);
  assert.equal(rows[0].reviewCount, 20);
  assert.equal(rows[0].link, 'https://threads/t1');
});

test('a West End account set (ledger key service@set) still matches and keeps its link', () => {
  const we = { posts: [{ type: 'score', slug: 'x', title: 'X', channels: { 'threads@westend': { postId: 'w1', link: 'https://threads/w1' } } }] };
  const [row] = buildPostRows([{ id: 'w1', service: 'threads', sentAt: '2026-10-30T17:00:00Z', text: '', metrics: [] }], we);
  assert.equal(row.lane, 'score');
  assert.equal(row.link, 'https://threads/w1');
});

test('same-day visits count; Instagram gets clicks through the bio page; a visit before the post does not', () => {
  const rows = buildPostRows(buffer, ledger);
  const unmatched = attributeVisits(rows, {
    utmRows: [
      { source: 'threads', path: '/show/the-imaginary-invalid', day: '2026-10-30', views: 2 },
      { source: 'threads', path: '/show/the-imaginary-invalid', day: '2026-10-29', views: 5 },
    ],
    bioRows: [
      { source: 'instagram', path: '/show/the-imaginary-invalid', day: '2026-10-31', views: 3 },
      { source: 'none', path: '/show/the-imaginary-invalid', day: '2026-10-31', views: 1 },
    ],
  });
  assert.equal(rows.find((r) => r.id === 't1').visits, 2);
  assert.equal(rows.find((r) => r.id === 'i1').visits, 3);
  assert.equal(unmatched, 6); // the early visit + the untagged bio click
});

test('report: best by visits, worst only among settled posts, comments carry a reply, monthly on day <= 7', () => {
  const r = buildSocialReport({ bufferPosts: buffer, ledger, utmRows: [], bioRows: [{ source: 'instagram', path: '/show/the-imaginary-invalid', day: '2026-10-30', views: 4 }], now: NOW });
  assert.equal(r.weekly.best.id, 'i1');
  assert.ok(r.weekly.worst && r.weekly.worst.id !== 'i1');
  assert.equal(r.weekly.comments.length, 1);
  assert.match(r.weekly.comments[0].suggestedReply, /all 20 critic reviews/);
  assert.match(r.weekly.takeaway, /4 site visits, most from Instagram/);
  assert.ok(r.monthly && r.monthly.lines.length);
  assert.equal(buildSocialReport({ bufferPosts: buffer, ledger, now: Date.parse('2026-11-09T09:30:00Z') }).monthly, null);
  assert.equal(r.weekly.shows.length, 2); // the show (3 networks) + the video
});

test('a week where every post tied names no best or worst', () => {
  const flat = buffer.map((b) => ({ ...b, metrics: [] }));
  const r = buildSocialReport({ bufferPosts: flat, ledger, now: NOW });
  assert.equal(r.weekly.best, null);
  assert.equal(r.weekly.worst, null);
  assert.ok(socialHtml(r).length > 0);
});

test('monthlySuggestion: too few posts says so; a dead network with 5+ posts is flagged', () => {
  assert.match(monthlySuggestion([])[0], /Not enough posts yet/);
  const dead = Array.from({ length: 5 }, (_, i) => ({ lane: 'score', service: 'twitter', visits: 0, interactions: 0, id: `x${i}` }));
  const live = Array.from({ length: 5 }, (_, i) => ({ lane: 'score', service: 'threads', visits: 2, interactions: 1, id: `t${i}` }));
  const lines = monthlySuggestion([...dead, ...live]);
  assert.ok(lines.some((l) => /Best network: Threads/.test(l)));
  assert.ok(lines.some((l) => /dropping X/.test(l)));
});

test('suggestedReply never invents a link for an unknown post', () => {
  assert.doesNotMatch(suggestedReply({ lane: 'other' }), /http|\.com\/show/);
});

test('socialHtml escapes post titles and renders the error line', () => {
  const r = buildSocialReport({ bufferPosts: [{ ...buffer[3], text: '<script>x</script>' }], ledger: { posts: [] }, now: NOW });
  const html = socialHtml(r);
  assert.match(html, /<h2[^>]*>Social<\/h2>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(socialHtml({ generatedAt: 'x', error: 'Buffer HTTP 401' }), /unavailable this week \(Buffer HTTP 401\)/);
  assert.equal(socialHtml(null), '');
});

test('loadSocialSection drops stale or missing files but keeps a fresh error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ generatedAt: new Date(NOW).toISOString(), error: 'boom' }));
  assert.equal(loadSocialSection(f, NOW).error, 'boom');
  assert.equal(loadSocialSection(f, NOW + 4 * 86400000), null);
  assert.equal(loadSocialSection(path.join(dir, 'missing.json'), NOW), null);
});

test('writeLedger leaves the file alone when only lastUpdated would change (no hourly deploy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const f = path.join(dir, 'l.json');
  writeLedger({ posts: [{ showId: 'a' }], _meta: {} }, f);
  const first = fs.readFileSync(f, 'utf8');
  writeLedger(JSON.parse(first), f);
  assert.equal(fs.readFileSync(f, 'utf8'), first);
  writeLedger({ ...JSON.parse(first), posts: [{ showId: 'a' }, { showId: 'b' }] }, f);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).posts.length, 2);
});

// Shows for the coming-up / skipped lists. NOW is Mon 2026-11-02 09:30 UTC.
const show = (id, openingDate, category = 'broadway') => ({ id, slug: id, title: id.toUpperCase(), category, openingDate, status: 'open' });
const selCtx = (shows, slim = {}) => ({ shows, slim, reviewsByShow: {}, getOutletTier: () => 1 });
const liveLedger = { posts: [{ type: 'score', showId: 'posted', dueAt: '2026-10-20T14:00:00Z', date: '2026-10-20' }] };

test('skippedShows: waiting, aged out and pre-launch shows, each with a plain reason', () => {
  const ctx = selCtx([
    show('waiting', '2026-10-30'), // slot Oct 31, no score yet
    show('aged', '2026-10-21'), // slot Oct 22, aged out Nov 1
    show('prelaunch', '2026-10-05'), // aged out Oct 16, before the first ledger entry
    show('posted', '2026-10-30'),
    show('future', '2026-11-05'),
    show('london', '2026-10-30', 'west-end'),
  ]);
  const out = skippedShows({ ctx, ledger: liveLedger, now: NOW });
  assert.deepEqual(out.map((x) => [x.title, x.final]), [['AGED', true], ['WAITING', false], ['LONDON (West End)', false]]);
  assert.match(out[0].reason, /gave up 10 days after opening: no score on the site yet/);
  assert.equal(out[1].reason, 'no score on the site yet');
  assert.equal(out[2].link, 'https://westendscorecard.com/show/london');
  assert.deepEqual(skippedShows({ ctx, ledger: { posts: [] }, now: NOW }), []); // not live yet
  assert.deepEqual(skippedShows({ ctx: null, ledger: liveLedger, now: NOW }), []);
});

test('skippedShows lists ledger skips from the last week in words', () => {
  const ledger = { posts: [...liveLedger.posts, { type: 'score', date: '2026-10-30', showId: 'old', skipped: 'backlog at go-live' }] };
  const out = skippedShows({ ctx: selCtx([show('old', '2026-09-01')]), ledger, now: NOW });
  assert.deepEqual(out, [{ title: 'OLD', link: 'https://broadwayscorecard.com/show/old', reason: 'opened before automatic posting was switched on', final: true }]);
});

test('a show the autopost gave up on after 3 failures is listed as needing a look, and not promised as upcoming', () => {
  const ctx = selCtx([show('broken', '2026-10-30'), show('broken-soon', '2026-11-04')]);
  const ledger = { ...liveLedger, _meta: { failures: { broken: { count: 3, lastError: 'render failed' }, 'broken-soon': { count: 3 } } } };
  const out = skippedShows({ ctx, ledger, now: NOW });
  assert.deepEqual(out.map((x) => [x.title, x.final]), [['BROKEN', true]]);
  assert.match(out[0].reason, /posting failed 3 times in a row/);
  assert.deepEqual(upcomingPosts({ scheduled: [], ctx, ledger, now: NOW }), []);
  const twice = { ...liveLedger, _meta: { failures: { broken: { count: 2 } } } };
  assert.equal(skippedShows({ ctx, ledger: twice, now: NOW })[0].reason, 'no score on the site yet'); // still retrying
});

test('upcomingPosts flags Buffer posts that passed their time without going out', () => {
  const scheduled = [{ id: 's1', service: 'threads', dueAt: '2026-11-01T15:00:00Z', text: 'x' }, { id: 's2', service: 'bluesky', dueAt: '2026-11-01T15:00:00Z', text: 'x' }];
  const [first] = upcomingPosts({ scheduled, ctx: null, ledger: null, now: NOW });
  assert.deepEqual(first, { title: 'Stuck in Buffer', line: '2 posts passed their time without going out; check the Buffer queue' });
});

test('scoreDecision agrees with findScoreEvents, and ignoreAge only lifts the age check', () => {
  const shows = [show('aged', '2026-10-01'), show('waiting', '2026-10-30')];
  const ctx = { ...selCtx(shows), done: new Set(), now: NOW };
  assert.equal(scoreDecision(shows[0], ctx).why, 'too-old');
  assert.equal(scoreDecision(shows[0], ctx, { ignoreAge: true }).why, 'no-score');
  assert.equal(findScoreEvents({ ...selCtx(shows), ledger: { posts: [] }, now: NOW }).length, 0);
});

test('gateWords turns confidence-gate codes into words, at most two', () => {
  assert.equal(gateWords({ reasons: ['3/8 total', 'T1:0/3', 'hi-conf:3/6'] }), '3 of the 8 reviews it needs, 0 of 3 reviews from the top outlets');
  assert.equal(gateWords(null), '');
});

test('upcomingPosts: Buffer posts grouped by show and hour, then expected score posts not in Buffer', () => {
  const ctx = selCtx([show('the-imaginary-invalid', '2026-11-03'), show('soon', '2026-11-04'), show('london', '2026-11-04', 'west-end')]);
  const scheduled = [
    { id: 't9', service: 'threads', dueAt: '2026-11-04T15:00:00Z', text: 'x https://broadwayscorecard.com/show/the-imaginary-invalid?utm_source=threads' },
    { id: 'b9', service: 'bluesky', dueAt: '2026-11-04T15:10:00Z', text: 'x https://broadwayscorecard.com/show/the-imaginary-invalid' },
    { id: 'v9', service: 'youtube', dueAt: '2026-11-03T21:00:00Z', text: 'How we score a show' },
    { id: 'late', service: 'twitter', dueAt: '2026-11-20T15:00:00Z', text: 'next month' },
  ];
  const out = upcomingPosts({ scheduled, ctx, ledger: { posts: [] }, now: NOW });
  assert.deepEqual(out.map((x) => x.title), ['How we score a show', 'THE-IMAGINARY-INVALID', 'LONDON (West End)', 'SOON']);
  assert.equal(out[1].line, 'Wed, Nov 4, 10:00 AM ET on Threads, Bluesky');
  assert.match(out[2].line, /^Thu, Nov 5, 10:00 AM UK time, score post/);
  assert.equal(upcomingPosts({ scheduled: [], ctx: null, ledger: null, now: NOW }).length, 0);
});

test('postingTimeAdvice waits for 4 weeks, then names a clearly better time block per network', () => {
  const at = (iso, visits, lane = 'video') => ({ service: 'threads', lane, sentAt: iso, visits, interactions: 0 });
  assert.match(postingTimeAdvice([at('2026-10-20T14:00:00Z', 1)], NOW)[0], /starts once there are 4 weeks of posts \(12 days so far\)/);
  const rows = [
    ...[1, 2, 3, 4, 5, 6].map((d) => at(`2026-10-0${d}T14:00:00Z`, 0)), // 10am ET, most posts, nothing
    ...[5, 6, 7, 8, 9].map((d) => at(`2026-10-0${d}T23:00:00Z`, 2)), // 7pm ET
  ];
  const [line] = postingTimeAdvice(rows, NOW);
  assert.match(line, /^Threads: evening \(after 5pm ET\) posts did better than morning \(before noon ET\) posts \(5 against 6 posts\)\. Try moving Threads posts to the evening\.$/);
  // Score posts go out at a fixed hour, so they never drive the advice; 4 posts in a block is too few.
  assert.match(postingTimeAdvice(rows.map((r) => ({ ...r, lane: 'score' })), NOW)[0], /starts once there are 4 weeks/);
  assert.match(postingTimeAdvice(rows.filter((r, i) => i !== 6 && i !== 7), NOW)[0], /No posting time clearly does better yet/);
  assert.match(postingTimeAdvice(rows.map((r) => ({ ...r, visits: 1 })), NOW)[0], /No posting time clearly does better yet/);
});

test('socialHtml renders coming up, skipped (capped) and posting times', () => {
  const r = buildSocialReport({ bufferPosts: buffer, ledger, now: NOW });
  r.weekly.upcoming = [{ title: 'A <b>', line: 'Tue 10:00 AM ET on Threads' }];
  r.weekly.skipped = [...Array.from({ length: 8 }, (_, i) => ({ title: `S${i}`, reason: 'gave up', final: true })), { title: 'W', reason: 'no score on the site yet', final: false }];
  const html = socialHtml(r);
  assert.match(html, /Coming up this week<\/h3>/);
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /and 2 more skipped/);
  assert.match(html, /W<\/a>|W: no score on the site yet/);
  assert.match(html, /Posting times:<\/strong> Posting-time advice starts/);
});

test('plainReason never shows an internal reason code', () => {
  assert.equal(plainReason({ why: 'no-score' }), 'no score on the site yet');
  for (const why of ['some-new-code', undefined]) assert.equal(plainReason({ why }), 'not ready to post yet');
});

test('video posts are named after the show their caption mentions', () => {
  const shows = [{ id: 'a', title: 'The Imaginary Invalid' }, { id: 'b', title: 'Chess' }, { id: 'c', title: 'Invalid' }];
  assert.equal(showInCaption('The Imaginary Invalid just opened on Broadway', shows).id, 'a');
  assert.equal(showInCaption('Chess fans, this one is for you', shows), null); // too short to trust
  assert.equal(showInCaption('Here is how we score a show.', shows), null);
  const rows = buildPostRows([
    { id: 'v1', sentAt: '2026-10-20T12:00:00Z', service: 'tiktok', isVideo: true, text: 'The Imaginary Invalid just opened on Broadway and 20 critics have weighed in', metrics: [] },
    { id: 'v2', sentAt: '2026-10-20T12:00:00Z', service: 'tiktok', isVideo: true, text: 'Here is how we score a show.', metrics: [] },
  ], { posts: [] }, shows);
  assert.equal(rows[0].title, 'The Imaginary Invalid (video)');
  assert.equal(rows[0].slug, null); // visits still go only to posts that link the show
  assert.equal(rows[1].title, 'Here is how we score a show.');
});

test('a brief (compare) post is its own lane, named for the email, with the ledger title', () => {
  const briefLedger = { posts: [{ type: 'brief', id: 'brief:abc', slug: 'tc-off-broadway', title: 'The Curious Case', text: 'x', channels: { twitter: { postId: 'x1' } } }] };
  const rows = buildPostRows([{ id: 'x1', service: 'twitter', sentAt: '2026-10-30T17:00:00Z', text: 'x', metrics: m({ impressions: 3 }) }], briefLedger);
  assert.equal(rows[0].lane, 'brief');
  assert.equal(rows[0].title, 'The Curious Case');
  assert.equal(rows[0].slug, 'tc-off-broadway');
  assert.match(fs.readFileSync(new URL('./social-report.js', import.meta.url), 'utf8'), /brief: 'compare posts'/);
});

test('brief visits go to the compare post, score-post visits stay with the score post, and both linked shows count', () => {
  const ledger = { posts: [
    { showId: 'tc-ob', slug: 'tc-off-broadway', title: 'TC score', text: 'x', channels: { facebook: { postId: 'f1' } } },
    { type: 'brief', id: 'brief:abc', slug: 'tc-off-broadway', title: 'TC compare', text: 'x', channels: { facebook: { postId: 'f2' } } },
  ] };
  const rows = buildPostRows([
    { id: 'f1', service: 'facebook', sentAt: '2026-10-20T13:00:00Z', text: 'https://broadwayscorecard.com/show/tc-off-broadway?utm_campaign=autopost', metrics: m({}) },
    { id: 'f2', service: 'facebook', sentAt: '2026-10-26T17:00:00Z', text: 'https://broadwayscorecard.com/show/tc-off-broadway?utm_campaign=brief\nhttps://westendscorecard.com/show/tc-west-end-2024?utm_campaign=brief', metrics: m({}) },
  ], ledger);
  const unmatched = attributeVisits(rows, { utmRows: [
    { source: 'facebook', path: '/show/tc-off-broadway', day: '2026-10-27', campaign: 'autopost', views: 5 },
    { source: 'facebook', path: '/show/tc-off-broadway', day: '2026-10-27', campaign: 'brief', views: 3 },
    { source: 'facebook', path: '/show/tc-west-end-2024', day: '2026-10-27', campaign: 'brief', views: 2 },
  ] });
  assert.equal(unmatched, 0);
  assert.equal(rows.find((r) => r.id === 'f1').visits, 5);
  assert.equal(rows.find((r) => r.id === 'f2').visits, 5);
});

test('compare posts do not skew posting-time advice', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ lane: 'brief', service: 'x', sentAt: new Date(Date.UTC(2026, 8, 1 + i * 3, 15)).toISOString(), visits: 1, interactions: 1 }));
  assert.match(postingTimeAdvice(rows, Date.UTC(2026, 9, 27))[0], /starts once there are 4 weeks/);
});

test('suggestedReply ends with an open question on every lane (BRO-6417 voice)', () => {
  for (const r of [{ lane: 'video' }, { lane: 'score', slug: 'x', title: 'X', reviewCount: 9 }, { lane: 'other' }]) {
    assert.match(suggestedReply(r), /\?$/, `${r.lane} reply lost its question`);
  }
});
