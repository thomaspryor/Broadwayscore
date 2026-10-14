// BRO-4787 (epic BRO-4210 phase 4): the rehearsal is the epic's acceptance test. Real functions only (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const rh = require('../../scripts/lib/opening-night-lane/rehearsal.js');
const { buildSyntheticFixture } = require('../../scripts/lib/opening-night-lane/rehearsal-fixture.js');
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');
const discovery = require('../../scripts/lib/opening-night-lane/discovery.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');
const { runLaneNight, loadDone } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const publishMod = require('../../scripts/lib/opening-night-lane/publish.js');

const CLI = new URL('../../scripts/opening-night-lane-rehearse.js', import.meta.url).pathname;
const DAY = 24 * 60 * 60 * 1000;

test('synthetic fixture: 35 reviews, every host a registered outlet, decoys not among them, a paywalled NYT with no text', () => {
  const f = buildSyntheticFixture();
  assert.equal(f.reviews.length, 35);
  assert.equal(new Set(f.expectedKeys).size, 35, 'canonical keys are unique');
  for (const r of f.reviews) assert.ok(resolveOutletFromUrl(r.url), `${r.host} must resolve to a registered outlet`);
  for (const d of f.decoys) assert.ok(!f.expectedKeys.includes(discovery.canonicalUrl(d)));
  const nyt = f.reviews.find((r) => r.outletId === 'nytimes');
  assert.equal(nyt.text, '');
  assert.equal(f.reviews.filter((r) => r.criticName === 'Chris Example').length, 2, 'the syndicated critic appears on two outlets');
  assert.deepEqual(buildSyntheticFixture(), f, 'deterministic');
});

test('rehearsal replay: every fixture review reaches verified-live in under 20 minutes with zero manual steps', async () => {
  const fixture = buildSyntheticFixture();
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, true, JSON.stringify(res.verdict.failures.slice(0, 3)));
  assert.equal(res.verdict.checked, 35);
  assert.equal(res.summary.total, 35);
  assert.equal(res.summary.live, 35);
  assert.ok(res.summary.maxMs < ledger.DEFAULT_MAX_MS, `max time-to-live ${res.summary.maxMs}ms`);
  for (const r of res.summary.reviews) { assert.equal(r.manual, false); assert.deepEqual(r.skipped, []); assert.equal(r.lastStage, 'verified-live'); }
  assert.deepEqual(res.checks.unexpected, []);
  assert.deepEqual(res.checks.decoyLeaks, []);
  assert.equal(res.checks.bystandersSurvived, true);
});

test('rehearsal keeps the work dir on request and publishes lane-stamped rows, the paywalled NYT on its aggregator fallback score', async () => {
  const fixture = buildSyntheticFixture();
  const res = await rh.runRehearsal({ fixture, keep: true });
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(res.workDir, 'reviews.json'), 'utf8'));
    const mine = doc.reviews.filter((r) => r.showId === fixture.show.id);
    assert.equal(mine.length, 35);
    assert.ok(mine.every((r) => r.productionVerified === 'aggregator' && r.openingNightLane && r.assignedScore != null));
    const nyt = mine.find((r) => r.outletId === 'nytimes');
    assert.equal(nyt.needsRecollection, true);
    assert.equal(nyt.scoreConfidence, 'low');
    assert.equal(nyt.scoreSource, 'lane-aggregator-thumb');
    assert.equal(doc.reviews.filter((r) => r.showId === 'rehearsal-bystander-2026').length, 2);
  } finally { fs.rmSync(res.workDir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a broken lane fails the rehearsal: a source page that goes missing leaves reviews never logged', async () => {
  const fixture = buildSyntheticFixture();
  for (const u of Object.keys(fixture.pages)) if (u.includes('didtheylikeit.com/shows')) delete fixture.pages[u];
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, false);
  assert.ok(res.verdict.failures.some((f) => f.reason === 'never-logged'));
  assert.ok(res.verdict.failures.length >= 3, 'the three DTLI-only reviews');
});

