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

 * Publish may start after EACH scored row (BRO-7159), not only after the whole pass: a 20-review burst used to hold the
 * first deploy until every candidate had been fetched and scored one after another. A mid-pass publish uses at most
 * `maxInflight - 1` slots, so one is always left for the end-of-pass batch; a row scored while those are busy waits in
 * `pending` for the next call. Scoring stays one candidate at a time; there is no concurrent scoring pool.
 *
 * A paywall teaser held for an aggregator excerpt or rating (inline-score.js LaneAwaitingEvidenceError) is not an error
 * and is never marked seen: a later pass that brings the excerpt scores it. It is reported in `awaiting`.
 *
 * A candidate whose fetch or score throws is not marked seen, so the next pass retries it, unless the error says
 * `permanent` (inline-score.js after its bounded retries): then it is marked done and reported in `failed`, with the
 * reason already in the lane's failure record. Nothing is dropped without a trace. A publish that throws, or
 * a row that never went live, goes back on the queue for the next batch (merge-by-key makes the repeat harmless).
 */
const ledger = require('./ledger');
const discovery = require('./discovery');
const trust = require('./trust-model');
const publish = require('./publish');
const { createLaneReviewWriter } = require('./persist');
const { getSyndicationPrimaries, criticFileSlug } = require('../syndication-pairs');
const card = require('../review-completeness');

const criticKey = (name) => criticFileSlug(name); // the rebuild's critic match (diacritics, punctuation folded)

