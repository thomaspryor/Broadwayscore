'use strict';
/**
 * Opening-night lane rehearsal (BRO-4787, epic BRO-4210 phase 4: the epic's acceptance test).
 *
 * Replays a fixture (recorded or synthetic) through the lane's real path: discovery over the fixture pages, lane
 * review rows from the trust model, the publish path in dry-run against a local static server, and the ledger. The
 * verdict is ledger.rehearsalVerdict, plus the checks only the rehearsal can make: nothing unexpected was published,
 * no decoy leaked, and rows of other shows survived the merge.
 *
 * What is real here: discovery, canonical keys, trust-model rows, merge-by-key, the static-server deploy and the
 * cache-busted live poll. What is stood in: the page fetches (the fixture), the inline scorer (`scoreReview`, default
 * the fixture's own score: the real one is BRO-4784) and the public JSON regeneration (a projection of reviews.json;
 * CI can pass `regenShow: regenShowViaScript()` to run the real generator).
 *
 * The arm gate: the lane arms for a real opening only if the last rehearsal passed and is recent. Otherwise it does
 * not arm and the old pipeline runs unchanged (design doc section 6).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('./ledger');
const discovery = require('./discovery');
const trust = require('./trust-model');
const publish = require('./publish');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARM_MAX_AGE_MS = 8 * DAY_MS; // weekly CI plus a day of slack
const MAX_PASSES = 4;

function buildAdapters(fixture) {
  const { feeds = [], outlets = [] } = fixture.adapters || {};
  return [discovery.bwwRoundupAdapter(), discovery.dtliAdapter(), discovery.rssAdapter({ feeds }), discovery.sectionIndexAdapter({ outlets })];
}

/**
 * @param {object} args
 *   fixture {show:{id,title}, night, openingDate?, pages, reviews[], expectedKeys[], adapters, decoys[]}
 *   workDir? (a temp dir by default; removed unless keep), keep?, scoreReview?(row, entry), regenShow?(showId),
 *   startAt? ISO (virtual clock start; default 22:00 ET on the night), stepMs (virtual ms per clock read), maxMs
 * @returns {Promise<{pass, verdict, checks, summary, workDir?}>}
 */
