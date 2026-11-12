// BRO-7414: video lane decisions. Requires the real functions (CLAUDE.md §15).
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../scripts/social-autopost/video-select');
const B = require('../../scripts/social-autopost/buffer');
const { videoTitle, duplicateMarker } = require('../../scripts/social-autopost/video-run');

const NOW = Date.parse('2026-11-12T15:00:00Z');
const row = (type, showId, channels, extra = {}) => ({ type, showId, channels, ...extra });
const posted = at => ({ postId: 'p1', createdAt: at });

test('videoWorthy: Broadway yes, regional and West End no', () => {
  assert.equal(V.videoWorthy({ id: 'a', category: 'broadway' }, {}), true);
  assert.equal(V.videoWorthy({ id: 'b', category: 'west-end' }, {}), false);
  assert.equal(V.videoWorthy({ id: 'c', category: 'regional' }, {}), false);
});

test('videoWorthy is BRO-7413 socialNotable, not a copy (same answer, incl. Off-Broadway with no data and no category)', () => {
  const { socialNotable } = require('../../scripts/social-autopost/notable');
  const slim = { ob: null };
  for (const show of [{ id: 'ob', category: 'off-broadway' }, { id: 'n', category: null }, { id: 'op', category: 'broadway', type: 'opera' }, { id: 'b', category: 'broadway' }]) {
    assert.equal(V.videoWorthy(show, { slim }), socialNotable(show, slim), show.id);
  }
  assert.equal(V.videoWorthy({ id: 'n', category: null }, { slim }), false);
});

test('entryDone needs a post on every network, or an abandon', () => {
  const all = Object.fromEntries(V.NETWORKS.map(n => [n, posted('2026-11-12T10:00:00Z')]));
  assert.equal(V.entryDone(row('score', 'x', all)), true);
  assert.equal(V.entryDone(row('score', 'x', { tiktok: posted('2026-11-12T10:00:00Z') })), false);
  assert.equal(V.entryDone(row('score', 'x', {}, { abandoned: true })), true);
});

test('videoDoneKeys only lists finished entries, keyed like select.js', () => {
  const all = Object.fromEntries(V.NETWORKS.map(n => [n, posted('2026-11-12T10:00:00Z')]));
  const keys = V.videoDoneKeys({ posts: [row('score', 'done-show', all), row('score', 'half-show', { tiktok: posted('2026-11-12T10:00:00Z') })] });
  assert.ok(keys.has('score:done-show'));
  assert.ok(!keys.has('score:half-show'));
  assert.equal(V.videoDoneKeys(null).size, 0);
});

test('busyNetworks counts only posts made on this New York day', () => {
  const ledger = { posts: [row('score', 'x', { tiktok: posted('2026-11-12T13:00:00Z'), youtube: posted('2026-11-10T13:00:00Z') })] };
  assert.deepEqual([...V.busyNetworks(ledger, NOW)], ['tiktok']);
});

test('attempts splits today from total', () => {
  const ledger = { failures: [{ key: 'score:x', at: '2026-11-12T12:00:00Z' }, { key: 'score:x', at: '2026-11-09T12:00:00Z' }, { key: 'score:y', at: '2026-11-12T12:00:00Z' }] };
  assert.deepEqual(V.attempts(ledger, 'score:x', NOW), { today: 1, total: 2, skippedToday: false });
});

test('pickToday: one video per network per day, backoff, partial entries fill only missing networks', () => {
  const ev = { type: 'score', fmt: 'reveal', show: { id: 'x' } };
  assert.deepEqual(V.pickToday([ev], { posts: [] }, NOW).pick.targets, V.NETWORKS);
  const full = { posts: [row('score', 'other', Object.fromEntries(V.NETWORKS.map(n => [n, posted('2026-11-12T13:00:00Z')])))] };
  assert.equal(V.pickToday([ev], full, NOW).pick, null);
  const twoFails = { posts: [], failures: [{ key: 'score:x', at: '2026-11-12T12:00:00Z' }, { key: 'score:x', at: '2026-11-12T13:00:00Z' }] };
  assert.equal(V.pickToday([ev], twoFails, NOW).pick, null);
  const partial = { posts: [row('score', 'x', { tiktok: posted('2026-11-10T13:00:00Z') })] };
  assert.deepEqual(V.pickToday([ev], partial, NOW).pick.targets, V.NETWORKS.filter(n => n !== 'tiktok'));
});

test('findVideoEvents skips non-Broadway shows without picking them', () => {
  const shows = [{ id: 'wx', category: 'west-end', openingDate: '2026-10-01', title: 'WX' }];
  const r = V.findVideoEvents({ shows, textLedger: { posts: [] }, videoLedger: { posts: [] }, now: NOW, reviewsByShow: {}, slim: {}, getOutletTier: () => 3 });
  assert.equal(r.events.length, 0);
});

