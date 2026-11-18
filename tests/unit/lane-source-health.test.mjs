// BRO-7779 items 5 and 6: the lane's own feed and index reads fail loudly, and a review dated a few days off the
// recorded night (a wrong openingDate) alerts instead of vanishing as an intended 'outside-night-window' refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const nm = require('../../scripts/lib/opening-night-lane/near-miss.js');
const sh = require('../../scripts/lib/opening-night-lane/source-health.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');

const NIGHT = '2026-11-17';
const SHOW = { id: 'test-show-2026', title: 'Test Show', category: 'broadway', market: 'broadway', openingDate: NIGHT, venue: 'Nowhere Theatre' };
const DEAD_FEED = 'https://dead.example.com/feed/';
const WALL_FEED = 'https://wall.example.com/feed/';
const OK_FEED = 'https://ok.example.com/feed/';
const WALL_INDEX = 'https://www.theatermania.com/news/?categories=reviews';
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
const WALL = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';

test('tracker: N failed reads in a row alert once per streak; a good read ends the streak; a new streak alerts again', () => {
  let t = 0;
  const h = sh.createSourceHealth({ now: () => t });
  h.expect([DEAD_FEED], { adapter: 'rss' });
  for (let i = 0; i < 2; i++) { h.record(DEAD_FEED, { ok: false, error: new Error('ECONNRESET') }); t += 120000; }
  assert.deepEqual(h.alerts(), [], 'two failures is not yet a streak');
  h.record(DEAD_FEED, { ok: false, error: new Error('ECONNRESET') });
  const a = h.alerts();
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'fetch-failing');
  assert.equal(a[0].fails, 3);
  assert.equal(a[0].lastError, 'ECONNRESET');
  h.record(DEAD_FEED, { ok: false, error: 'x' });
  assert.deepEqual(h.alerts(), [], 'the same streak alerts once');
  h.record(DEAD_FEED, { ok: true });
  t += 120000;
  for (let i = 0; i < 3; i++) { h.record(DEAD_FEED, { ok: false, error: 'x' }); t += 1000; }
  const b = h.alerts();
  assert.equal(b.length, 1, 'a new streak after a recovery alerts again');
  assert.notEqual(b[0].key, a[0].key, 'distinct keys so the per-night dedupe lets the new streak through');
});

test('tracker: an expected source not read for 30 minutes is reported stale, once per idle period', () => {
  let t = 0;
  const h = sh.createSourceHealth({ now: () => t });
  h.expect([OK_FEED, DEAD_FEED]);
  h.record(OK_FEED, { ok: true });
  t = 29 * 60000; h.record(OK_FEED, { ok: true });
  assert.deepEqual(h.alerts(), []);
  t = 31 * 60000;
  const a = h.alerts();
  assert.deepEqual(a.map((x) => [x.kind, x.url]), [['source-stale', DEAD_FEED]]);
  assert.deepEqual(h.alerts(), [], 'once per idle period');
});

test('body checks: a bot wall or an HTML page served for a feed is a failed read; an empty real feed is not', () => {
  assert.equal(sh.feedBodyProblem(RSS, []), null);
  assert.equal(sh.feedBodyProblem(WALL, []), 'bot wall or error page');
  assert.equal(sh.feedBodyProblem('<html><body>404</body></html>', []), 'not a feed');
  assert.equal(sh.feedBodyProblem('', []), 'empty body');
  assert.equal(sh.indexBodyProblem(WALL), 'bot wall or error page');
  assert.equal(sh.indexBodyProblem('<html><head><title>Reviews</title></head><body>..</body></html>'), null);
});

async function healthPasses(n) {
  let t = Date.parse(`${NIGHT}T23:00:00Z`);
  const health = sh.createSourceHealth({ now: () => t });
  const fetchText = async (u) => {
    if (u === DEAD_FEED) throw new Error('HTTP 503');
    if (u === WALL_FEED || u === WALL_INDEX) return WALL;
    return RSS;
  };
  const adapters = [
    d.rssAdapter({ feeds: [{ url: DEAD_FEED, name: 'dead' }, { url: WALL_FEED, name: 'wall' }, { url: OK_FEED, name: 'ok' }] }),
    d.sectionIndexAdapter({ outlets: [{ outletId: 'theatermania', indexUrl: WALL_INDEX, pinned: true }] }),
  ];
  for (let i = 0; i < n; i++) {
    await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: t, startedAt: t, fetchText, adapters, timeZone: 'America/New_York', sourceHealth: health });
    t += 150000;
  }
  return health.alerts(t);
}

test('discovery pass: a dead feed, a bot-walled feed and a bot-walled index each alert after 3 passes; a good feed never', async () => {
  assert.deepEqual(await healthPasses(2), [], 'two passes: no alert yet');
  const a = await healthPasses(3);
  const failing = a.filter((x) => x.kind === 'fetch-failing').map((x) => x.url).sort();
  assert.deepEqual(failing, [DEAD_FEED, WALL_INDEX, WALL_FEED].sort(), JSON.stringify(a));
  assert.equal(a.find((x) => x.url === WALL_INDEX).outletId, 'theatermania');
  assert.match(a.find((x) => x.url === DEAD_FEED).lastError, /503/);
});