test('a slow lane fails the rehearsal: a 25-minute deploy (a real burst night) breaks the 20-minute bar', async () => {
  const res = await rh.runRehearsal({ fixture: buildSyntheticFixture(), latency: { deployMs: 25 * 60 * 1000 } });
  assert.equal(res.pass, false);
  assert.ok(res.verdict.failures.some((f) => f.reason === 'too-slow' || f.reason === 'not-live'));
});

test('time is modelled, not counted: reading the clock does not advance it, and the modelled stages add up', async () => {
  const res = await rh.runRehearsal({ fixture: buildSyntheticFixture(), latency: { fetchMs: 0, scoreMs: 0, regenMs: 0, deployMs: 0, cdnMs: 0, pollMs: 1000 } });
  assert.equal(res.pass, true);
  assert.ok(res.summary.maxMs <= 5000, `with every modelled cost at zero the lane is near-instant, got ${res.summary.maxMs}ms`);
  const slow = await rh.runRehearsal({ fixture: buildSyntheticFixture() });
  assert.ok(slow.summary.maxMs > 10 * 60 * 1000, 'the default model (8 min deploy + 2 min CDN + work) costs real minutes');
  assert.ok(slow.summary.maxMs < ledger.DEFAULT_MAX_MS);
});

test('late reviews and a transient failure: reviews added 30 minutes in are caught, and a failed date check is retried on a later pass', async () => {
  const fixture = buildSyntheticFixture();
  const res = await rh.runRehearsal({ fixture, keep: true });
  try {
    assert.equal(res.pass, true);
    assert.ok(res.checks.passes > 2, 'more than one pass ran');
    assert.ok(res.checks.errors.some((e) => /503/.test(e.error)), 'the transient 503 was recorded');
    const events = ledger.readLedger(path.join(res.workDir, 'ledger'), fixture.show.id, fixture.night).events;
    const firstSeen = (key) => Date.parse(events.find((e) => e.reviewKey === key && e.stage === 'discovered').at);
    const late = fixture.reviews.filter((r) => r.via === 'bww-roundup').slice(-3).map((r) => discovery.canonicalUrl(r.url));
    const early = discovery.canonicalUrl(fixture.reviews[1].url);
    for (const k of late) assert.ok(firstSeen(k) - firstSeen(early) >= 29 * 60 * 1000, 'a late review is discovered after the wave, not at the start');
  } finally { fs.rmSync(res.workDir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a review the fixture does not expect is a failure, not a bonus', async () => {
  const fixture = buildSyntheticFixture();
  fixture.expectedKeys = fixture.expectedKeys.slice(1); // pretend the first one is not expected
  fixture.reviews = fixture.reviews.slice(1);
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, false);
  assert.equal(res.checks.unexpected.length, 1);
});

test('runRehearsal refuses a malformed fixture', async () => {
  await assert.rejects(rh.runRehearsal({}), /fixture needs/);
  await assert.rejects(rh.runRehearsal({ fixture: { show: { id: 'x' } } }), /fixture needs/);
});

test('armDecision: only a recent, passing rehearsal arms the lane', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const rec = (over = {}) => ({ at: '2026-10-12T12:00:00Z', pass: true, checked: 35, laneHash: 'abc', ...over });
  assert.deepEqual(rh.armDecision(rec(), { now }), { arm: true, reason: 'last-rehearsal-passed' });
  assert.equal(rh.armDecision(null, { now }).reason, 'no-rehearsal-record');
  assert.equal(rh.armDecision('x', { now }).reason, 'no-rehearsal-record');
  assert.equal(rh.armDecision(rec({ pass: false }), { now }).reason, 'last-rehearsal-failed');
  assert.equal(rh.armDecision(rec({ pass: 'yes' }), { now }).reason, 'last-rehearsal-failed', 'truthy is not true');
  assert.equal(rh.armDecision(rec({ at: 'last week' }), { now }).reason, 'rehearsal-date-unreadable');
  assert.equal(rh.armDecision(rec({ at: '2026-10-05T11:59:00Z' }), { now }).reason, 'rehearsal-stale');
  assert.equal(rh.armDecision(rec({ at: new Date(now - 8 * DAY).toISOString() }), { now }).arm, true, 'exactly at the limit still arms');
  assert.equal(rh.armDecision(rec({ at: '2026-10-20T00:00:00Z' }), { now }).reason, 'rehearsal-dated-in-the-future');
  assert.equal(rh.armDecision(rec({ at: new Date(now - 2 * DAY).toISOString() }), { now, maxAgeMs: DAY }).reason, 'rehearsal-stale');
  assert.equal(rh.armDecision(rec({ at: '2026-09-01T00:00:00Z' }), { now, maxAgeMs: NaN }).reason, 'bad-max-age', 'a NaN limit must not make every record fresh');
  assert.equal(rh.armDecision(rec(), { now, maxAgeMs: 0 }).reason, 'bad-max-age');
  assert.equal(rh.armDecision(rec({ checked: 0 }), { now }).reason, 'rehearsal-checked-nothing');
  assert.equal(rh.armDecision(rec({ checked: undefined }), { now }).reason, 'rehearsal-checked-nothing');
  assert.equal(rh.armDecision(rec(), { now, laneHash: 'abc' }).arm, true);
  assert.equal(rh.armDecision(rec(), { now, laneHash: 'different' }).reason, 'lane-changed-since-rehearsal', 'a pass vouches only for the code that passed');
  assert.equal(rh.armDecision(rec({ laneHash: undefined }), { now, laneHash: 'abc' }).reason, 'lane-changed-since-rehearsal');
});