async function runRehearsal({ fixture, workDir, keep = false, scoreReview, regenShow, startAt, stepMs = 1000, maxMs = ledger.DEFAULT_MAX_MS } = {}) {
  if (!fixture || !fixture.show || !fixture.pages || !Array.isArray(fixture.reviews) || !Array.isArray(fixture.expectedKeys)) throw new Error('rehearsal: fixture needs show, pages, reviews and expectedKeys');
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

  let t = Date.parse(startAt || `${night}T22:00:00-04:00`);
  const now = () => (t += stepMs);
  const iso = () => new Date(now()).toISOString();
  const startedAt = iso();
  const server = await publish.startStaticServer(liveDir);
  try {
    // 1. Discovery passes until a pass finds nothing new (what the 2-minute loop does, without the waiting).
    const seen = new Set();
    const memo = { rejected: {} };
    const adapters = buildAdapters(fixture);
    const fetchText = async (url) => { if (!(url in fixture.pages)) throw new Error(`404 ${url}`); return fixture.pages[url]; };
    const byKey = new Map(fixture.reviews.map((r) => [discovery.canonicalUrl(r.url), r]));
    const admitted = [];
    const errors = [];
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const r = await discovery.runDiscoveryPass({ show, night, now: now(), startedAt, adapters, fetchText, seen, memo, timeZone: fixture.timeZone });
      errors.push(...r.errors);
      discovery.recordDiscovered(ledgerDir, { show: show.id, night, admitted: r.admitted, now: now() });
      for (const a of r.admitted) { seen.add(a.key); admitted.push(a); }
      if (!r.admitted.length) break;
    }

    // 2. fetched + scored, then the lane rows.
    const unexpected = [];
    const rows = [];
    for (const a of admitted) {
      const entry = byKey.get(a.key);
      if (!entry) { unexpected.push(a.key); continue; }
      ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'fetched', at: now() });
      const row = trust.buildLaneReview({
        showId: show.id, night, source: a.source, seenAt: iso(), outletId: entry.outletId, outlet: entry.outletId,
        criticName: entry.criticName, url: a.url, publishDate: a.publishDate || entry.publishDate, fullText: entry.text, aggregator: entry.aggregator || {},
      });
      if (row.assignedScore == null) row.assignedScore = scoreReview ? scoreReview(row, entry) : entry.score;
      row.contentTier = row.isFullReview ? 'complete' : 'stub';
      ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'scored', at: now() });
      rows.push({ key: a.key, row });
    }

    // 3. Publish, dry-run, against the local static server.
    const projectShow = async (id) => {
      const doc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
      fs.writeFileSync(path.join(publicDir, 'data', 'shows', `${id}.json`), JSON.stringify({ id, rv: doc.reviews.filter((r) => r.showId === id).map((r) => ({ o: r.outlet, cn: r.criticName, s: r.assignedScore, u: r.url })) }));
    };
    const ports = {
      ...publish.createReviewsFilePort(reviewsFile),
      regenShow: regenShow || projectShow,
      deploy: publish.dryRunDeploy({ publicDir, liveDir, showId: show.id }),
      fetchLiveShow: publish.fetchLiveShowFrom(server.baseUrl),
    };
    const published = rows.length
      ? await publish.publishLaneReviews({ show: show.id, night, rows, ledgerDir, ports, now, pollMs: 5, timeoutMs: 60 * 1000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), openingDate: fixture.openingDate, dryRun: true })
      : { merge: null, verified: [], missing: [], timedOut: false };

    // 4. Verdict and the rehearsal-only checks.
    const read = ledger.readLedger(ledgerDir, show.id, night);
    const verdict = ledger.rehearsalVerdict(read.events, { expectedKeys: fixture.expectedKeys, maxMs, corrupt: read.corrupt });
    const finalDoc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
    const ledgerKeys = new Set(read.events.map((e) => e.reviewKey));
    const decoyLeaks = (fixture.decoys || []).filter((u) => ledgerKeys.has(discovery.canonicalUrl(u) || u) || finalDoc.reviews.some((r) => r.url === u));
    const bystandersSurvived = bystanders.every((b) => finalDoc.reviews.some((r) => r.showId === b.showId && r.url === b.url));
    const checks = { unexpected, decoyLeaks, bystandersSurvived, errors, timedOut: published.timedOut };
    const pass = verdict.pass && unexpected.length === 0 && decoyLeaks.length === 0 && bystandersSurvived && !published.timedOut;
    return { pass, verdict, checks, summary: ledger.summarize(read.events), published, workDir: keep ? dir : null };
  } finally {
    await server.close();
    if (!keep && !workDir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Persist the outcome the arm gate reads. Failures are trimmed: the record is small and safe to commit. */
function recordRehearsal(file, result, { at = Date.now(), kind = 'synthetic' } = {}) {
  const rec = { at: new Date(at).toISOString(), pass: result.pass === true, kind, checked: result.verdict && result.verdict.checked, failures: ((result.verdict && result.verdict.failures) || []).slice(0, 10), checks: result.checks ? { unexpected: result.checks.unexpected.length, decoyLeaks: result.checks.decoyLeaks.length, bystandersSurvived: result.checks.bystandersSurvived, timedOut: result.checks.timedOut } : null };
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
function armDecision(record, { now = Date.now(), maxAgeMs = DEFAULT_ARM_MAX_AGE_MS } = {}) {
  if (!record || typeof record !== 'object') return { arm: false, reason: 'no-rehearsal-record' };
  if (record.pass !== true) return { arm: false, reason: 'last-rehearsal-failed' };
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return { arm: false, reason: 'rehearsal-date-unreadable' };
  if (at > now + 5 * 60 * 1000) return { arm: false, reason: 'rehearsal-dated-in-the-future' };
  if (now - at > maxAgeMs) return { arm: false, reason: 'rehearsal-stale' };
  return { arm: true, reason: 'last-rehearsal-passed' };
}

module.exports = { DEFAULT_ARM_MAX_AGE_MS, runRehearsal, recordRehearsal, readRehearsalRecord, armDecision, buildAdapters };
