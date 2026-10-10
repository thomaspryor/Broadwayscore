'use strict';
/**
 * Opening-night lane rehearsal (BRO-4787, epic BRO-4210 phase 4: the epic's acceptance test).
 *
 * Replays a fixture (recorded or synthetic) through the lane's real path: discovery over the fixture pages, lane
 * review rows from the trust model, the publish path in dry-run against a local static server, and the ledger. The
 * verdict is ledger.rehearsalVerdict, plus the checks only the rehearsal can make: nothing unexpected was published,
 * no decoy leaked, and rows of other shows survived the merge.
 *
 * What is real here: the lane driver (lane-runner.js, shared with production), discovery, canonical keys, trust-model
 * rows, merge-by-key, the static-server deploy and the cache-busted live poll. What is stood in: the page fetches (the
 * fixture), the inline scorer (`scoreReview`, default the fixture's own score: the real one is BRO-4784), the public
 * JSON regeneration (a projection of reviews.json, which skips the generator's per-critic dedupe), and all LATENCY,
 * which is modelled (DEFAULT_LATENCY), so a time-to-live here is a budget check on assumptions, not a measurement.
 *
 * The arm gate: the lane arms for a real opening only if the last rehearsal passed and is recent. Otherwise it does
 * not arm and the old pipeline runs unchanged (design doc section 6).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ledger = require('./ledger');
const discovery = require('./discovery');
const publish = require('./publish');
const { runLaneNight } = require('./lane-runner');
const { resolveOutletFromUrl } = require('../review-normalization');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARM_MAX_AGE_MS = 8 * DAY_MS; // weekly CI plus a day of slack

// Modelled per-stage costs, in virtual milliseconds. They are ASSUMPTIONS about production, so they live in one place:
// CI can replace them with observed numbers. The real deploy lags 20-30 minutes in bursts (root CLAUDE.md section 2);
// pass `latency: { deployMs: 25 * 60000 }` to see the lane fail the 20-minute bar, as it would on such a night.
const DEFAULT_LATENCY = { passIntervalMs: 2 * 60 * 1000, fetchMs: 3000, scoreMs: 5000, regenMs: 30 * 1000, deployMs: 8 * 60 * 1000, cdnMs: 2 * 60 * 1000, pollMs: 15 * 1000 };

function summaryReviews(events) {
  return ledger.reviewStates(events).map((r) => ({ reviewKey: r.reviewKey, live: r.firstAt['verified-live'] || null }));
}

function buildAdapters(fixture) {
  const { feeds = [], outlets = [] } = fixture.adapters || {};
  return [discovery.bwwRoundupAdapter(), discovery.dtliAdapter(), discovery.rssAdapter({ feeds }), discovery.sectionIndexAdapter({ outlets })];
}

/**
 * The lane's code: every .js file in its folder plus everything they require, transitively, through relative paths
 * (merge-reviews-json, review-normalization, the feed parsers...). A change to ANY of them changes the hash, so the
 * record only arms the code that passed it. Walking the require graph keeps this honest as the lane grows new deps.
 */
function laneCodeFiles(dir = __dirname) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.resolve(path.dirname(file), m[1]);
      const hit = [base, `${base}.js`, path.join(base, 'index.js')].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      if (hit && hit.endsWith('.js')) walk(hit);
    }
  };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) walk(path.join(dir, f));
  return [...seen].sort();
}