test('laneCodeHash changes when any lane file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787h-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'one');
    const h1 = rh.laneCodeHash(dir);
    assert.equal(rh.laneCodeHash(dir), h1);
    fs.writeFileSync(path.join(dir, 'a.js'), 'two');
    assert.notEqual(rh.laneCodeHash(dir), h1);
    fs.writeFileSync(path.join(dir, 'b.js'), 'x');
    assert.notEqual(rh.laneCodeHash(dir), rh.laneCodeHash(dir) + 'x');
    assert.match(rh.laneCodeHash(), /^[0-9a-f]{16}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('lane-runner: refuses missing ports; a fetch that throws is retried on the next pass instead of being lost', async () => {
  await assert.rejects(runLaneNight({ show: { id: 'x', title: 'X' } }), /is required/);
  const fixture = buildSyntheticFixture();
  const pages = { ...fixture.pages };
  let calls = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787r-'));
  try {
    let t = Date.parse('2026-10-18T22:00:00-04:00');
    const reviewsFile = path.join(dir, 'reviews.json');
    fs.writeFileSync(reviewsFile, JSON.stringify({ reviews: [] }));
    const publishPorts = { ...require('../../scripts/lib/opening-night-lane/publish.js').createReviewsFilePort(reviewsFile), regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews.map((r) => ({ u: r.url })) }) };
    const byKey = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), r]));
    const res = await runLaneNight({
      show: fixture.show, night: fixture.night, openingDate: fixture.openingDate, adapters: [discovery.bwwRoundupAdapter()], fetchText: async (u) => { if (!(u in pages)) throw new Error('404'); return pages[u]; },
      ledgerDir: path.join(dir, 'ledger'), publishPorts, dryRun: true, now: () => t, wait: async (ms) => { t += ms; },
      fetchReview: async (c) => { calls++; if (calls === 1) throw new Error('timeout'); const e = byKey.get(c.key); return { outletId: e.outletId, outlet: e.outletId, criticName: e.criticName, fullText: e.text, aggregator: e.aggregator, score: e.score }; },
      scoreReview: (row, f) => f.score,
    });
    assert.equal(res.errors.filter((e) => /timeout/.test(e.error)).length, 1);
    assert.equal(res.admitted.length, 19, 'the 19 reviews on the roundup page: the one that failed once came back on the next pass');
    assert.deepEqual(res.unpublished, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('recordRehearsal / readRehearsalRecord round trip; a missing or corrupt record reads as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787-'));
  try {
    const file = path.join(dir, 'nested', 'rec.json');
    const rec = rh.recordRehearsal(file, { pass: true, verdict: { checked: 35, failures: [] }, checks: { unexpected: [], decoyLeaks: [], bystandersSurvived: true, timedOut: false } }, { at: Date.parse('2026-10-14T00:00:00Z') });
    assert.deepEqual(rh.readRehearsalRecord(file), rec);
    assert.equal(rec.pass, true);
    const failed = rh.recordRehearsal(file, { pass: false, verdict: { checked: 3, failures: Array.from({ length: 30 }, (_, i) => ({ reviewKey: `k${i}`, reason: 'never-logged' })) } }, { at: 0 });
    assert.equal(failed.failures.length, 10, 'failures trimmed');
    assert.equal(rh.readRehearsalRecord(path.join(dir, 'missing.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(rh.readRehearsalRecord(path.join(dir, 'bad.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('CLI: --rehearse writes a passing record and --arm-check arms on it; tampering or a missing record refuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787-'));
  try {
    const out = path.join(dir, 'lane-rehearsal.json');
    const stdout = execFileSync('node', [CLI, '--rehearse', '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(JSON.parse(stdout.trim().split('\n').pop()).pass, true);
    const armed = spawnSync('node', [CLI, '--arm-check', '--record', out], { encoding: 'utf8' });
    assert.equal(armed.status, 0);
    assert.equal(JSON.parse(armed.stdout).arm, true);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.writeFileSync(out, JSON.stringify({ ...rec, pass: false }));
    assert.equal(spawnSync('node', [CLI, '--arm-check', '--record', out], { encoding: 'utf8' }).status, 3);
    assert.equal(spawnSync('node', [CLI, '--arm-check', '--record', path.join(dir, 'nope.json')], { encoding: 'utf8' }).status, 3);
    assert.equal(spawnSync('node', [CLI], { encoding: 'utf8' }).status, 2, 'no mode is a usage error');
    assert.equal(spawnSync('node', [CLI, '--rehearse', '--fixture', 'paranormal-activity'], { encoding: 'utf8' }).status, 2, 'an unrecorded fixture is refused, not faked');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('strictly one publish at a time cannot meet the 20-minute bar for a straggler (the rehearsal finding); overlap does', async () => {
  const one = await rh.runRehearsal({ fixture: buildSyntheticFixture(), maxInflight: 1 });
  assert.equal(one.pass, false);
  assert.ok(one.verdict.failures.some((f) => f.reason === 'too-slow'), 'the retried review waits out two publish cycles');
  const two = await rh.runRehearsal({ fixture: buildSyntheticFixture() });
  assert.equal(two.pass, true);
});

test('the bar counts from when the page showed the review, not from when the lane noticed it', async () => {
  const fixture = buildSyntheticFixture();
  // Pretend a review's page showed it 10 minutes before the lane's first pass: page-to-live is then over the bar.
  fixture.reviews[1].appearsAfterMs = -(10 * 60 * 1000);
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, false);
  assert.equal(res.checks.pageToLiveSlow.length >= 1, true);
  assert.equal(res.verdict.pass, true, 'discovery-to-live alone would have passed it');
});

test('laneCodeHash follows the require graph: a dependency outside the lane folder changes it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787g-'));
  try {
    const lane = path.join(root, 'scripts', 'lib', 'lane');
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, 'a.js'), "const d = require('../dep');\nconst e = require('./inner'); module.exports = d;\n");
    fs.writeFileSync(path.join(lane, 'inner.js'), "module.exports = require('../deeper/x.js');\n");
    fs.mkdirSync(path.join(root, 'scripts', 'lib', 'deeper'));
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'dep.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'deeper', 'x.js'), 'module.exports = 2;');
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'unrelated.js'), 'module.exports = 3;');
    const files = rh.laneCodeFiles(lane).map((f) => path.relative(root, f));
    assert.deepEqual(files, ['scripts/lib/dep.js', 'scripts/lib/deeper/x.js', 'scripts/lib/lane/a.js', 'scripts/lib/lane/inner.js'].sort());
    const h = rh.laneCodeHash(lane);
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'dep.js'), 'module.exports = 99;');
    assert.notEqual(rh.laneCodeHash(lane), h, 'a changed dependency disarms');
    const h2 = rh.laneCodeHash(lane);
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'unrelated.js'), 'module.exports = 4;');
    assert.equal(rh.laneCodeHash(lane), h2, 'a file the lane never requires does not');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('laneCodeHash on the real lane covers merge-reviews-json and review-normalization', () => {
  const rel = rh.laneCodeFiles().map((f) => path.relative(path.join(import.meta.dirname, '..', '..'), f));
  for (const must of ['scripts/lib/merge-reviews-json.js', 'scripts/lib/review-normalization.js', 'scripts/lib/rss-discovery.js', 'scripts/lib/opening-night-lane/publish.js']) assert.ok(rel.includes(must), must);
});

