// BRO-4785 (epic BRO-4210 phase 3): the lane's publish path. Real functions only (CLAUDE.md section 15); the rehearsal runs
// against a local static server, so nothing here touches production.
// TESTS-VS-DERIVED-DATA-EXEMPT: every reviews.json here is a throwaway file in a temp git sandbox; no real data is read or pinned.
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

// ---- BRO-4823: real ports (temp git repos with a bare remote stand in for the private core-data repo) ---------------
const real = require('../../scripts/lib/opening-night-lane/real-ports.js');
const lease = require('../../scripts/lib/opening-night-lane/lease.js');
const { execFileSync } = require('node:child_process');
const HOLDER = 'lane-test-holder';

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** bare remote + the lane's core-data clone + a second clone for a concurrent writer + a Broadwayscore-like repoDir. */
function gitSandbox({ symlinkLayout = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4823-'));
  const remote = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  gitIn(dir, 'init', '--quiet', '--bare', '-b', 'main', remote);
  gitIn(dir, 'clone', '--quiet', remote, seed);
  fs.writeFileSync(path.join(seed, 'reviews.json'), `${JSON.stringify({ reviews: [row(OTHER, 'Time Out', 'A Critic', 'https://timeout.com/a')] }, null, 2)}\n`);
  gitIn(seed, 'add', 'reviews.json'); gitIn(seed, 'commit', '--quiet', '-m', 'seed'); gitIn(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  const coreDir = path.join(dir, 'core'); const otherWriter = path.join(dir, 'writer');
  gitIn(dir, 'clone', '--quiet', remote, coreDir); gitIn(dir, 'clone', '--quiet', remote, otherWriter);
  const repoDir = path.join(dir, 'site');
  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'public', 'data', 'shows'), { recursive: true });
  if (symlinkLayout) fs.symlinkSync(path.join(coreDir, 'reviews.json'), path.join(repoDir, 'data', 'reviews.json'));
  else fs.copyFileSync(path.join(coreDir, 'reviews.json'), path.join(repoDir, 'data', 'reviews.json')); // CI: checkout-core-data copies
  const generated = (dropUrl) => async (id) => { // stands in for generate-mobile-show-details.js --show=id
    const doc = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'reviews.json'), 'utf8'));
    const rv = doc.reviews.filter((r) => r.showId === id && r.url !== dropUrl).map((r) => ({ o: r.outlet, cn: r.criticName, u: r.url }));
    fs.writeFileSync(path.join(repoDir, 'public', 'data', 'shows', `${id}.json`), JSON.stringify({ id, rv }));
  };
  const remoteReviews = () => JSON.parse(execFileSync('git', ['show', 'main:reviews.json'], { cwd: remote, encoding: 'utf8' })).reviews;
  const leases = (holder, expiresAt = '2099-01-01T00:00:00.000Z', show = SHOW) => () => ({ state: { leases: { [`${show}|${NIGHT}`]: { holder, expiresAt } } } });
  return { dir, remote, coreDir, otherWriter, repoDir, generated, remoteReviews, leases, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}
const portsFor = (g, extra = {}) => real.createRealPublishPorts({ show: SHOW, repoDir: g.repoDir, coreDir: g.coreDir, holder: HOLDER, readLeases: g.leases(HOLDER), regen: g.generated(), sleep: async () => {}, ...extra });

