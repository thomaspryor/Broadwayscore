// BRO-4785 (epic BRO-4210 phase 3): the lane's publish path. Real functions only (CLAUDE.md section 15); the rehearsal runs
// against a local static server, so nothing here touches production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pub = require('../../scripts/lib/opening-night-lane/publish.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');

const SHOW = 'other-desert-cities-2026';
const OTHER = 'some-other-show-2026';
const NIGHT = '2026-10-18';

const lane = (showId) => ({ productionVerified: 'aggregator', openingNightLane: { show: showId, night: NIGHT, source: 'aggregator', seenAt: '2026-10-19T00:30:00.000Z' } });
const row = (showId, outlet, critic, url, extra = {}) => ({ showId, outlet, criticName: critic, url, assignedScore: 80, contentTier: 'complete', ...extra });
const laneRow = (...a) => { const r = row(...a); return { ...r, ...lane(r.showId) }; };
const FIXTURE = [
  { key: 'https://nytimes.com/2026/10/19/theater/odc-review.html', row: laneRow(SHOW, 'The New York Times', 'Jesse Green', 'https://www.nytimes.com/2026/10/19/theater/odc-review.html?partner=rss') },
  { key: 'https://vulture.com/article/odc-review.html', row: laneRow(SHOW, 'Vulture', 'Jackson McHenry', 'https://www.vulture.com/article/odc-review.html') },
  { key: 'https://variety.com/2026/legit/reviews/odc-1236', row: laneRow(SHOW, 'Variety', 'Frank Rizzo', 'https://variety.com/2026/legit/reviews/odc-1236/') },
];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4785-'));
  const reviewsFile = path.join(dir, 'reviews.json');
  const baseline = { _meta: { lastUpdated: 'x' }, reviews: [row(OTHER, 'Time Out', 'A Critic', 'https://timeout.com/a'), row(OTHER, 'Guardian', 'B Critic', 'https://theguardian.com/b')] };
  fs.writeFileSync(reviewsFile, JSON.stringify(baseline));
  const publicDir = path.join(dir, 'public'); const liveDir = path.join(dir, 'live');
  fs.mkdirSync(path.join(publicDir, 'data', 'shows'), { recursive: true });
  const regenShow = async (id) => {
    const doc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
    fs.writeFileSync(path.join(publicDir, 'data', 'shows', `${id}.json`), JSON.stringify({ id, rv: doc.reviews.filter((r) => r.showId === id).map((r) => ({ o: r.outlet, cn: r.criticName, u: r.url })) }));
  };
  return { dir, reviewsFile, publicDir, liveDir, regenShow, baseline, ledgerDir: path.join(dir, 'ledger'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

test('mergeShowRows: other shows untouched, new rows added, same identity resolved by the shared rules, wrong-show row refused', () => {
  const doc = { reviews: [row(OTHER, 'Time Out', 'A Critic', 'https://timeout.com/a'), row(SHOW, 'Vulture', 'Jackson McHenry', 'https://www.vulture.com/old', { assignedScore: 50, contentTier: 'stub' }), row(SHOW, 'Variety', 'Frank Rizzo', 'https://variety.com/m', { manualEntry: true, assignedScore: 99 })] };
  const out = pub.mergeShowRows(doc, SHOW, FIXTURE.map((f) => f.row));
  assert.equal(out.added, 1, 'NYT is new');
  assert.equal(out.replaced, 1, 'the stub Vulture row is replaced by the complete one');
  assert.equal(out.kept, 1, 'a manual correction is never overwritten by a lane row');
  assert.strictEqual(out.doc.reviews[0], doc.reviews[0], 'the other show row is the same object');
  assert.equal(out.doc.reviews.find((r) => r.outlet === 'Variety').assignedScore, 99);
  assert.equal(doc.reviews.length, 3, 'input not mutated');
  assert.throws(() => pub.mergeShowRows(doc, SHOW, [row(OTHER, 'X', 'Y', 'https://x.com/y')]), /publish/);
  assert.throws(() => pub.mergeShowRows(doc, '', []), /showId/);
});

test('mergeShowRows: a byline swap on the same URL does not create a duplicate critic', () => {
  const doc = { reviews: [row(SHOW, 'The New York Times', 'J. Green', 'https://www.nytimes.com/2026/10/19/theater/odc-review.html', { contentTier: 'stub' })] };
  const out = pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row]);
  assert.equal(out.doc.reviews.length, 1);
  assert.equal(out.replaced, 1);
});