function runnerSandbox(extra = {}) {
  const fixture = buildSyntheticFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787q-'));
  let t = Date.parse('2026-10-18T22:00:00-04:00');
  const reviewsFile = path.join(dir, 'reviews.json');
  fs.writeFileSync(reviewsFile, JSON.stringify({ reviews: [] }));
  const byKey = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), r]));
  const base = {
    show: fixture.show, night: fixture.night, openingDate: fixture.openingDate, adapters: [discovery.bwwRoundupAdapter()],
    fetchText: async (u) => { if (!(u in fixture.pages)) throw new Error('404'); return fixture.pages[u]; },
    ledgerDir: path.join(dir, 'ledger'), dryRun: true, now: () => t, wait: async (ms) => { t += ms; }, windowMs: 20 * 60 * 1000,
    fetchReview: async (c) => { const e = byKey.get(c.key); return { outletId: e.outletId, outlet: e.outletId, criticName: e.criticName, fullText: e.text, aggregator: e.aggregator, score: e.score }; },
    scoreReview: (row, f) => f.score,
    publishPorts: { ...publishMod.createReviewsFilePort(reviewsFile), regenShow: async () => {}, deploy: async () => {}, fetchLiveShow: async () => ({ rv: JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews.map((r) => ({ u: r.url })) }) },
    ...extra,
  };
  return { base, dir, fixture, reviewsFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

test('lane-runner: a publish that throws puts its rows back for the next batch; nothing scored is lost', async () => {
  const s = runnerSandbox();
  try {
    let n = 0;
    const flaky = { ...s.base.publishPorts, pushData: async () => (++n === 1 ? { ok: false, stderr: 'rejected' } : { ok: true }), isLeased: async () => true };
    const res = await runLaneNight({ ...s.base, publishPorts: flaky, dryRun: false });
    assert.ok(res.errors.some((e) => e.adapter === 'publish' && /pushing core data failed/.test(e.error)));
    assert.deepEqual(res.unpublished, []);
    const doc = JSON.parse(fs.readFileSync(s.reviewsFile, 'utf8'));
    assert.equal(doc.reviews.filter((r) => r.showId === s.fixture.show.id).length, 19, 'every roundup review landed after the retry');
  } finally { s.cleanup(); }
});

test('lane-runner: a restarted lane skips what already reached scored (ledger) or is on disk, and redoes what only reached discovered', async () => {
  const s = runnerSandbox();
  try {
    const first = await runLaneNight(s.base);
    assert.equal(first.admitted.length, 19);
    const again = await runLaneNight({ ...s.base, now: () => Date.parse('2026-10-18T23:00:00-04:00') + 1, windowMs: 6 * 60 * 1000 });
    assert.equal(again.admitted.length, 0, 'a restart does not redo scored reviews');
    const keys = [...loadDone(s.base.ledgerDir, s.fixture.show.id, s.fixture.night, ['https://www.example.com/on-disk?utm_source=x'])];
    assert.ok(keys.includes('https://example.com/on-disk'), 'on-disk URLs are canonicalised into the done set');
    assert.ok(keys.length >= 20);
  } finally { s.cleanup(); }
});