function laneCodeHash(dir = __dirname) {
  const h = crypto.createHash('sha256');
  const root = path.resolve(dir, '..', '..', '..');
  for (const f of laneCodeFiles(dir)) { h.update(path.relative(root, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex').slice(0, 16);
}

/**
 * @param {object} args
 *   fixture {show:{id,title}, night, openingDate?, pages, waves?, flaky?, reviews[], expectedKeys[], adapters, decoys[]}
 *   workDir? (a temp dir by default; removed unless keep), keep?, scoreReview?(row, entry), regenShow?(showId),
 *   startAt? ISO (virtual clock start; default 22:00 ET on the night), latency? (overrides DEFAULT_LATENCY), maxMs
 * @returns {Promise<{pass, verdict, checks, summary, workDir?}>}
 */
async function runRehearsal({ fixture, workDir, keep = false, scoreReview, regenShow, startAt, latency = {}, maxInflight, maxMs = ledger.DEFAULT_MAX_MS } = {}) {
  if (!fixture || !fixture.show || !fixture.pages || !Array.isArray(fixture.reviews) || !Array.isArray(fixture.expectedKeys)) throw new Error('rehearsal: fixture needs show, pages, reviews and expectedKeys');
  const lat = { ...DEFAULT_LATENCY, ...latency };
  const { show, night } = fixture;
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lane-rehearsal-'));
  const ledgerDir = path.join(dir, 'ledger');
  const reviewsFile = path.join(dir, 'reviews.json');
  const publicDir = path.join(dir, 'public');
  const liveDir = path.join(dir, 'live');
  fs.mkdirSync(path.join(publicDir, 'data', 'shows'), { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });
  const OTHER = 'rehearsal-bystander-2026';
  const bystanders = [
    { showId: OTHER, outlet: 'Time Out', criticName: 'Bystander One', url: 'https://example.com/bystander-1', assignedScore: 70, contentTier: 'complete' },
    { showId: OTHER, outlet: 'Guardian', criticName: 'Bystander Two', url: 'https://example.com/bystander-2', assignedScore: 80, contentTier: 'complete' },
  ];
  fs.writeFileSync(reviewsFile, JSON.stringify({ _meta: { lastUpdated: 'rehearsal' }, reviews: bystanders }, null, 2));

  // Virtual clock: reading it never advances it. Only modelled work (wait) does.
  const startMs = Date.parse(startAt || `${night}T22:00:00-04:00`);
  let t = startMs;
  const now = () => t;
  const wait = async (ms) => { t += ms; };
  const server = await publish.startStaticServer(liveDir);
  try {
    // Pages as a function of virtual time (late additions) with transient failures.
    const failuresLeft = { ...(fixture.flaky || {}) };
    const fetchText = async (url) => {
      if (failuresLeft[url] > 0) { failuresLeft[url] -= 1; throw new Error(`503 ${url}`); }
      let page = fixture.pages[url];
      for (const w of fixture.waves || []) if (t - startMs >= w.afterMs && url in w.pages) page = w.pages[url];
      if (page === undefined) throw new Error(`404 ${url}`);
      return page;
    };
    const byKey = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), r]));
    const unexpected = new Set();
    const fetchReview = async (cand) => {
      const entry = byKey.get(cand.key);
      if (!entry) { unexpected.add(cand.key); throw new Error('not in fixture'); }
      const reg = resolveOutletFromUrl(cand.url);
      return { outletId: entry.outletId, outlet: (reg && reg.displayName) || entry.outletId, criticName: entry.criticName, fullText: entry.text, aggregator: entry.aggregator || {}, publishDate: entry.publishDate, score: entry.score };
    };

    const projectShow = async (id) => {
      const doc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
      fs.writeFileSync(path.join(publicDir, 'data', 'shows', `${id}.json`), JSON.stringify({ id, rv: doc.reviews.filter((r) => r.showId === id).map((r) => ({ o: r.outlet, cn: r.criticName, s: r.assignedScore, u: r.url })) }));
    };
    const copyLive = publish.dryRunDeploy({ publicDir, liveDir, showId: show.id });
    const liveFetch = publish.fetchLiveShowFrom(server.baseUrl);
    // Each publish batch runs on its own forked virtual timeline, so discovery keeps its cadence while a deploy lags.
    const forkClock = (startMs) => { let c = startMs; return { now: () => c, wait: async (ms) => { c += ms; } }; };
    const makePublishPorts = (clock) => {
      let visibleAt = Infinity;
      return {
        ...publish.createReviewsFilePort(reviewsFile),
        regenShow: async (id) => { await clock.wait(lat.regenMs); return (regenShow || projectShow)(id); },
        deploy: async () => { await clock.wait(lat.deployMs); await copyLive(); visibleAt = clock.now() + lat.cdnMs; }, // the deploy finishes, then the CDN catches up
        fetchLiveShow: async (id) => (clock.now() >= visibleAt ? liveFetch(id) : { rv: [] }),
      };
    };

    const run = await runLaneNight({
      show, night, openingDate: fixture.openingDate, timeZone: fixture.timeZone, adapters: buildAdapters(fixture), fetchText, ledgerDir,
      fetchReview, scoreReview: scoreReview || ((row, fetched) => fetched.score), makePublishPorts, forkClock, maxInflight, dryRun: true,
      now, wait, latency: lat, passIntervalMs: lat.passIntervalMs, windowMs: Math.max(45 * 60 * 1000, ...(fixture.waves || []).map((w) => w.afterMs + 15 * 60 * 1000)), startedAt: startMs, pollMs: lat.pollMs, publishTimeoutMs: maxMs,
    });

    const read = ledger.readLedger(ledgerDir, show.id, night);
    const verdict = ledger.rehearsalVerdict(read.events, { expectedKeys: fixture.expectedKeys, maxMs, corrupt: read.corrupt });
    const finalDoc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
    const ledgerKeys = new Set(read.events.map((e) => e.reviewKey));
    const decoyLeaks = (fixture.decoys || []).filter((u) => ledgerKeys.has(discovery.canonicalUrl(u) || u) || finalDoc.reviews.some((r) => r.url === u));
    const bystandersSurvived = bystanders.every((b) => finalDoc.reviews.some((r) => r.showId === b.showId && r.url === b.url));
    const timedOut = run.published.some((p) => p.timedOut);
    // The bar the owner cares about is page-to-live, not discovery-to-live: a review that sat on its page while the lane
    // was busy still counts. Each fixture review knows when its page showed it.
    const appears = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), (r.appearsAfterMs || 0)]));
    const pageToLiveSlow = summaryReviews(read.events).filter((r) => r.live && appears.has(r.reviewKey) && Date.parse(r.live) - (startMs + appears.get(r.reviewKey)) > maxMs).map((r) => ({ reviewKey: r.reviewKey, ms: Date.parse(r.live) - (startMs + appears.get(r.reviewKey)) }));
    const checks = { unexpected: [...unexpected], decoyLeaks, bystandersSurvived, errors: run.errors, timedOut, passes: run.passes, pageToLiveSlow, modelled: lat };
    const pass = verdict.pass && unexpected.size === 0 && decoyLeaks.length === 0 && bystandersSurvived && !timedOut && pageToLiveSlow.length === 0;
    return { pass, verdict, checks, summary: ledger.summarize(read.events), run, workDir: keep ? dir : null };
  } finally {
    await server.close();
    if (!keep && !workDir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Persist the outcome the arm gate reads. Failures are trimmed: the record is small and safe to commit. */
function recordRehearsal(file, result, { at = Date.now(), kind = 'synthetic', laneHash = null, error = null } = {}) {
  const rec = { at: new Date(at).toISOString(), pass: result.pass === true, kind, laneHash, ...(error ? { error: String(error).slice(0, 300) } : {}), checked: result.verdict && result.verdict.checked, failures: ((result.verdict && result.verdict.failures) || []).slice(0, 10), checks: result.checks ? { unexpected: result.checks.unexpected.length, decoyLeaks: result.checks.decoyLeaks.length, bystandersSurvived: result.checks.bystandersSurvived, timedOut: result.checks.timedOut } : null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return rec;
}

function readRehearsalRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Whether the lane may arm for a real opening. No record, a failed record, an unreadable date or a record older than
 * maxAgeMs all mean "do not arm": the old pipeline runs unchanged. Pure.
 * @returns {{arm: boolean, reason: string}}
 */
function armDecision(record, { now = Date.now(), maxAgeMs = DEFAULT_ARM_MAX_AGE_MS, laneHash } = {}) {
  if (!record || typeof record !== 'object') return { arm: false, reason: 'no-rehearsal-record' };
  if (record.pass !== true) return { arm: false, reason: 'last-rehearsal-failed' };
  if (!(Number.isFinite(record.checked) && record.checked > 0)) return { arm: false, reason: 'rehearsal-checked-nothing' };
  if (!(Number.isFinite(maxAgeMs) && maxAgeMs > 0)) return { arm: false, reason: 'bad-max-age' }; // fail closed: NaN would make every record fresh
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return { arm: false, reason: 'rehearsal-date-unreadable' };
  if (at > now + 5 * 60 * 1000) return { arm: false, reason: 'rehearsal-dated-in-the-future' };
  if (now - at > maxAgeMs) return { arm: false, reason: 'rehearsal-stale' };
  // The record only vouches for the code that passed it: a lane change since then means rehearse again.
  if (laneHash !== undefined && record.laneHash !== laneHash) return { arm: false, reason: 'lane-changed-since-rehearsal' };
  return { arm: true, reason: 'last-rehearsal-passed' };
}

module.exports = { DEFAULT_ARM_MAX_AGE_MS, DEFAULT_LATENCY, laneCodeFiles, laneCodeHash, runRehearsal, recordRehearsal, readRehearsalRecord, armDecision, buildAdapters };
