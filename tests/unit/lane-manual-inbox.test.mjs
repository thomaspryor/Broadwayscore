// BRO-7741: a review missing on an opening night is added through the lane's manual inbox, which the running lane
// reads every pass, instead of a full lane rollback. These tests fail with the change reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const inbox = require('../../scripts/lib/opening-night-lane/manual-inbox.js');
const { ingestRouteDecision, settleAfterInboxWrite } = require('../../scripts/lib/lane-inbox-routing.js');
const { PROVISIONAL_DATE_SOURCES, isProvisionalPublishDate } = require('../../scripts/lib/publish-date-provenance.js');
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');
const { drainPlan, drainAllowed, liveLease } = require('../../scripts/opening-night-lane-inbox.js');

const NIGHT = new Date().toISOString().slice(0, 10);
const SHOW = { id: 'test-show-2026', title: 'Test Show', openingDate: NIGHT };
const URL1 = 'https://www.theatermania.com/news/reviews/blue-review_99999/';
const T0 = Date.parse(`${NIGHT}T12:00:00Z`);

test('addEntries: dedupes by normalized URL, re-queues only a failed or rejected entry', () => {
  let r = inbox.addEntries({ leases: {} }, { show: SHOW.id, lines: [{ url: URL1, critic: 'A Critic' }, { url: 'nope' }], addedBy: 't', now: T0 });
  assert.equal(r.ok, true); assert.equal(r.added.length, 1); assert.deepEqual(r.invalid, ['nope']);
  const id = r.added[0];
  r = inbox.addEntries(r.state, { show: SHOW.id, lines: [{ url: URL1.replace('www.', '').replace(/\/$/, '') + '#x' }], now: T0 });
  assert.deepEqual(r.duplicates, [id], 'same page, different spelling');
  const failed = inbox.markStatus(r.state, { updates: [{ id, status: 'failed', reason: 'fetch 403' }], now: T0 }).state;
  r = inbox.addEntries(failed, { show: SHOW.id, lines: [{ url: URL1, force: true }], now: T0 });
  assert.deepEqual(r.added, [id]); assert.equal(r.state.leases[id].status, undefined); assert.equal(r.state.leases[id].force, true);
  assert.equal(inbox.addEntries({ leases: {} }, { show: 'Bad Id', lines: [{ url: URL1 }] }).ok, false);
});

test('markStatus: a late "queued" never reopens a published entry', () => {
  const s = inbox.addEntries({ leases: {} }, { show: SHOW.id, lines: [{ url: URL1 }], now: T0 });
  const id = s.added[0];
  const pub = inbox.markStatus(s.state, { updates: [{ id, status: 'published' }], now: T0 }).state;
  const again = inbox.markStatus(pub, { updates: [{ id, status: 'queued' }, { id: 'gone', status: 'failed' }], now: T0 });
  assert.equal(again.state.leases[id].status, 'published'); assert.deepEqual(again.applied, []);
});