test('videoTitle stays within 100 chars and names the score', () => {
  assert.equal(videoTitle({ fmt: 'reveal' }, { title: 'Hamilton' }, 88), 'Hamilton: Critic Score 88/100');
  const long = videoTitle({ fmt: 'reveal' }, { title: 'X'.repeat(200) }, 70);
  assert.ok(long.length <= 100 && long.endsWith('...'));
});

test('duplicateMarker needs the title and the score as a whole number', () => {
  const has = duplicateMarker('Hamilton', 88);
  assert.equal(has('Hamilton scored 88 out of 100'), true);
  assert.equal(has('Hamilton scored 188'), false);
  assert.equal(has('Wicked scored 88'), false);
});

test('videoMetadataFor: per-network shape, AI flag, 100-char title cap, no empty title', () => {
  const yt = B.videoMetadataFor('youtube', 'T'.repeat(150));
  assert.equal(yt.youtube.title.length, 100);
  assert.equal(yt.youtube.isAiGenerated, true);
  assert.equal(B.videoMetadataFor('tiktok', 'Show').tiktok.isAiGenerated, true);
  assert.throws(() => B.videoMetadataFor('tiktok', '  '), /title/);
  assert.throws(() => B.videoMetadataFor('instagram', 'x'), /no video metadata/);
});

test('createVideoPost refuses a file rendered for the other app', async () => {
  await assert.rejects(B.createVideoPost({ channel: { id: 'c', network: 'tiktok' }, text: 't', videoUrl: 'https://h/x-youtube.mp4', title: 'T', dueAt: new Date() }), /was not rendered for tiktok/);
});

test('busyNetworks: a post made last night for a slot today still holds today (review: 22:41 NY run)', () => {
  const made = '2026-11-12T03:41:00Z'; // 22:41 NY the day before
  const ledger = { posts: [row('score', 'x', { tiktok: posted(made) }, { dueAt: '2026-11-12T14:00:00Z' })] };
  assert.deepEqual([...V.busyNetworks(ledger, NOW)], ['tiktok']);
});

test('attempts: one run failing on both networks is one attempt; a skip is not a failure', () => {
  const at = '2026-11-12T14:00:00Z';
  const ledger = { failures: [{ key: 'score:x', at }, { key: 'score:x', at }, { key: 'score:x', at: '2026-11-12T14:30:00Z', kind: 'skip' }] };
  const a = V.attempts(ledger, 'score:x', NOW);
  assert.equal(a.total, 1); assert.equal(a.today, 2); assert.equal(a.skippedToday, true);
});

test('pickToday passes over a show skipped today so older shows can post', () => {
  const ev = id => ({ type: 'score', fmt: 'reveal', show: { id }, slot: NOW });
  const ledger = { posts: [], failures: [{ key: 'score:a', at: '2026-11-12T14:30:00Z', kind: 'skip' }] };
  assert.equal(V.pickToday([ev('a'), ev('b')], ledger, NOW).pick.show.id, 'b');
});

// ---- BRO-7418: compare format
const C = require('../../scripts/social-autopost/config');

test('compare is wired into the video formats', () => {
  assert.ok(C.VIDEO.formats.includes('compare') && C.VIDEO.formats.includes('reveal'));
  assert.ok(Number.isInteger(C.VIDEO.maxMakesPerMonth) && C.VIDEO.maxMakesPerMonth > 0);
});

test('pickToday: a due compare goes before a due score video for the same show, and the score video takes the next free day', () => {
  const show = { id: 'x' };
  const cmp = { type: 'london-compare', fmt: 'compare', show, slot: NOW - 1 };
  const score = { type: 'score', fmt: 'reveal', show, slot: NOW };
  const events = [score, cmp].sort((a, b) => (a.fmt === 'compare' ? 0 : 1) - (b.fmt === 'compare' ? 0 : 1) || b.slot - a.slot);
  assert.equal(V.pickToday(events, { posts: [] }, NOW).pick.fmt, 'compare');
  const afterCompare = { posts: [row('london-compare', 'x', Object.fromEntries(V.NETWORKS.map(n => [n, posted('2026-11-12T13:00:00Z')])))] };
  assert.equal(V.pickToday([score], afterCompare, NOW).pick, null, 'same day: the networks are taken');
  const nextDay = Date.parse('2026-11-13T15:00:00Z');
  assert.equal(V.pickToday([score], afterCompare, nextDay).pick.fmt, 'reveal');
});