/** Review keys a restarted lane must not redo: those that already reached `scored`, plus URLs already on disk. */
// BRO-7196: passes a review missing outlet name, critic or date is retried before the lane leaves it to the regular pipeline.
const INCOMPLETE_TRIES = 3;

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
 *   missingOutlets? (T1/T2 outlet ids still missing, or a function of {seen} returning them, so captured outlets stop being searched; gates the SERP phase),
 *   reviewTextsDir? (persist scored rows before marking done, also in a dry-run sandbox),
 *   dryRun?, onDiskUrls?, onDiskRows? ([{criticName, outletId}] of this show already in reviews.json), now() -> ms, wait(ms) -> Promise, forkClock?(startMs) -> {now, wait}, midPassTickMs? (real mode's mid-pass timer; default min(bar, 30 s)),
 *   latency {fetchMs, scoreMs}, passIntervalMs, maxPasses, windowMs (how long the lane runs), startedAt?, publishTimeoutMs, pollMs,
 *   shouldStop?() (stop discovering and scoring), abandonPending?() (LANE_STANDDOWN: publish nothing new, only let in-flight batches finish;
 *   queued rows are already in review-texts, so the regular pipeline publishes them)
 * @returns {Promise<{passes, admitted, published, errors, failed, skipped, removedCopies, unpublished, awaiting, stopped}>}
 */
async function runLaneNight({
  show, night, openingDate, timeZone, adapters, fetchText, ledgerDir, fetchReview, scoreReview, publishPorts, makePublishPorts, dryRun = false,
  onDiskUrls = [], onDiskRows = [], maxInflight = 2, midPassPublishAfterMs = 5 * 60 * 1000, midPassTickMs = Math.min(midPassPublishAfterMs, 30 * 1000), now, wait, forkClock, latency = {}, passIntervalMs = 2 * 60 * 1000, maxPasses = 1000, windowMs = 6 * 60 * 60 * 1000,
  startedAt, publishTimeoutMs, pollMs, reviewTextsDir, shouldStop = () => false, abandonPending = () => false, missingOutlets = [],
} = {}) {
  for (const [k, v] of Object.entries({ show, night, adapters, fetchText, ledgerDir, fetchReview, scoreReview, now, wait })) {
    if (v === undefined || v === null) throw new Error(`lane-runner: ${k} is required`);
  }
  if (!publishPorts && !makePublishPorts) throw new Error('lane-runner: publishPorts or makePublishPorts is required');
  const persistReview = reviewTextsDir ? createLaneReviewWriter({ reviewTextsDir, show, night }) : null;
  const t0 = startedAt === undefined ? now() : startedAt;
  const seen = loadDone(ledgerDir, show.id, night, onDiskUrls);
  const memo = discovery.loadMemo(ledgerDir, show.id, night); // survives a restart: final rejections are not re-fetched
  const errors = [];
  const admitted = [];
  const published = [];
  const failed = [];
  const quoteless = [];
  const incomplete = new Map(); // BRO-7196: review key -> passes it was held for a missing card field
  const awaiting = new Set(); // paywall teasers held for an aggregator excerpt or rating (keys), until they score
  const removedCopies = []; // copies published in an earlier pass and taken down when their original scored
  const skipped = []; // deliberately not published (a syndicated copy whose primary is live), with the reason
  const pending = []; // rows scored but not yet published (or sent back by a failed batch)
  const inflight = new Set(); // real mode: batches publishing now
  const busyUntil = []; // virtual mode: end of each batch's timeline
  // `${critic}|${outletId}` of every row on the site or queued tonight, for the syndication check below. Seeded from
  // reviews.json: a primary the regular pipeline already published must still stop the lane publishing its copy.
  const taken = new Set(onDiskRows.filter((r) => r && r.criticName && r.outletId).map((r) => `${criticKey(r.criticName)}|${r.outletId}`));

  // BRO-7238 part 1: copies the lane already put on the site whose original has scored since (a Yahoo reprint published
  // in pass N, the TheWrap original in pass N+2). `livePublished` = what this lane published tonight, by critic|outlet;
  // `stagedRemovals` = copies to take down with the batch that carries their original, kept until that publish succeeds.
  const livePublished = new Map();
  const stagedRemovals = [];

  const publishBatch = async (batch, clock) => {
    // Only removals whose original rides in THIS batch: the copy never leaves the site before its original is in.
    const batchKeys = new Set(batch.map((r) => r.key));
    const remove = stagedRemovals.filter((x) => batchKeys.has(x.primaryKey));
    try {
      const res = await publish.publishLaneReviews({
        show: show.id, night, rows: batch, ...(remove.length ? { remove: remove.map(({ criticName, outletId }) => ({ criticName, outletId })) } : {}), ledgerDir, ports: makePublishPorts ? makePublishPorts(clock) : publishPorts, now: clock.now, sleep: clock.wait,
        openingDate, dryRun, ...(pollMs ? { pollMs } : {}), ...(publishTimeoutMs ? { timeoutMs: publishTimeoutMs } : {}),
      });
      published.push(res);
      for (const x of remove) { // the merge landed: the copies are off the site
        stagedRemovals.splice(stagedRemovals.indexOf(x), 1);
        livePublished.delete(`${criticKey(x.criticName)}|${x.outletId}`);
        removedCopies.push({ key: x.key, reason: `syndicated copy of the ${x.primaryOutlet} review by ${x.criticName}, taken down when the original was published` });
      }
      for (const key of res.dropped || []) failed.push({ key, reason: 'landed in reviews.json but not in the regenerated show JSON' });
      const missing = new Set(res.missing);
      // never went live: try again with the next batch. A re-queued row restarts its mid-pass wait, or the 30 s timer
      // below would retry a failing publish every 30 s instead of about once a pass (BRO-7159 review).
      for (const r of batch) if (!missing.has(r.key)) livePublished.set(`${criticKey(r.row.criticName)}|${r.row.outletId}`, r);
      pending.push(...batch.filter((r) => missing.has(r.key)).map((r) => ({ ...r, scoredAt: clock.now() })));
    } catch (e) {
      errors.push({ adapter: 'publish', error: String((e && e.message) || e).slice(0, 200) });
      pending.unshift(...batch.map((r) => ({ ...r, scoredAt: clock.now() }))); // scored: losing them to a failed push would drop reviews silently
    }
  };
  // A row that may be a syndicated copy (its critic has a primary outlet) is held until the end of the pass: its primary
  // can still be scored later in the same pass, and then the copy must be pulled from the queue, not already published
  // (the Oct 22 shadow run). Every other row may go out the moment it is scored.
  const mayBeCopy = (r) => getSyndicationPrimaries(r.row.criticName, r.row.outletId).length > 0;
  const takeBatch = (midPass) => {
    if (!midPass) return pending.splice(0);
    const batch = pending.filter((r) => !mayBeCopy(r));
    const held = pending.filter(mayBeCopy);
    pending.splice(0, pending.length, ...held);
    return batch;
  };
  // midPass (inside a pass): only once the oldest queued row has waited `midPassPublishAfterMs`, never with a possible
  // syndicated copy, and leaving one slot free for the end-of-pass batch. Two deploy slots are the whole capacity: a
  // mid-pass batch in an ordinary 4-minute burst pass spends the second slot, and a straggler found two minutes later
  // then waits a full deploy cycle (rehearsal: 18.6 -> 24.7 minutes with per-row publish, 22.7 with a 3-minute bar).
  // So an ordinary pass still publishes once at its end; only a pass that runs long (slow or hung scoring) publishes
  // what it already has after 5 minutes instead of holding it for the whole pass.
  const maybePublish = async ({ midPass = false } = {}) => {
    if (!pending.length || abandonPending()) return;
    if (midPass && !pending.some((r) => now() - r.scoredAt >= midPassPublishAfterMs)) return;
    const slots = midPass ? maxInflight - 1 : maxInflight;
    if (forkClock) {
      if (busyUntil.filter((e) => e > now()).length >= slots) return; // every slot is still busy on its own timeline
      const batch = takeBatch(midPass);
      if (!batch.length) return;
      const clock = forkClock(now());
      await publishBatch(batch, clock);
      busyUntil.push(clock.now());
    } else if (inflight.size < slots) {
      const batch = takeBatch(midPass);
      if (!batch.length) return;
      const p = publishBatch(batch, { now, wait }).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  };

  // Real mode: a hung score never reaches the per-row check below, so a timer makes the same mid-pass check. The
  // rehearsal's virtual clock only moves at awaits, so the per-row check covers it.
  // Only on the wall clock: an offline replay injects a virtual now() with no forkClock, and a real-time timer checking
  // a virtual clock would make its mid-pass publishes depend on how fast the machine runs.
  const wallClock = Math.abs(now() - Date.now()) < 60 * 1000;
  const midPassTimer = forkClock || !wallClock ? null : setInterval(() => { maybePublish({ midPass: true }).catch(() => {}); }, Math.max(1, midPassTickMs));
  if (midPassTimer && midPassTimer.unref) midPassTimer.unref();

  let passes = 0;
  // The lane runs for its whole window, not until a pass finds nothing: reviews keep arriving for hours (late roundup
  // entries, slow outlets), and an idle-stop would walk away from them.
  // shouldStop: the production driver's lease-lost signal. Stop discovering and scoring (they spend credits for rows
  // nobody may publish); the flush below still runs, and publish refuses on its own once the lease is gone.
  let stopped = false;
  try { // the finally clears the mid-pass timer even if a pass throws
  for (; passes < maxPasses && now() - t0 < windowMs; passes++) {
    if (shouldStop()) { stopped = true; break; }
    const pass = await discovery.runDiscoveryPass({ show, night, now: now(), startedAt: t0, adapters, fetchText, seen, memo, timeZone,
      missingOutlets: typeof missingOutlets === 'function' ? missingOutlets({ seen }) : missingOutlets });
    errors.push(...pass.errors);
    const stamp = now();
    discovery.recordDiscovered(ledgerDir, { show: show.id, night, admitted: pass.admitted, now: stamp });
    try { discovery.saveMemo(ledgerDir, show.id, night, memo); } catch (e) { errors.push({ adapter: 'memo', error: String((e && e.message) || e).slice(0, 150) }); }

    for (const a of pass.admitted) {
      try {
        if (!awaiting.has(a.key)) await wait(latency.fetchMs || 0); // a held teaser is re-offered without a fetch
        const fetched = await fetchReview(a);
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'fetched', at: now() });
        let row = trust.buildLaneReview({
          showId: show.id, night, source: a.source, seenAt: new Date(stamp).toISOString(), outletId: fetched.outletId || a.outletId,
          outlet: fetched.outlet, criticName: fetched.criticName || null, url: a.url, publishDate: a.publishDate || fetched.publishDate || null,
          fullText: fetched.fullText, aggregator: fetched.aggregator || {}, excerpts: fetched.excerpts,
        });
        // The printed rating the page carries (inline-score.js ratingFields), as the regular pipeline's review file has
        // it. Only on a row the ensemble will score: an aggregator fallback row (assignedScore already set, scoreSource
        // lane-aggregator-*) never reaches the scorer, so a page rating there would sit beside a score it did not anchor
        // and make isHighReliabilityStar read the aggregator label as the rating's source.
        if (fetched.rating && row.assignedScore == null) Object.assign(row, fetched.rating);
        // BRO-7196: a card needs outlet name, critic and date before any score is spent on it. The date may come from the
        // URL or the text (the rebuild's backfill); never from the opening date. A row with page text still missing one is
        // held: retried on the next passes (a byline can be late to the page), then left to the regular pipeline with a
        // reason. A row with no text at all (a hard paywall: NYT, WSJ, scored from the aggregators) has no evidence to find
        // a byline or date in; holding it would drop the night's biggest reviews, so only its outlet name is required and
        // the gaps are reported on the summary page.
        if (!row.publishDate) { const d = card.cardPublishDate(row); if (d) row.publishDate = d; }
        // The byline from the text when the page markup gave none (Talkin' Broadway's was null on Wanted).
        if (card.missingCardFields(row, { quote: false }).includes('criticName')) { const c = card.cardCriticName(row); if (c) row.criticName = c; }
        const gaps = card.missingCardFields(row, { quote: false }).filter((f) => f === 'outlet' || card.hasQuotableText(row));
        if (gaps.length) {
          const tries = (incomplete.get(a.key) || 0) + 1;
          incomplete.set(a.key, tries);
          throw Object.assign(new Error(`incomplete card (no ${gaps.join(', ')}), attempt ${tries}/${INCOMPLETE_TRIES}; held from publish`), { permanent: tries >= INCOMPLETE_TRIES });
        }
        // A syndicated copy (Chris Jones's Chicago Tribune review in the NY Daily News) is the rebuild's to drop only
        // when the primary is present (syndication-pairs.js). Mirror that: skip a copy whose primary is already
        // scored, and pull a queued copy when its primary arrives. The Oct 22 shadow run would have published one.
        const copyOf = getSyndicationPrimaries(row.criticName, row.outletId).find((o) => taken.has(`${criticKey(row.criticName)}|${o}`));
        if (copyOf) {
          seen.add(a.key);
          awaiting.delete(a.key);
          skipped.push({ key: a.key, reason: `syndicated copy of the ${copyOf} review by ${row.criticName}` });
          continue;
        }
        if (row.assignedScore == null) { await wait(latency.scoreMs || 0); const scored = await scoreReview(row, fetched);
          if (scored && typeof scored === 'object') { Object.assign(row, scored.extra || {}); row.assignedScore = scored.score; } else row.assignedScore = scored;
        }
        // A tier the scorer set wins (a page text it refused, rescored from the aggregator excerpt: 'excerpt').
        row.contentTier = row.contentTier || fetched.contentTier || (row.isFullReview ? 'complete' : 'stub');
        // A partial copy is scored now and collected in full later, like an excerpt-only one.
        if (row.contentTier === 'truncated') row.needsRecollection = true;
        // The old path's fields for a paywall partial copy, so the rebuild keeps it truncated until it is re-collected.
        if (fetched.sourceMethod) row.sourceMethod = fetched.sourceMethod;
        if (row.contentTier === 'truncated' && fetched.paywallTruncation) Object.assign(row, fetched.paywallTruncation);
        if (persistReview) {
          // The guarded writer can preserve a human correction. Publish precisely what survived on disk.
          row = persistReview(row).row;
        }
        // BRO-7196: publish the card row (outlet display name, display byline, the rebuild's pull quote), not the bare
        // file row; the quote stays off the file, where pullQuote means a human editor's pick. A row the rebuild would
        // also ship without a quote (no text, or no sentence its quote rules accept) publishes and is reported on the
        // summary page with what it lacks. Only an outlet with no display name is held after scoring (kept on disk).
        row = card.toCardRow(row, show);
        const cardGaps = card.missingCardFields(row);
        if (cardGaps.length && !cardGaps.includes('outlet')) quoteless.push({ key: a.key, missing: cardGaps });
        else if (cardGaps.length) {
          ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'scored', at: now() });
          throw Object.assign(new Error(`incomplete card after scoring (no ${cardGaps.join(', ')}); held from publish, left to the regular pipeline`), { permanent: true });
        }
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'scored', at: now() });
        for (let i = pending.length - 1; i >= 0; i--) {
          const q = pending.at(i).row;
          if (criticKey(q.criticName) !== criticKey(row.criticName) || !getSyndicationPrimaries(q.criticName, q.outletId).includes(row.outletId)) continue;
          skipped.push({ key: pending.at(i).key, reason: `syndicated copy of the ${row.outletId} review by ${row.criticName}` });
          pending.splice(i, 1);
        }
        for (const [k, live] of livePublished) {
          const q = live.row;
          if (criticKey(q.criticName) !== criticKey(row.criticName) || !getSyndicationPrimaries(q.criticName, q.outletId).includes(row.outletId)) continue;
          if (!stagedRemovals.some((x) => x.key === live.key)) stagedRemovals.push({ key: live.key, criticName: q.criticName, outletId: q.outletId, primaryKey: a.key, primaryOutlet: row.outletId });
        }
        pending.push({ key: a.key, row, scoredAt: now() });
        taken.add(`${criticKey(row.criticName)}|${row.outletId}`);
        seen.add(a.key);
        awaiting.delete(a.key);
        admitted.push(a);
        await maybePublish({ midPass: true }); // a long pass publishes what it has (see maybePublish)
      } catch (e) {
        if (e && e.awaiting) { awaiting.add(a.key); continue; } // held for evidence: not seen, not an error, re-offered next pass
        errors.push({ adapter: a.adapter, error: `${a.key}: ${String((e && e.message) || e).slice(0, 150)}` });
        if (e && e.permanent) { seen.add(a.key); awaiting.delete(a.key); failed.push({ key: a.key, reason: String(e.message).slice(0, 200) }); } // else: retried next pass
      }
    }
    await maybePublish();
    await wait(passIntervalMs);
  }
  } finally { if (midPassTimer) clearInterval(midPassTimer); }

  // Window over: flush what is queued and let the in-flight batch finish, so nothing scored is left unpublished.
  // A stand-down skips the queue and only waits for in-flight batches, so the lease is released quickly.
  if (forkClock) {
    let guard = 0;
    while (pending.length && !abandonPending() && guard++ < 20) {
      const clock = forkClock(now());
      await publishBatch(pending.splice(0), clock);
      busyUntil.push(clock.now());
    }
  } else {
    let guard = 0;
    // A publish that keeps failing (push rejected, deploy refused) is tried a few more times, not 40 back to back: each
    // try is a push and a deploy dispatch. What is left is reported unpublished and paged (BRO-7159 what-else).
    const publishErrors = () => errors.filter((e) => e.adapter === 'publish').length;
    const errorsBefore = publishErrors();
    const publishable = () => pending.length > 0 && !abandonPending() && publishErrors() - errorsBefore < 3;
    while ((inflight.size || publishable()) && guard++ < 40) {
      if (publishable() && inflight.size < maxInflight) await maybePublish();
      else await Promise.race(inflight);
    }
  }
  return { passes, admitted, published, errors, failed, skipped, removedCopies, quoteless, unpublished: pending.map((r) => r.key), awaiting: [...awaiting], stopped };
}

module.exports = { runLaneNight, loadDone };