test('reviews file port: a concurrent writer\'s rows for other shows survive (the merge-by-key proof)', async () => {
  const s = sandbox();
  try {
    let injected = false;
    const port = pub.createReviewsFilePort(s.reviewsFile, { beforeWrite: () => {
      if (injected) return; injected = true;
      const doc = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8'));
      doc.reviews.push(row('late-arrival-2026', 'NY Post', 'C Critic', 'https://nypost.com/c')); // another workflow writes mid-publish
      fs.writeFileSync(s.reviewsFile, JSON.stringify(doc));
    } });
    const out = await port.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, FIXTURE.map((f) => f.row)));
    const final = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')).reviews;
    assert.equal(out.added, 3);
    assert.ok(final.some((r) => r.showId === 'late-arrival-2026'), 'the concurrent writer\'s row survived');
    assert.equal(final.filter((r) => r.showId === SHOW).length, 3);
    assert.equal(final.filter((r) => r.showId === OTHER).length, 2);
    assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  } finally { s.cleanup(); }
});

test('reviews file port: a file that never stops changing is not overwritten', async () => {
  const s = sandbox();
  try {
    const before = fs.readFileSync(s.reviewsFile, 'utf8');
    let n = 0;
    const port = pub.createReviewsFilePort(s.reviewsFile, { attempts: 3, beforeWrite: () => { const d = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')); d.reviews.push(row('x-' + (n++), 'O', 'C', 'https://x.com/' + n)); fs.writeFileSync(s.reviewsFile, JSON.stringify(d)); } });
    await assert.rejects(port.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row])), /kept changing/);
    const after = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')).reviews;
    assert.ok(!after.some((r) => r.showId === SHOW), 'nothing of ours was written');
    assert.ok(after.length > JSON.parse(before).reviews.length, 'and the other writer\'s rows are all there');
  } finally { s.cleanup(); }
});

test('dry-run publish against a local static server reaches verified-live for every fixture review, with ledger events in order', async () => {
  const s = sandbox();
  const server = await pub.startStaticServer(s.liveDir);
  try {
    fs.mkdirSync(s.liveDir, { recursive: true });
    const ports = { ...pub.createReviewsFilePort(s.reviewsFile), regenShow: s.regenShow, deploy: pub.dryRunDeploy({ publicDir: s.publicDir, liveDir: s.liveDir, showId: SHOW, delayMs: 60 }), fetchLiveShow: pub.fetchLiveShowFrom(server.baseUrl) };
    const res = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports, pollMs: 15, timeoutMs: 5000, dryRun: true });
    assert.equal(res.timedOut, false);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.verified.sort(), FIXTURE.map((f) => f.key).sort());
    const { events } = ledger.readLedger(s.ledgerDir, SHOW, NIGHT);
    for (const f of FIXTURE) {
      const stages = events.filter((e) => e.reviewKey === f.key).map((e) => e.stage);
      assert.deepEqual(stages, ['rebuilt', 'deployed', 'verified-live']);
    }
    const verdict = ledger.rehearsalVerdict([...events, ...FIXTURE.map((f) => ledger.buildEvent({ show: SHOW, night: NIGHT, reviewKey: f.key, stage: 'discovered', at: Date.now() - 1000 }))], { expectedKeys: FIXTURE.map((f) => f.key) });
    assert.ok(verdict, 'the ledger summarises into a rehearsal verdict');
    assert.equal(JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')).reviews.filter((r) => r.showId === OTHER).length, 2, 'other shows survived the publish');
  } finally { await server.close(); s.cleanup(); }
});