test('real pushData: a concurrent writer\'s push lands first and both rows survive (CAS replay, no rebase -X theirs)', async () => {
  const g = gitSandbox();
  try {
    const ports = portsFor(g);
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, FIXTURE.map((f) => f.row)));
    // another workflow pushes a row for a different show to core data before the lane pushes
    const w = path.join(g.otherWriter, 'reviews.json');
    const doc = JSON.parse(fs.readFileSync(w, 'utf8'));
    doc.reviews.push(row(OTHER, 'Guardian', 'B Critic', 'https://theguardian.com/b'));
    fs.writeFileSync(w, `${JSON.stringify(doc, null, 2)}\n`);
    gitIn(g.otherWriter, 'commit', '--quiet', '-am', 'concurrent'); gitIn(g.otherWriter, 'push', '--quiet', 'origin', 'HEAD:main');

    const res = await ports.pushData();
    assert.equal(res.ok, true, res.stderr);
    const urls = g.remoteReviews().map((r) => r.url);
    assert.ok(urls.includes('https://theguardian.com/b'), 'the concurrent writer\'s row survived');
    assert.ok(urls.includes('https://timeout.com/a'));
    for (const f of FIXTURE) assert.ok(urls.includes(f.row.url), `lane row ${f.row.outlet} pushed`);
    assert.match(gitIn(g.coreDir, 'log', '-1', '--format=%s'), /^lane: other-desert-cities-2026 reviews \[skip ci\]$/);
    const site = JSON.parse(fs.readFileSync(path.join(g.repoDir, 'data', 'reviews.json'), 'utf8')).reviews.map((r) => r.url);
    assert.ok(site.includes('https://theguardian.com/b'), 'the generator\'s copy is refreshed to the pushed tip');
    assert.deepEqual(await ports.pushData(), { ok: true, stderr: '' }, 'nothing left to push');
  } finally { g.cleanup(); }
});

test('real pushData: refuses to reset a core-data checkout with foreign uncommitted changes or unpushed commits', async () => {
  const g = gitSandbox();
  try {
    fs.writeFileSync(path.join(g.coreDir, 'shows.json'), '[]\n');
    gitIn(g.coreDir, 'add', 'shows.json');
    const ports = portsFor(g);
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row]));
    let res = await ports.pushData();
    assert.equal(res.ok, false);
    assert.match(res.stderr, /uncommitted changes/);
    gitIn(g.coreDir, 'commit', '--quiet', '-m', 'local only');
    res = await ports.pushData();
    assert.equal(res.ok, false);
    assert.match(res.stderr, /1 unpushed commit/);
    assert.equal(g.remoteReviews().length, 1, 'remote untouched');
    assert.ok(fs.existsSync(path.join(g.coreDir, 'shows.json')), 'local work not discarded');
  } finally { g.cleanup(); }
});

test('real pushData: a failed push is reported, never thrown, and publish stops before regenerate', async () => {
  const g = gitSandbox();
  try {
    const ports = portsFor(g, { remote: 'https://lane-user:s3cret-token@127.0.0.1:9/core.git', attempts: 2 });
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row]));
    const res = await ports.pushData();
    assert.equal(res.ok, false);
    assert.ok(res.stderr.length > 0);
    assert.ok(!res.stderr.includes('s3cret-token'), `credentials never reach the error text: ${res.stderr}`);
  } finally { g.cleanup(); }
});

test('real isLeased: only a live lease held by this lane\'s holder, for the bound show, from the shared store', async () => {
  const g = gitSandbox();
  try {
    const at = (readLeases) => portsFor(g, { readLeases, now: () => '2026-10-19T00:00:00.000Z' }).isLeased(SHOW);
    assert.equal(await at(g.leases(HOLDER)), true);
    assert.equal(await at(g.leases('someone-else')), false, 'another holder');
    assert.equal(await at(g.leases(HOLDER, '2026-10-18T23:00:00.000Z')), false, 'expired');
    assert.equal(await at(g.leases(HOLDER, undefined, OTHER)), false, 'lease is for another show');
    assert.equal(await at(() => { throw new Error('ls-remote failed'); }), false, 'unreadable store refuses');
    assert.equal(await portsFor(g).isLeased(OTHER), false, 'ports are bound to one show');
    assert.equal(lease.activeLeaseFor(g.leases(HOLDER)().state, SHOW, { now: '2026-10-19T00:00:00.000Z', ignoreHolder: HOLDER }), null,
      'why lease-guard (which ignores our own holder) cannot answer this');
    assert.throws(() => real.createRealPublishPorts({ show: SHOW, repoDir: g.repoDir, coreDir: g.coreDir }), /holder is required/);
  } finally { g.cleanup(); }
});

