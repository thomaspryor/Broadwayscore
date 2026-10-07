'use strict';
/**
 * The opening-night lane's driver (BRO-4787 review: the glue between the lane's parts had no production home, so the
 * rehearsal was testing code only the rehearsal ran). One function, injected ports, used by BOTH the rehearsal and the
 * real lane:
 *
 *   discovery pass -> for each new candidate: fetch (ledger `fetched`) -> lane row -> score (ledger `scored`)
 *   -> queue for publish -> wait -> next pass
 *   publish (ledger `rebuilt`, `deployed`, `verified-live`) runs ALONGSIDE the passes: a deploy lags 20+ minutes on a
 *   burst night, and discovery must keep its 2-minute cadence meanwhile. Up to `maxInflight` batches overlap (default 2):
 *   the rehearsal showed that strictly one-at-a-time makes a straggler wait out TWO publish cycles, which breaks the
 *   20-minute bar when one cycle is already ~10 minutes. Overlap is safe: merge-by-key, and the later deploy carries
 *   every earlier row anyway.
 *
 * Time is injected. Production passes real `now`/`wait`, no `forkClock`: a batch publishes in the background and the
 * loop never waits for it. The rehearsal passes a virtual clock plus `forkClock(startMs)`, which gives each publish its
 * own virtual timeline (the single shared clock cannot run two things at once), still one batch at a time.

 * A candidate whose fetch or score throws is not marked seen, so the next pass retries it, unless the error says
 * `permanent` (inline-score.js after its bounded retries): then it is marked done and reported in `failed`, with the
 * reason already in the lane's failure record. Nothing is dropped without a trace. A publish that throws, or
 * a row that never went live, goes back on the queue for the next batch (merge-by-key makes the repeat harmless).
 */
const ledger = require('./ledger');
const discovery = require('./discovery');
const trust = require('./trust-model');
const publish = require('./publish');

/** Review keys a restarted lane must not redo: those that already reached `scored`, plus URLs already on disk. */
function loadDone(ledgerDir, show, night, onDiskUrls = []) {
  const done = new Set();
  for (const u of onDiskUrls) { const k = discovery.canonicalUrl(u); if (k) done.add(k); }
  for (const r of ledger.reviewStates(ledger.readLedger(ledgerDir, show, night).events)) if ('scored' in r.firstAt) done.add(r.reviewKey);
  return done;
}

/**
 * @param {object} args
 *   show {id,title}, night, openingDate, timeZone?, adapters[], fetchText(url), ledgerDir,
 *   fetchReview(candidate) -> {outletId?, outlet, criticName, fullText, aggregator?, publishDate?}   (throws to retry)
 *   scoreReview(row, fetched) -> number | {score, extra}   (called only for rows without a fallback score; `extra` fields are merged into the row)
 *   publishPorts {updateReviews, regenShow, deploy, fetchLiveShow, pushData?, isLeased?} OR makePublishPorts(clock),
 *   dryRun?, onDiskUrls?, now() -> ms, wait(ms) -> Promise, forkClock?(startMs) -> {now, wait},
 *   latency {fetchMs, scoreMs}, passIntervalMs, maxPasses, windowMs (how long the lane runs), startedAt?, publishTimeoutMs, pollMs
 * @returns {Promise<{passes, admitted, published, errors, failed, unpublished}>}
 */