test('verification waits for the live copy: a review is not verified before it is actually served', async () => {
  const s = sandbox();
  try {
    let polls = 0;
    const ports = { ...pub.createReviewsFilePort(s.reviewsFile), regenShow: s.regenShow, deploy: async () => {},
      fetchLiveShow: async () => { polls++; return polls < 3 ? { rv: [] } : { rv: [{ u: FIXTURE[0].row.url }] }; } };
    const res = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: [FIXTURE[0]], ledgerDir: s.ledgerDir, ports, pollMs: 1, timeoutMs: 5000, sleep: async () => {}, dryRun: true });
    assert.equal(polls, 3);
    assert.deepEqual(res.verified, [FIXTURE[0].key], 'a tracking-param spelling of the same URL counts as live');
  } finally { s.cleanup(); }
});

test('a review that never goes live is reported missing after the timeout, with no verified-live event', async () => {
  const s = sandbox();
  try {
    let t = 0;
    const ports = { ...pub.createReviewsFilePort(s.reviewsFile), regenShow: s.regenShow, deploy: async () => {}, fetchLiveShow: async () => { throw new Error('503'); } };
    const res = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE.slice(0, 2), ledgerDir: s.ledgerDir, ports, pollMs: 1, timeoutMs: 100, now: () => (t += 40), sleep: async () => {}, dryRun: true });
    assert.equal(res.timedOut, true);
    assert.equal(res.missing.length, 2);
    const { events } = ledger.readLedger(s.ledgerDir, SHOW, NIGHT);
    assert.ok(!events.some((e) => e.stage === 'verified-live'));
    assert.equal(events.filter((e) => e.stage === 'deployed').length, 2, 'what was reached stays recorded');
  } finally { s.cleanup(); }
});

test('a failed core-data push stops the publish before regenerate and deploy', async () => {
  const s = sandbox();
  try {
    const calls = [];
    const ports = { ...pub.createReviewsFilePort(s.reviewsFile), pushData: async () => ({ ok: false, stderr: 'rejected' }), regenShow: async () => calls.push('regen'), deploy: async () => calls.push('deploy'), fetchLiveShow: async () => ({}) };
    await assert.rejects(pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports: { ...ports, isLeased: async () => true } }), /pushing core data failed/);
    assert.deepEqual(calls, []);
    assert.equal(ledger.readLedger(s.ledgerDir, SHOW, NIGHT).events.length, 0, 'no rebuilt event for a publish that did not happen');
  } finally { s.cleanup(); }
});

test('publishLaneReviews: no rows is a no-op; missing ports and inputs are refused', async () => {
  const noop = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: [], ledgerDir: '/nonexistent', ports: {} });
  assert.deepEqual(noop.verified, []);
  await assert.rejects(pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: '/tmp/x', ports: { updateReviews() {} } }), /port "regenShow"/);
  await assert.rejects(pub.publishLaneReviews({ night: NIGHT, rows: FIXTURE }), /required/);
});

test('static server: serves files under its root only', async () => {
  const s = sandbox();
  const server = await pub.startStaticServer(s.publicDir);
  try {
    fs.writeFileSync(path.join(s.publicDir, 'data', 'shows', 'a.json'), '{"ok":1}');
    assert.equal((await fetch(`${server.baseUrl}/data/shows/a.json`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/data/shows/missing.json`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/%2e%2e/reviews.json`)).status, 404, 'no path traversal');
  } finally { await server.close(); s.cleanup(); }
});

test('fetchLiveShowFrom busts caches: every poll has a distinct query and no-cache headers', async () => {
  const seen = [];
  const f = pub.fetchLiveShowFrom('https://example.com/', { fetchImpl: async (url, opts) => { seen.push([url, opts.headers['cache-control']]); return { ok: true, json: async () => ({ rv: [] }) }; } });
  await f(SHOW); await new Promise((r) => setTimeout(r, 3)); await f(SHOW);
  assert.match(seen[0][0], /^https:\/\/example\.com\/data\/shows\/other-desert-cities-2026\.json\?cb=\d+$/);
  assert.notEqual(seen[0][0], seen[1][0]);
  assert.equal(seen[0][1], 'no-cache');
});

