// BRO-7414: video lane decisions. Requires the real functions (CLAUDE.md §15).
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('./video-select');
const B = require('./buffer');
const { videoTitle, duplicateMarker } = require('./video-run');

const NOW = Date.parse('2026-11-12T15:00:00Z');
const row = (type, showId, channels, extra = {}) => ({ type, showId, channels, ...extra });
const posted = at => ({ postId: 'p1', createdAt: at });

test('videoWorthy: Broadway yes, regional and West End no', () => {
  assert.equal(V.videoWorthy({ id: 'a', category: 'broadway' }, {}), true);
  assert.equal(V.videoWorthy({ id: 'b', category: 'west-end' }, {}), false);
  assert.equal(V.videoWorthy({ id: 'c', category: 'regional' }, {}), false);
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
  assert.deepEqual(V.attempts(ledger, 'score:x', NOW), { today: 1, total: 2 });
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