test('git store: add and mark by compare-and-swap, read by the lane, missing branch reads empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7741-inbox-'));
  try {
    const bare = path.join(root, 'remote.git'); const work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: work });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    Object.assign(process.env, env);
    assert.deepEqual(await inbox.readForShow({ repoDir: work, show: SHOW.id }), []);
    const add = inbox.addSync({ repoDir: work }, { show: SHOW.id, lines: [{ url: URL1 }], addedBy: 'test' });
    assert.equal(add.ok, true, JSON.stringify(add));
    const rows = await inbox.readForShow({ repoDir: work, show: SHOW.id });
    assert.equal(rows.length, 1); assert.equal(rows[0].url, URL1);
    assert.equal(inbox.markSync({ repoDir: work }, [{ id: rows[0].id, status: 'published' }]).ok, true);
    assert.equal((await inbox.readForShow({ repoDir: work, show: SHOW.id }))[0].status, 'published');
    assert.deepEqual(await inbox.readForShow({ repoDir: work, show: 'other-show' }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('markStatus: a status for an earlier generation never lands on a re-added entry', () => {
  const s = inbox.addEntries({ leases: {} }, { show: SHOW.id, lines: [{ url: URL1 }], now: T0 });
  const id = s.added[0]; const firstAt = s.state.leases[id].addedAt;
  const rej = inbox.markStatus(s.state, { updates: [{ id, addedAt: firstAt, status: 'rejected' }], now: T0 }).state;
  const readded = inbox.addEntries(rej, { show: SHOW.id, lines: [{ url: URL1, force: true }], now: T0 + 60000 }).state;
  const late = inbox.markStatus(readded, { updates: [{ id, addedAt: firstAt, status: 'rejected', reason: 'late' }], now: T0 + 61000 });
  assert.equal(late.state.leases[id].status, undefined, 'the re-added entry stays open');
  assert.deepEqual(late.applied, []);
});

test('settleAfterInboxWrite: a lane that ended mid-write hands the URLs to the regular ingest', () => {
  const marked = [];
  const held = settleAfterInboxWrite({ showId: SHOW.id, ids: ['a'], readLease: () => ({ holder: 'gha-1' }), mark: (u) => marked.push(...u) });
  assert.equal(held.ingestNow, false); assert.equal(marked.length, 0);
  const gone = settleAfterInboxWrite({ showId: SHOW.id, ids: ['a'], readLease: () => null, mark: (u) => marked.push(...u) });
  assert.equal(gone.ingestNow, true); assert.deepEqual(marked.map((m) => m.status), ['drained']);
});

test('a manual row: its add-day date is provisional and no guard outside the lane trusts it', () => {
  assert.ok(PROVISIONAL_DATE_SOURCES.has('manual-inbox'));
  assert.equal(isProvisionalPublishDate({ publishDate: NIGHT, dateSource: 'manual-inbox' }), true);
  const row = { showId: SHOW.id, [trust.PROVENANCE_KEY]: { source: 'manual' } };
  assert.equal(trust.isAggregatorVerifiedLaneReview(row, { openingDate: NIGHT }), false);
  const src = fs.readFileSync(new URL('../../scripts/lib/preopening-interview-signal.js', import.meta.url), 'utf8');
  assert.ok(!/\bisLaneReview\(/.test(src), 'preopening-interview-signal stands down only for aggregator-verified lane rows');
});

test('ingest-urls routing: a hand dispatch for a leased show goes to the inbox; automation and partial runs do not', () => {
  assert.equal(ingestRouteDecision({ lease: null }).action, 'ingest');
  assert.equal(ingestRouteDecision({ lease: { holder: 'gha-1' } }).action, 'inbox');
  assert.equal(ingestRouteDecision({ lease: { holder: 'gha-1' }, caller: 'lane-inbox-drain' }).action, 'refuse');
  assert.equal(ingestRouteDecision({ lease: { holder: 'gha-1' }, dryRun: true }).action, 'refuse');
  assert.equal(ingestRouteDecision({ lease: { unknown: true } }).action, 'refuse');
});

test('drain waits while any lease holds the show, the lane\'s own included, read live from the store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7741-drain-'));
  try {
    const bare = path.join(root, 'remote.git'); const work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: work });
    Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
    assert.equal(liveLease(SHOW.id, work), null);
    assert.equal(drainAllowed(liveLease(SHOW.id, work)), true);
    const store = require('../../scripts/lib/opening-night-lane/lease-store.js');
    const leaseLib = require('../../scripts/lib/opening-night-lane/lease.js');
    const holder = 'gha-12345';
    const prev = process.env.OPENING_NIGHT_LANE_HOLDER; process.env.OPENING_NIGHT_LANE_HOLDER = holder; // the night job sets this
    try {
      const res = store.casTransition({ repoDir: work }, (st) => leaseLib.acquire(st, { show: SHOW.id, night: '2026-11-17', holder, now: Date.now() }));
      assert.equal(res.ok, true, JSON.stringify(res));
      const held = liveLease(SHOW.id, work);
      assert.equal(held && held.holder, holder);
      assert.equal(drainAllowed(held), false);
    } finally { if (prev === undefined) delete process.env.OPENING_NIGHT_LANE_HOLDER; else process.env.OPENING_NIGHT_LANE_HOLDER = prev; }
    assert.equal(drainAllowed(liveLease(SHOW.id, path.join(root, 'no-such-repo'))), false, 'an unreadable store holds the drain');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('drainPlan: only entries the lane did not finish go back to ingest-urls', () => {
  const { open, lines } = drainPlan([
    { id: 'a', url: URL1, critic: 'A Critic' }, { id: 'b', url: 'https://x.com/b', status: 'failed' },
    { id: 'c', url: 'https://x.com/c', status: 'published' }, { id: 'd', url: 'https://x.com/d', status: 'rejected' },
  ]);
  assert.deepEqual(open.map((e) => e.id), ['a', 'b']);
  assert.equal(lines.length, 2); assert.ok(lines[0].includes(URL1));
});

function laneNight({ entries, fetchDate, maxPasses = 1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7741-night-'));
  let doc = { reviews: [] };
  const marks = [];
  const run = runLaneNight({
    show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: dir, dryRun: true, maxPasses, passIntervalMs: 0,
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => [] }],
    fetchText: async () => '',
    fetchReview: async () => ({ outletId: 'theatermania', outlet: 'TheaterMania', criticName: '', fullText: 'A full review of the production. '.repeat(40), publishDate: fetchDate }),
    scoreReview: async () => 72,
    readInbox: async () => (typeof entries === 'function' ? entries() : entries),
    markInbox: async (updates) => { marks.push(...updates); },
    publishPorts: {
      updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; },
      regenShow: async () => ({}),
      deploy: async () => {},
      fetchLiveShow: async () => ({ rv: doc.reviews.map((r) => ({ u: r.url })) }),
    },
    now: () => Date.now(), wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return run.then((res) => ({ res, doc, marks })).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const entry = (extra = {}) => ({ id: `${SHOW.id}|abc`, holder: 'manual-inbox', show: SHOW.id, url: URL1, critic: 'A Critic', addedAt: new Date().toISOString(), addedBy: 'test', ...extra });

test('the lane publishes an inbox URL no adapter found, stamped manual, and marks it published', async () => {
  const { doc, marks, res } = await laneNight({ entries: [entry()], fetchDate: NIGHT });
  const row = doc.reviews.find((r) => r.url === URL1);
  assert.ok(row, 'manual URL published: ' + JSON.stringify({ marks, n: doc.reviews.length, res: { p: res.published, u: res.unpublished, inbox: res.inbox, rej: res.rejected } }).slice(0, 1500));
  assert.equal(row.criticName, 'A Critic', 'critic from the inbox entry');
  assert.equal(row[trust.PROVENANCE_KEY].source, 'manual');
  assert.ok(row.laneManualInbox && row.laneManualInbox.addedBy === 'test');
  assert.equal(trust.isLaneReview(row, { openingDate: NIGHT }), true, 'publish.js accepts it');
  for (const g of trust.LANE_BYPASSED_GUARDS) assert.equal(trust.laneBypasses(row, g, { openingDate: NIGHT }), false, `no ${g} bypass for a manual row`);
  assert.ok(marks.some((m) => m.id === entry().id && m.status === 'published'), JSON.stringify(marks));
});

test('an inbox URL dated far from the night is rejected and recorded, not published', async () => {
  const { doc, marks } = await laneNight({ entries: [entry()], fetchDate: '2019-03-01' });
  assert.equal(doc.reviews.length, 0);
  const m = marks.find((x) => x.status === 'rejected');
  assert.ok(m && /night-window/.test(m.reason), JSON.stringify(marks));
});

test('force publishes an off-date page; an undated page takes the inbox add date', async () => {
  const forced = await laneNight({ entries: [entry({ force: true })], fetchDate: '2019-03-01' });
  assert.equal(forced.doc.reviews.length, 1, JSON.stringify({ m: forced.marks, u: forced.res.unpublished, i: forced.res.inbox }));
  const undated = await laneNight({ entries: [entry()], fetchDate: null });
  const row = undated.doc.reviews[0];
  assert.ok(row, JSON.stringify(undated.marks));
  // The add date in the show's time zone (New York), so it can be the UTC day before.
  assert.ok(Math.abs(Date.parse(row.publishDate) - Date.parse(NIGHT)) <= 86400000, row.publishDate);
});

test('a URL re-added with force during the night is worked again on the next pass', async () => {
  let reads = 0;
  const first = entry();
  const second = entry({ force: true, addedAt: new Date(Date.parse(first.addedAt) + 60000).toISOString() });
  const { doc, marks } = await laneNight({ entries: () => (++reads === 1 ? [first] : [second]), fetchDate: '2019-03-01', maxPasses: 2 });
  assert.ok(marks.some((m) => m.status === 'rejected' && m.addedAt === first.addedAt), JSON.stringify(marks));
  assert.equal(doc.reviews.length, 1, 'the forced re-add is published: ' + JSON.stringify(marks));
  assert.ok(marks.some((m) => m.status === 'published' && m.addedAt === second.addedAt), JSON.stringify(marks));
});