test('discovery pass: an adapter that throws every pass (an aggregator down) alerts after 3 passes', async () => {
  let t = Date.parse(`${NIGHT}T23:00:00Z`);
  const health = sh.createSourceHealth({ now: () => t });
  const adapters = [{ name: 'bww-roundup', phase: 'cheap', discover: async () => { throw new Error('HTTP 503 from broadwayworld'); } }];
  for (let i = 0; i < 3; i++) { await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: t, startedAt: t, fetchText: async () => '', adapters, sourceHealth: health }); t += 150000; }
  assert.deepEqual(health.alerts().map((x) => [x.kind, x.url, x.adapter]), [['fetch-failing', 'adapter:bww-roundup', 'bww-roundup']]);
});

test('window mismatch: an own-outlet review dated +3 days alerts at once; an old production (a year off) never does', async () => {
  const REVIEW = 'https://www.theguardian.com/stage/2026/nov/20/test-show-review-broadway';
  const OLD = 'https://www.theguardian.com/stage/2025/nov/10/test-show-review-broadway';
  const adapters = [{ name: 'idx', phase: 'cheap', discover: async () => [
    { url: REVIEW, title: 'Test Show review: a fine night', outletId: 'guardian', source: 'outlet-index', vettedOutlet: true, publishDate: '2026-11-20T18:00:00Z' },
    { url: OLD, title: 'Test Show review: last year', outletId: 'guardian', source: 'outlet-index', vettedOutlet: true, publishDate: '2025-11-10T03:00:00Z' },
  ] }];
  const now = Date.parse(`${NIGHT}T23:00:00Z`);
  const memo = { rejected: {} };
  await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now, startedAt: now, fetchText: async () => '', adapters, memo, timeZone: 'America/New_York' });
  // The sighting carries the refusal from the NEXT pass (the memo is written as the pass judges).
  const r = await d.runDiscoveryPass({ show: SHOW, night: NIGHT, now, startedAt: now, fetchText: async () => '', adapters, memo, timeZone: 'America/New_York' });
  const s = r.sightings.find((x) => x.url === REVIEW);
  assert.equal(s.rejectedFor, 'outside-night-window');
  assert.equal(s.rejectedDayOffset, 3);
  const gaps = nm.gapCandidates(r.sightings, { firstSeen: new Map(), now });
  assert.deepEqual(gaps.map((g) => g.url), [REVIEW], 'only the near-dated review, and with no 15 min wait');
  const msg = nm.formatPressSignals(SHOW, NIGHT, { gaps });
  assert.match(msg.description, /WINDOW-MISMATCH/);
  assert.match(msg.description, /dated \+3 day\(s\) from tonight: check the show's openingDate/);
  // An aggregator cite refused for its window (should the trust model ever date-check cites) alerts too.
  assert.equal(nm.windowMismatch({ rejectedFor: 'outside-night-window', aggregatorCited: true }), true);
});

test('lane runner: a source failing all night reaches onPressSignals once, with a SOURCE FAILING line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-run-'));
  let t = Date.parse(`${NIGHT}T23:00:00Z`);
  const calls = [];
  await runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, maxPasses: 6,
    fetchText: async (u) => { if (u === DEAD_FEED) throw new Error('HTTP 503'); return RSS; },
    adapters: [d.rssAdapter({ feeds: [{ url: DEAD_FEED, name: 'dead' }, { url: OK_FEED, name: 'ok' }] })],
    fetchReview: async () => { throw new Error('nothing should be admitted'); }, scoreReview: async () => 80,
    publishPorts: { updateReviews: async () => {}, regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: [] }) },
    now: () => t, wait: async (ms) => { t += Math.max(ms || 0, 2 * 60000); }, abandonPending: () => true,
    onPressSignals: async (sig) => { calls.push(sig); },
  });
  const health = calls.flatMap((c) => c.sourceHealth || []);
  assert.deepEqual(health.map((h) => [h.kind, h.url]), [['fetch-failing', DEAD_FEED]], JSON.stringify(calls));
  const text = nm.formatPressSignals(SHOW, NIGHT, calls.find((c) => (c.sourceHealth || []).length)).description;
  assert.match(text, /SOURCE FAILING \(rss\): https:\/\/dead\.example\.com\/feed\//);
  assert.match(text, /3 reads in a row failed \(last: HTTP 503\)/);
});

test('notifier passes source problems through to the alert text', async () => {
  const { createPressSignalsNotifier } = require('../../scripts/lib/press-night-signals-notify.js');
  const sent = [];
  const notify = createPressSignalsNotifier({ env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/x' }, log: () => {}, discord: async (_w, x) => { sent.push(x); return true; }, card: null, fetchPage: async () => '' });
  const r = await notify({ show: SHOW, night: NIGHT, sourceHealth: [{ kind: 'source-stale', url: OK_FEED, adapter: 'rss', idleMin: 34, lastAttemptAt: null }] });
  assert.equal(r.discord, true);
  assert.match(sent.join('\n'), /SOURCE NOT READ \(rss\): https:\/\/ok\.example\.com\/feed\/\n {2}not read for 34 min/);
  assert.match(r.text, /1 source problem\(s\)/);
});