test('findVideoEvents lists both formats for one show, compare first, and keeps the score video for the next day', t => {
  // the select.js decisions are stubbed (their own tests cover them); this checks how the video lane combines them
  const S = require('../../scripts/social-autopost/select');
  const real = { e: S.isEligibleShow, c: S.londonCompareDecision, s: S.scoreDecision };
  t.after(() => { S.isEligibleShow = real.e; S.londonCompareDecision = real.c; S.scoreDecision = real.s; });
  const ny = { id: 'twin-2026', title: 'Twin', category: 'broadway', type: 'play', openingDate: '2026-10-01' };
  const lon = { id: 'twin-west-end-2025', title: 'Twin', category: 'west-end', type: 'play', openingDate: '2025-06-01' };
  const other = { id: 'solo-2026', title: 'Solo', category: 'broadway', type: 'play', openingDate: '2026-11-01' };
  S.isEligibleShow = show => show.category === 'broadway';
  S.londonCompareDecision = show => show.id === 'twin-2026' ? { due: true, london: lon, slot: NOW - 1e6 } : { due: false, why: 'no-london-run' };
  S.scoreDecision = show => ({ due: true, slot: show.id === 'solo-2026' ? NOW - 1e3 : NOW - 5e6 });
  const run = () => V.findVideoEvents({ shows: [ny, lon, other], textLedger: { posts: [] }, videoLedger: { posts: [] }, now: NOW, reviewsByShow: {}, slim: {}, getOutletTier: () => 3 });
  const { events } = run();
  assert.deepEqual(events.map(e => `${e.fmt}:${e.show.id}`), ['compare:twin-2026', 'reveal:solo-2026', 'reveal:twin-2026']);
  assert.equal(events[0].london.id, 'twin-west-end-2025');
  const day = V.pickToday(events, { posts: [] }, NOW);
  assert.equal(day.pick.fmt, 'compare');
  // once the compare is done (video ledger), the same show's score video is still due
  const doneLedger = { posts: [row('london-compare', 'twin-2026', Object.fromEntries(V.NETWORKS.map(n => [n, posted('2026-11-12T13:00:00Z')])))] };
  assert.ok(V.videoDoneKeys(doneLedger).has('london-compare:twin-2026'));
  assert.ok(events.some(e => e.type === 'score' && e.show.id === 'twin-2026'));
  C.VIDEO.formats = ['reveal']; // eslint-disable-line no-param-reassign
  try { assert.deepEqual(run().events.map(e => e.fmt), ['reveal', 'reveal']); } finally { C.VIDEO.formats = ['reveal', 'compare']; }
});

test('makesThisMonth: a post counts once however many networks, failures once per run, skips and other months not at all', () => {
  const t = '2026-11-12T13:00:00Z';
  const ledger = {
    posts: [row('score', 'a', { tiktok: posted(t), youtube: posted(t) }), row('score', 'b', { tiktok: posted('2026-10-30T13:00:00Z') })],
    failures: [{ key: 'score:c', at: '2026-11-11T13:00:00Z' }, { key: 'score:c', at: '2026-11-11T13:00:00Z' }, { key: 'score:d', at: '2026-11-11T14:00:00Z', kind: 'skip' }, { key: 'score:e', at: '2026-10-01T13:00:00Z' }],
  };
  assert.equal(V.makesThisMonth(ledger, NOW), 2);
  assert.equal(V.makesThisMonth(null, NOW), 0);
});

test('pickToday: the monthly spend cap stops new videos and says why', () => {
  const ev = { type: 'score', fmt: 'reveal', show: { id: 'x' }, slot: NOW };
  const ledger = { posts: [row('score', 'a', { tiktok: posted('2026-11-03T13:00:00Z') }), row('score', 'b', { tiktok: posted('2026-11-04T13:00:00Z') })] };
  assert.ok(V.pickToday([ev], ledger, NOW, { maxMakes: 3 }).pick, 'under the cap');
  const r = V.pickToday([ev], ledger, NOW, { maxMakes: 2 });
  assert.equal(r.pick, null); assert.match(r.why, /monthly cap reached \(2 of 2/);
  assert.ok(V.pickToday([ev], ledger, Date.parse('2026-12-02T15:00:00Z'), { maxMakes: 2 }).pick, 'a new month starts at zero');
});

test('duplicateMarker tells a compare caption from a score caption for the same show and score', () => {
  const compare = 'Same show, two cities. Broadway\'s critics scored Here There Are Blueberries 8 points higher. London 2026: Critic Score 73 from 17 critics. Broadway 2026: 81 from 20 critics.';
  const reveal = '20 critics weighed in on Here There Are Blueberries. One score: 81, Worth Seeing.';
  assert.equal(duplicateMarker('Here There Are Blueberries', 81, 'compare')(compare), true);
  assert.equal(duplicateMarker('Here There Are Blueberries', 81, 'compare')(reveal), false);
  assert.equal(duplicateMarker('Here There Are Blueberries', 81, 'reveal')(reveal), true);
  assert.equal(duplicateMarker('Here There Are Blueberries', 81)(compare), false, 'the default is the score format');
});

test('videoTitle for a compare names the show, not a score', () => {
  assert.equal(videoTitle({ fmt: 'compare' }, { title: 'Hamilton' }, 88), 'Hamilton: same show, two cities');
});

test('duplicateMarker folds punctuation so a London-spelled compare caption matches the NY title', () => {
  const { duplicateMarker } = require('../../scripts/social-autopost/video-run');
  const cap = 'Same show, two cities. Ghost – The Musical: Broadway 2026: 45 from 12 reviews';
  assert.equal(duplicateMarker('Ghost The Musical', 45, 'compare')(cap), true);
  assert.equal(duplicateMarker('Ghost The Musical', 45, 'reveal')(cap), false);
});