test('real ports end to end: a row the generator leaves out is dropped (not awaited, not blocking); the rest go live', async () => {
  const g = gitSandbox();
  const ledgerDir = path.join(g.dir, 'ledger');
  const server = await pub.startStaticServer(path.join(g.repoDir, 'public')); // stands in for the live site after a deploy
  try {
    const dropUrl = FIXTURE[2].row.url;
    const ports = portsFor(g, { regen: g.generated(dropUrl), baseUrl: server.baseUrl });
    const deployed = await ports.deploy();
    assert.match(deployed.shippedBy, /core-data push/, 'deploy commits nothing: the core-data push is what ships');
    const res = await pub.publishLaneReviews({ show: SHOW, night: NIGHT, rows: FIXTURE, ledgerDir, ports, pollMs: 1, timeoutMs: 2000 });
    assert.deepEqual(res.dropped, [FIXTURE[2].key]);
    assert.deepEqual(res.verified.sort(), [FIXTURE[0].key, FIXTURE[1].key].sort());
    assert.deepEqual(res.missing, []);
    assert.equal(res.timedOut, false);
    const stages = ledger.readLedger(ledgerDir, SHOW, NIGHT).events.filter((e) => e.reviewKey === FIXTURE[2].key).map((e) => e.stage);
    assert.ok(!stages.includes('rebuilt') && !stages.includes('verified-live'), `dropped row logged no rebuilt/live: ${stages}`);
    assert.ok(g.remoteReviews().some((r) => r.url === dropUrl), 'the dropped row is still in core data (it was merged), only not awaited');
  } finally { await server.close(); g.cleanup(); }
});

test('real ports: the local symlink layout (data/reviews.json -> core checkout) pushes through the link', async () => {
  const g = gitSandbox({ symlinkLayout: true });
  try {
    const ports = portsFor(g);
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[1].row]));
    const res = await ports.pushData();
    assert.equal(res.ok, true, res.stderr);
    assert.ok(g.remoteReviews().some((r) => r.url === FIXTURE[1].row.url));
    assert.ok(fs.lstatSync(path.join(g.repoDir, 'data', 'reviews.json')).isSymbolicLink(), 'link survives');
  } finally { g.cleanup(); }
});

test('real pushData: a push rejected after the commit leaves no lane commit behind, so the next batch can still push', async () => {
  const g = gitSandbox();
  const hook = path.join(g.remote, 'hooks', 'pre-receive');
  try {
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected by test >&2\nexit 1\n', { mode: 0o755 });
    const start = gitIn(g.coreDir, 'rev-parse', 'HEAD');
    const ports = portsFor(g, { attempts: 2 });
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row]));
    const res = await ports.pushData();
    assert.equal(res.ok, false);
    assert.equal(gitIn(g.coreDir, 'rev-parse', 'HEAD'), start, 'reset back to where it started');
    fs.rmSync(hook);
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[1].row]));
    const again = await ports.pushData();
    assert.equal(again.ok, true, again.stderr);
    const urls = g.remoteReviews().map((r) => r.url);
    assert.ok(urls.includes(FIXTURE[0].row.url) && urls.includes(FIXTURE[1].row.url), 'the failed batch rides the next push');
  } finally { g.cleanup(); }
});

test('real pushData: two batches pushing at once are serialized and both land', async () => {
  const g = gitSandbox();
  try {
    const ports = portsFor(g);
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[0].row]));
    const a = ports.pushData();
    await ports.updateReviews((doc) => pub.mergeShowRows(doc, SHOW, [FIXTURE[2].row]));
    const b = ports.pushData();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true, ra.stderr); assert.equal(rb.ok, true, rb.stderr);
    const urls = g.remoteReviews().map((r) => r.url);
    assert.ok(urls.includes(FIXTURE[0].row.url) && urls.includes(FIXTURE[2].row.url));
  } finally { g.cleanup(); }
});

test('real isLeased: our lease is found even when another holder holds the same show on another night', async () => {
  const g = gitSandbox();
  try {
    const readLeases = () => ({ state: { leases: {
      [`${SHOW}|2026-10-17`]: { holder: 'someone-else', expiresAt: '2099-01-01T00:00:00.000Z' },
      [`${SHOW}|${NIGHT}`]: { holder: HOLDER, expiresAt: '2099-01-01T00:00:00.000Z' },
    } } });
    assert.equal(await portsFor(g, { readLeases }).isLeased(SHOW), true);
  } finally { g.cleanup(); }
});