test('tie and manual rules: a same-tier lane rescore takes the incoming row; a kept manual row is not awaited at verification', async () => {
  const same = { reviews: [row(SHOW, 'Vulture', 'Jackson McHenry', 'https://www.vulture.com/article/odc-review.html', { assignedScore: 60 })] };
  const out = pub.mergeShowRows(same, SHOW, [FIXTURE[1].row]);
  assert.equal(out.replaced, 1);
  assert.equal(out.doc.reviews[0].assignedScore, 80);
  const s = sandbox();
  try {
    const doc = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8'));
    doc.reviews.push(row(SHOW, 'Variety', 'Frank Rizzo', 'https://variety.com/manual', { manualEntry: true }));
    fs.writeFileSync(s.reviewsFile, JSON.stringify(doc));
    const ports = { ...pub.createReviewsFilePort(s.reviewsFile), regenShow: s.regenShow, deploy: async () => {}, fetchLiveShow: async () => ({ rv: [{ u: FIXTURE[0].row.url }, { u: FIXTURE[1].row.url }] }) };
    const res = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports, pollMs: 1, timeoutMs: 50, sleep: async () => {}, dryRun: true });
    assert.equal(res.timedOut, false, 'the kept Variety row is never waited for');
    assert.deepEqual(res.missing, []);
    assert.equal(res.merge.kept, 1);
  } finally { s.cleanup(); }
});

test('rows that are not lane reviews, have no score, or have no canonical URL are refused before anything is written', () => {
  const ok = FIXTURE[0].row;
  const { productionVerified, ...noStamp } = ok;
  assert.throws(() => pub.mergeShowRows({ reviews: [] }, SHOW, [noStamp]), /not a lane review/);
  assert.throws(() => pub.mergeShowRows({ reviews: [] }, SHOW, [{ ...ok, assignedScore: null }]), /no score/);
  assert.throws(() => pub.mergeShowRows({ reviews: [] }, SHOW, [{ ...ok, url: 'https://feedproxy.google.com/~r/x/1' }]), /canonical/);
  assert.throws(() => pub.mergeShowRows({ reviews: [] }, SHOW, [ok], { openingDate: '2026-10-20' }), /not a lane review/, 'stamped night must be the opening night');
});

test('a real publish needs pushData and a lease; dry-run rehearsal needs neither', async () => {
  const s = sandbox();
  try {
    const base = { ...pub.createReviewsFilePort(s.reviewsFile), regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({}) };
    await assert.rejects(pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports: base }), /pushData/);
    await assert.rejects(pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports: { ...base, pushData: async () => ({ ok: true }) } }), /isLeased/);
    await assert.rejects(pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir: s.ledgerDir, ports: { ...base, pushData: async () => ({ ok: true }), isLeased: async () => false } }), /not leased/);
    assert.ok(!JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')).reviews.some((r) => r.showId === SHOW), 'nothing written by a refused publish');
  } finally { s.cleanup(); }
});

test('reviews file port: writes through a symlink (the link survives), keeps the 2-space layout, and a writer landing after the temp write is not lost', async () => {
  const s = sandbox();
  try {
    const link = path.join(s.dir, 'link-reviews.json');
    fs.symlinkSync(s.reviewsFile, link);
    let hit = false;
    const port = pub.createReviewsFilePort(link, { beforeRename: () => {
      if (hit) return; hit = true;
      const d = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8')); d.reviews.push(row('late-2026', 'O', 'C', 'https://late.com/x')); fs.writeFileSync(s.reviewsFile, JSON.stringify(d));
    } });
    await port.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, FIXTURE.map((f) => f.row)));
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink was not replaced');
    const text = fs.readFileSync(s.reviewsFile, 'utf8');
    assert.match(text, /^\{\n  "_meta"/, 'pretty-printed like the rebuild output');
    const final = JSON.parse(text).reviews;
    assert.ok(final.some((r) => r.showId === 'late-2026'), 'the writer that landed between temp write and rename survived');
    assert.equal(final.filter((r) => r.showId === SHOW).length, 3);
    assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { s.cleanup(); }
});
