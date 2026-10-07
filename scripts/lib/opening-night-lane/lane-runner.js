'use strict';
/**
 * The opening-night lane's driver (BRO-4787 review: the glue between the lane's parts had no production home, so the
 * rehearsal was testing code only the rehearsal ran). One function, injected ports, used by BOTH the rehearsal and the
 * real lane:
 *
 *   discovery pass -> for each new candidate: fetch (ledger `fetched`) -> lane row -> score (ledger `scored`)
 *   -> publish the batch (ledger `rebuilt`, `deployed`, `verified-live`) -> wait -> next pass.
 *
 * Time is injected (`now`, `wait`): production passes real time and a real sleep, the rehearsal passes a virtual clock
 * whose `wait` advances it, so modelled latencies (fetch, score, deploy, CDN lag) count against the 20-minute bar.
 * A candidate whose fetch or score throws is not marked seen, so the next pass retries it.
 */
const ledger = require('./ledger');
const discovery = require('./discovery');
const trust = require('./trust-model');
const publish = require('./publish');

/**
 * @param {object} args
 *   show {id,title}, night, openingDate, timeZone?, adapters[], fetchText(url), ledgerDir,
 *   fetchReview(candidate) -> {outletId?, outlet, criticName, fullText, aggregator?, publishDate?}   (throws to retry)
 *   scoreReview(row, fetched) -> number   (called only for rows without a fallback score)
 *   publishPorts {updateReviews, regenShow, deploy, fetchLiveShow, pushData?, isLeased?}, dryRun?
 *   now() -> ms, wait(ms) -> Promise, latency {fetchMs, scoreMs}, passIntervalMs, maxPasses, windowMs (how long the lane runs),
 *   startedAt? (ms), publishTimeoutMs, pollMs
 * @returns {Promise<{passes, admitted, published, errors, unpublished}>}
 */
async function runLaneNight({
  show, night, openingDate, timeZone, adapters, fetchText, ledgerDir, fetchReview, scoreReview, publishPorts, dryRun = false,
  now, wait, latency = {}, passIntervalMs = 2 * 60 * 1000, maxPasses = 1000, windowMs = 6 * 60 * 60 * 1000, startedAt, publishTimeoutMs, pollMs,
} = {}) {
  for (const [k, v] of Object.entries({ show, night, adapters, fetchText, ledgerDir, fetchReview, scoreReview, publishPorts, now, wait })) {
    if (v === undefined || v === null) throw new Error(`lane-runner: ${k} is required`);
  }
  const t0 = startedAt === undefined ? now() : startedAt;
  const seen = new Set();
  const memo = { rejected: {} };
  const errors = [];
  const admitted = [];
  const published = [];
  let passes = 0;

  // The lane runs for its whole window, not until a pass finds nothing: reviews keep arriving for hours (late roundup
  // entries, slow outlets), and an idle-stop would walk away from them.
  for (; passes < maxPasses && now() - t0 < windowMs; passes++) {
    const pass = await discovery.runDiscoveryPass({ show, night, now: now(), startedAt: t0, adapters, fetchText, seen, memo, timeZone });
    errors.push(...pass.errors);
    const stamp = now();
    discovery.recordDiscovered(ledgerDir, { show: show.id, night, admitted: pass.admitted, now: stamp });

    const rows = [];
    for (const a of pass.admitted) {
      try {
        await wait(latency.fetchMs || 0);
        const fetched = await fetchReview(a);
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'fetched', at: now() });
        const row = trust.buildLaneReview({
          showId: show.id, night, source: a.source, seenAt: new Date(stamp).toISOString(), outletId: fetched.outletId || a.outletId,
          outlet: fetched.outlet, criticName: fetched.criticName, url: a.url, publishDate: a.publishDate || fetched.publishDate || null,
          fullText: fetched.fullText, aggregator: fetched.aggregator || {},
        });
        if (row.assignedScore == null) { await wait(latency.scoreMs || 0); row.assignedScore = scoreReview(row, fetched); }
        row.contentTier = row.isFullReview ? 'complete' : 'stub';
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'scored', at: now() });
        rows.push({ key: a.key, row });
        seen.add(a.key);
        admitted.push(a);
      } catch (e) {
        errors.push({ adapter: a.adapter, error: `${a.key}: ${String((e && e.message) || e).slice(0, 150)}` }); // retried next pass
      }
    }

    if (rows.length) {
      const res = await publish.publishLaneReviews({
        show: show.id, night, rows, ledgerDir, ports: publishPorts, now, sleep: wait, openingDate, dryRun,
        ...(pollMs ? { pollMs } : {}), ...(publishTimeoutMs ? { timeoutMs: publishTimeoutMs } : {}),
      });
      published.push(res);
    }
    await wait(passIntervalMs);
  }
  const unpublished = published.flatMap((p) => p.missing);
  return { passes, admitted, published, errors, unpublished };
}

module.exports = { runLaneNight };