async function runLaneNight({
  show, night, openingDate, timeZone, adapters, fetchText, ledgerDir, fetchReview, scoreReview, publishPorts, makePublishPorts, dryRun = false,
  onDiskUrls = [], maxInflight = 2, now, wait, forkClock, latency = {}, passIntervalMs = 2 * 60 * 1000, maxPasses = 1000, windowMs = 6 * 60 * 60 * 1000,
  startedAt, publishTimeoutMs, pollMs,
} = {}) {
  for (const [k, v] of Object.entries({ show, night, adapters, fetchText, ledgerDir, fetchReview, scoreReview, now, wait })) {
    if (v === undefined || v === null) throw new Error(`lane-runner: ${k} is required`);
  }
  if (!publishPorts && !makePublishPorts) throw new Error('lane-runner: publishPorts or makePublishPorts is required');
  const t0 = startedAt === undefined ? now() : startedAt;
  const seen = loadDone(ledgerDir, show.id, night, onDiskUrls);
  const memo = { rejected: {} };
  const errors = [];
  const admitted = [];
  const published = [];
  const failed = [];
  const pending = []; // rows scored but not yet published (or sent back by a failed batch)
  const inflight = new Set(); // real mode: batches publishing now
  const busyUntil = []; // virtual mode: end of each batch's timeline

  const publishBatch = async (batch, clock) => {
    try {
      const res = await publish.publishLaneReviews({
        show: show.id, night, rows: batch, ledgerDir, ports: makePublishPorts ? makePublishPorts(clock) : publishPorts, now: clock.now, sleep: clock.wait,
        openingDate, dryRun, ...(pollMs ? { pollMs } : {}), ...(publishTimeoutMs ? { timeoutMs: publishTimeoutMs } : {}),
      });
      published.push(res);
      const missing = new Set(res.missing);
      pending.push(...batch.filter((r) => missing.has(r.key))); // never went live: try again with the next batch
    } catch (e) {
      errors.push({ adapter: 'publish', error: String((e && e.message) || e).slice(0, 200) });
      pending.unshift(...batch); // the rows are scored; losing them to a failed push would drop reviews silently
    }
  };
  const maybePublish = async () => {
    if (!pending.length) return;
    if (forkClock) {
      if (busyUntil.filter((e) => e > now()).length >= maxInflight) return; // every slot is still busy on its own timeline
      const clock = forkClock(now());
      await publishBatch(pending.splice(0), clock);
      busyUntil.push(clock.now());
    } else if (inflight.size < maxInflight) {
      const p = publishBatch(pending.splice(0), { now, wait }).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  };

  let passes = 0;
  // The lane runs for its whole window, not until a pass finds nothing: reviews keep arriving for hours (late roundup
  // entries, slow outlets), and an idle-stop would walk away from them.
  for (; passes < maxPasses && now() - t0 < windowMs; passes++) {
    const pass = await discovery.runDiscoveryPass({ show, night, now: now(), startedAt: t0, adapters, fetchText, seen, memo, timeZone });
    errors.push(...pass.errors);
    const stamp = now();
    discovery.recordDiscovered(ledgerDir, { show: show.id, night, admitted: pass.admitted, now: stamp });

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
        if (row.assignedScore == null) { await wait(latency.scoreMs || 0); const scored = await scoreReview(row, fetched);
          if (scored && typeof scored === 'object') { Object.assign(row, scored.extra || {}); row.assignedScore = scored.score; } else row.assignedScore = scored;
        }
        row.contentTier = row.isFullReview ? 'complete' : 'stub';
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'scored', at: now() });
        pending.push({ key: a.key, row });
        seen.add(a.key);
        admitted.push(a);
      } catch (e) {
        errors.push({ adapter: a.adapter, error: `${a.key}: ${String((e && e.message) || e).slice(0, 150)}` });
        if (e && e.permanent) { seen.add(a.key); failed.push({ key: a.key, reason: String(e.message).slice(0, 200) }); } // else: retried next pass
      }
    }
    await maybePublish();
    await wait(passIntervalMs);
  }

  // Window over: flush what is queued and let the in-flight batch finish, so nothing scored is left unpublished.
  if (forkClock) {
    let guard = 0;
    while (pending.length && guard++ < 20) {
      const clock = forkClock(now());
      await publishBatch(pending.splice(0), clock);
      busyUntil.push(clock.now());
    }
  } else {
    let guard = 0;
    while ((inflight.size || pending.length) && guard++ < 40) {
      if (pending.length && inflight.size < maxInflight) await maybePublish();
      else await Promise.race(inflight);
    }
  }
  return { passes, admitted, published, errors, failed, unpublished: pending.map((r) => r.key) };
}

module.exports = { runLaneNight, loadDone };
