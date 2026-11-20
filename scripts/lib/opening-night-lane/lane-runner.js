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
const nearMiss = require('./near-miss');
const trust = require('./trust-model');
const publish = require('./publish');
const { createLaneReviewWriter } = require('./persist');
const { getSyndicationPrimaries, criticFileSlug } = require('../syndication-pairs');
const card = require('../review-completeness');
const { resolveOutletFromUrl } = require('../review-normalization');

const criticKey = (name) => criticFileSlug(name); // the rebuild's critic match (diacritics, punctuation folded)

/** Review keys a restarted lane must not redo: those that already reached `scored`, plus URLs already on disk. */
// BRO-7196: passes a review missing outlet name, critic or date is retried before the lane leaves it to the regular pipeline.
const INCOMPLETE_TRIES = 3;
const MANUAL_TRIES = 3; // BRO-7741: passes an inbox URL is retried before it is marked failed (and drained to ingest-urls)

/**
 * BRO-7741: what an inbox entry adds to the row the lane built from the page. The page's date must be tonight's (+/- 1
 * day) unless the person forced it; an undated page gets the day the URL was added, provisional (dateSource
 * 'manual-inbox'), so it is not held for a date it will never show. A critic the person named fills a missing byline.
 * Throws {manualRejected} for a date outside the window: a person's link is not a reason to publish last season's review.
 */
function applyManualEntry(row, { entry, night, timeZone }) {
  const out = { ...row, laneManualInbox: { addedAt: entry.addedAt, addedBy: entry.addedBy || 'unknown' } };
  if (!out.criticName && entry.critic) out.criticName = entry.critic;
  const verdict = trust.admitLaneCandidate({ source: trust.MANUAL_SOURCE, publishDate: out.publishDate, night, force: entry.force === true, ...(timeZone ? { timeZone } : {}) });
  if (!verdict.admit) throw Object.assign(new Error(`manual inbox URL dated outside opening night: ${verdict.reason}; add it again with force if it is tonight's review`), { manualRejected: true, permanent: true });
  if (!out.publishDate) {
    const day = trust.calendarDateIn(entry.addedAt, timeZone || undefined);
    if (day) { out.publishDate = day; out.dateSource = 'manual-inbox'; }
  }
  return out;
}

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
 *   latency {fetchMs, scoreMs}, passIntervalMs, maxPasses, windowMs (how long the lane runs), startedAt?, serpClockStartMs? (BRO-7280: SERP's +3h clock starts here instead of at startedAt), publishTimeoutMs, pollMs,
 *   onPressSignals?({nearMisses, gaps}) (BRO-7748: new near-misses and found-not-live gaps after a pass; its failure never stops the night),
 *   shouldStop?() (stop discovering and scoring), abandonPending?() (LANE_STANDDOWN: publish nothing new, only let in-flight batches finish;
 *   queued rows are already in review-texts, so the regular pipeline publishes them)
 * @returns {Promise<{passes, admitted, published, errors, failed, skipped, removedCopies, unpublished, awaiting, stopped}>}
 */
async function runLaneNight({
  show, night, openingDate, timeZone, adapters, fetchText, ledgerDir, fetchReview, scoreReview, publishPorts, makePublishPorts, dryRun = false,
  onDiskUrls = [], onDiskRows = [], maxInflight = 2, midPassPublishAfterMs = 5 * 60 * 1000, midPassTickMs = Math.min(midPassPublishAfterMs, 30 * 1000), now, wait, forkClock, latency = {}, passIntervalMs = 2 * 60 * 1000, maxPasses = 1000, windowMs = 6 * 60 * 60 * 1000,
  startedAt, serpClockStartMs, onAdmitted, publishTimeoutMs, pollMs, reviewTextsDir, shouldStop = () => false, abandonPending = () => false, missingOutlets = [], settleComparative = null, settleMaxRuns = 25,
  onPressSignals = null,
  readInbox = null, markInbox = null,
} = {}) {
  for (const [k, v] of Object.entries({ show, night, adapters, fetchText, ledgerDir, fetchReview, scoreReview, now, wait })) {
    if (v === undefined || v === null) throw new Error(`lane-runner: ${k} is required`);
  }
  if (!publishPorts && !makePublishPorts) throw new Error('lane-runner: publishPorts or makePublishPorts is required');
  const persistReview = reviewTextsDir ? createLaneReviewWriter({ reviewTextsDir, show, night }) : null;
  // BRO-7283: file name <-> review key of every row this run persisted, so a settle that moves a sibling's score can
  // find the queued or published row to send again. `settledNotes` is the report of what the settle did (summary page).
  const fileToKey = new Map();
  const settled = { runs: 0, rescored: [], failed: [], foreign: [] };
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
  // BRO-7891: what a reader can see now, as opposed to `taken`/`seen`, which also hold rows only queued tonight (or
  // scored by an earlier run that never went live). An inbox entry is 'already-in' only against these.
  const liveKeys = new Set(onDiskUrls.map((u) => discovery.canonicalUrl(u)).filter(Boolean)); // review keys on the site
  const liveTaken = new Set(taken); // critic|outlet on the site
  const admittedKeys = new Set(); // review keys scored this run (queued, in flight, live or pulled as a copy)
  const copySkipped = new Map(); // review key -> {takenKey, primary}: a syndicated copy skipped this run
  const aggregatorCited = new Map(); // BRO-7891 item 3: review key -> first sighting of an aggregator citing it
  const parityAlerted = new Set(); // review keys already in an aggregator-parity alert
  const inflightKeys = new Set(); // review keys in a batch publishing now
  const keptKeys = new Set(); // review keys whose publish the merge kept out (the site's row for that review won)
  const KEPT_REASON = 'reviews.json already has a review by this critic for this outlet (or this URL); the merge kept that row';
  const keyTaken = new Map(); // review key -> critic|outlet of the row the lane built for it this run

  // BRO-7238 part 1: copies the lane already put on the site whose original has scored since (a Yahoo reprint published
  // in pass N, the TheWrap original in pass N+2). `livePublished` = what this lane published tonight, by critic|outlet;
  // `stagedRemovals` = copies to take down with the batch that carries their original, kept until that publish succeeds.
  const livePublished = new Map();
  const stagedRemovals = [];

  // BRO-7741: the manual-URL inbox. readInbox() -> the show's inbox entries (manual-inbox.js), read once a pass;
  // markInbox(updates) writes each entry's outcome back. Both null (replays, rehearsals): no inbox.
  const manualByKey = new Map(); // review key -> inbox entry being worked tonight
  // Keyed by entry generation (id + addedAt): a URL re-added (say with --force after a date rejection) is a new
  // generation the lane works afresh, and a late status for the old one never lands on it.
  const gen = (e) => `${e.id}@${e.addedAt || ''}`;
  const manualTries = new Map(); // entry generation -> passes it was retried
  const manualClosed = new Set(); // entry generations with a final outcome this run
  const manualQueued = new Set(); // entry generations scored and waiting for publish
  const inboxUpdates = [];
  const failedKeys = () => new Set(failed.map((f) => f.key));
  const noteInbox = (entry, status, reason) => {
    if (!entry || manualClosed.has(gen(entry))) return;
    if (status === 'queued') { if (manualQueued.has(gen(entry))) return; manualQueued.add(gen(entry)); } else manualClosed.add(gen(entry));
    // url/show ride along for the driver's failed/rejected alert (markStatus ignores them).
    inboxUpdates.push({ id: entry.id, ...(entry.addedAt ? { addedAt: entry.addedAt } : {}), status, ...(reason ? { reason: String(reason).slice(0, 300) } : {}), url: entry.url, show: show.id });
  };
  // BRO-7891: an inbox entry for a syndicated copy whose original is only queued tonight stays 'queued' until the
  // original is verified live ('held-copy', final: drain and sweep skip it). Never live by the end: it stays open and
  // the drain hands it to ingest-urls, where the rebuild's own syndication rule decides.
  const heldCopies = []; // {entry, takenKey, primary}
  const holdCopy = (entry, takenKey, primary, criticName) => {
    if (liveTaken.has(takenKey)) { noteInbox(entry, 'held-copy', `syndicated copy of the ${primary} review by ${criticName}, which is on the site`); return; }
    noteInbox(entry, 'queued');
    if (!heldCopies.some((h) => gen(h.entry) === gen(entry))) heldCopies.push({ entry, takenKey, primary, criticName });
  };
  const settleHeldCopies = () => {
    for (let i = heldCopies.length - 1; i >= 0; i--) {
      const h = heldCopies[i];
      if (!liveTaken.has(h.takenKey)) continue;
      heldCopies.splice(i, 1);
      noteInbox(h.entry, 'held-copy', `syndicated copy of the ${h.primary} review by ${h.criticName}, which is on the site`);
    }
  };
  const flushInbox = async () => {
    if (!markInbox || !inboxUpdates.length) return;
    const batch = inboxUpdates.splice(0);
    try { await markInbox(batch); } catch (e) {
      inboxUpdates.unshift(...batch); // tried again after the next pass
      errors.push({ adapter: 'manual-inbox', error: `status write failed: ${String((e && e.message) || e).slice(0, 150)}` });
    }
  };
  const outletIdFor = (e) => e.outletId || ((resolveOutletFromUrl(e.url) || {}).outletId) || null;
  const manualCandidates = async () => {
    if (!readInbox) return [];
    let entries;
    try { entries = await readInbox(); } catch (e) {
      errors.push({ adapter: 'manual-inbox', error: `read failed: ${String((e && e.message) || e).slice(0, 150)}` });
      return [];
    }
    const out = [];
    const failedNow = failedKeys();
    for (const e of entries || []) {
      if (!e || !e.id || manualClosed.has(gen(e)) || (e.status && e.status !== 'queued')) continue;
      const key = discovery.canonicalUrl(e.url);
      if (!key) { noteInbox(e, 'rejected', 'not an http(s) URL'); continue; }
      if (manualQueued.has(gen(e))) continue; // scored tonight (or a held copy), waiting for its publish
      // BRO-7891: 'already-in' only for a review a reader can see (reviews.json before tonight, or verified live).
      if (liveKeys.has(key)) { noteInbox(e, 'already-in', 'this review is on the site'); continue; }
      // Scored this run and still queued or publishing: ride along with it (publishBatch marks it published once live)
      // rather than re-offering it, which would fetch and score the same review twice.
      // A syndicated copy the lane skipped, pulled from the queue or took off the site this run: held against its
      // original, not re-fetched. Checked before the ride-along: a pulled copy is admitted but will never publish.
      if (copySkipped.has(key)) { const c = copySkipped.get(key); holdCopy(e, c.takenKey, c.primary, c.criticName); continue; }
      // The merge kept the site's own row for this review earlier tonight: nothing of ours will go live for it.
      if (keptKeys.has(key)) { noteInbox(e, 'already-in', KEPT_REASON); continue; }
      // Ride along only while a publish for it is still coming (queued or in flight); anything else is worked again.
      if (admittedKeys.has(key) && !failedNow.has(key) && (inflightKeys.has(key) || pending.some((q) => q.key === key))) { manualByKey.set(key, e); noteInbox(e, 'queued'); continue; }
      // Anything else is worked: a key that failed this run, or one an earlier run of tonight's lane scored but never
      // got live (a restart). That re-scores it (model credits, and a settle run against settleMaxRuns): the price of
      // not leaving a person's URL unpublished on the strength of a ledger line.
      manualByKey.set(key, e);
      out.push({ url: e.url, key, source: trust.MANUAL_SOURCE, adapter: 'manual-inbox', via: 'manual-inbox', publishDate: null,
        // The outlet comes from the URL when the person did not name one: inline-score's fetchReview never returns one
        // (every adapter candidate carries its own), so without this a bare inbox URL failed "outletId is required"
        // (BRO-7781 simulated night).
        ...(outletIdFor(e) ? { outletId: outletIdFor(e) } : {}), reason: 'manual-inbox', manualEntry: e });
    }
    return out;
  };

  const publishBatch = async (batch, clock) => {
    // Only removals whose original rides in THIS batch: the copy never leaves the site before its original is in.
    const batchKeys = new Set(batch.map((r) => r.key));
    // merged or about to be: a copy in flight or re-queued as missing is still on the site when its original scores
    for (const r of batch) livePublished.set(`${criticKey(r.row.criticName)}|${r.row.outletId}`, r);
    const remove = stagedRemovals.filter((x) => batchKeys.has(x.primaryKey));
    for (const k of batchKeys) inflightKeys.add(k);
    try {
      const res = await publish.publishLaneReviews({
        show: show.id, night, rows: batch, ...(remove.length ? { remove: remove.map(({ criticName, outletId, primaryOutlet }) => ({ criticName, outletId, primaryOutletId: primaryOutlet })) } : {}), ledgerDir, ports: makePublishPorts ? makePublishPorts(clock) : publishPorts, now: clock.now, sleep: clock.wait,
        openingDate, dryRun, ...(timeZone ? { timeZone } : {}), ...(pollMs ? { pollMs } : {}), ...(publishTimeoutMs ? { timeoutMs: publishTimeoutMs } : {}),
      });
      published.push(res);
      const notLive = new Set([...(res.missing || [])]);
      for (const x of remove) { // the merge landed: the copies are off the site (unless their original is still not live: retry with it)
        if (notLive.has(x.primaryKey)) continue;
        stagedRemovals.splice(stagedRemovals.indexOf(x), 1);
        livePublished.delete(`${criticKey(x.criticName)}|${x.outletId}`);
        // BRO-7891: the copy is off the site now; a later inbox add of it is held against its original, not 'already-in'.
        liveKeys.delete(x.key);
        liveTaken.delete(`${criticKey(x.criticName)}|${x.outletId}`);
        copySkipped.set(x.key, { takenKey: `${criticKey(x.criticName)}|${x.primaryOutlet}`, primary: x.primaryOutlet, criticName: x.criticName });
        removedCopies.push({ key: x.key, reason: `syndicated copy of the ${x.primaryOutlet} review by ${x.criticName}, taken down when the original was published` });
      }
      for (const key of res.dropped || []) failed.push({ key, reason: 'landed in reviews.json but not in the regenerated show JSON' });
      const missing = new Set(res.missing);
      // never went live: try again with the next batch. A re-queued row restarts its mid-pass wait, or the 30 s timer
      // below would retry a failing publish every 30 s instead of about once a pass (BRO-7159 review).
      for (const r of batch) if (!missing.has(r.key)) livePublished.set(`${criticKey(r.row.criticName)}|${r.row.outletId}`, r);
      // BRO-7891: only a verified-live row is on the site. A dropped row (landed in reviews.json, not in the show JSON)
      // is in neither `missing` nor `verified`: it is not published, and its inbox entry is left to fail and alert.
      const verified = new Set(res.verified || []);
      for (const r of batch) {
        if (!verified.has(r.key)) continue;
        liveKeys.add(r.key);
        liveTaken.add(`${criticKey(r.row.criticName)}|${r.row.outletId}`);
        if (manualByKey.has(r.key)) noteInbox(manualByKey.get(r.key), 'published', dryRun ? 'dry run' : null);
      }
      const droppedKeys = new Set(res.dropped || []);
      for (const r of batch) if (!verified.has(r.key) && !missing.has(r.key) && !droppedKeys.has(r.key)) keptKeys.add(r.key);
      for (const r of batch) {
        if (!manualByKey.has(r.key) || verified.has(r.key) || missing.has(r.key)) continue;
        // dropped: never goes live; else the merge kept the site's own row (same outlet+critic, or same URL)
        if (droppedKeys.has(r.key)) noteInbox(manualByKey.get(r.key), 'failed', 'landed in reviews.json but not in the regenerated show JSON');
        // The merge matches on outlet+critic first, then URL (publish.js mergeShowRows), so the kept row may be another URL.
        else noteInbox(manualByKey.get(r.key), 'already-in', KEPT_REASON);
      }
      settleHeldCopies();
      pending.push(...batch.filter((r) => missing.has(r.key) && !pending.some((q) => q.key === r.key)).map((r) => ({ ...r, scoredAt: clock.now() })));
    } catch (e) {
      errors.push({ adapter: 'publish', error: String((e && e.message) || e).slice(0, 200) });
      pending.unshift(...batch.map((r) => ({ ...r, scoredAt: clock.now() }))); // scored: losing them to a failed push would drop reviews silently
    } finally { for (const k of batchKeys) inflightKeys.delete(k); }
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
  const firstSightings = new Map();
  // BRO-7779 item 5: per-source read health for the whole night (failure streaks, sources rotation never reaches).
  const sourceHealth = require('./source-health').createSourceHealth({ now });
  // BRO-7748: firstSightings is url -> first time a pass saw it, for the 15-minute found-not-live check (in memory: a
  // re-dispatched night starts the clock again and re-sends its alerts once; a duplicate beats a silent miss).
  const alerting = new Set(); // press-signal alerts in flight, settled before the night returns, even when a pass throws
  // The lane runs for its whole window, not until a pass finds nothing: reviews keep arriving for hours (late roundup
  // entries, slow outlets), and an idle-stop would walk away from them.
  // shouldStop: the production driver's lease-lost signal. Stop discovering and scoring (they spend credits for rows
  // nobody may publish); the flush below still runs, and publish refuses on its own once the lease is gone.
  let stopped = false;
  try { // the finally clears the mid-pass timer even if a pass throws
  for (; passes < maxPasses && now() - t0 < windowMs; passes++) {
    if (shouldStop()) { stopped = true; break; }
    const pass = await discovery.runDiscoveryPass({ show, night, now: now(), startedAt: serpClockStartMs === undefined ? t0 : serpClockStartMs, adapters, fetchText, seen, memo, timeZone, sourceHealth,
      missingOutlets: typeof missingOutlets === 'function' ? missingOutlets({ seen }) : missingOutlets });
    errors.push(...pass.errors);
    const stamp = now();
    discovery.recordDiscovered(ledgerDir, { show: show.id, night, admitted: pass.admitted, now: stamp });
    // BRO-7740: the driver watches admitted reviews to learn the embargo has lifted. Never lets a hook error stop the lane.
    if (typeof onAdmitted === 'function' && pass.admitted.length) { try { onAdmitted(pass.admitted, stamp); } catch (e) { errors.push({ adapter: 'onAdmitted', error: String((e && e.message) || e).slice(0, 150) }); } }
    try { discovery.saveMemo(ledgerDir, show.id, night, memo); } catch (e) { errors.push({ adapter: 'memo', error: String((e && e.message) || e).slice(0, 150) }); }
    // BRO-7748: what the pass saw but did not admit, reported within this pass. Recorded first, so a failed alert is not
    // re-sent every pass; an alert that throws is an error row, never a stopped night.
    try {
      const nearMisses = nearMiss.recordNew(ledgerDir, { showId: show.id, night, kind: 'near-miss', items: pass.nearMisses || [], now: stamp, perAdapter: nearMiss.MAX_NEAR_MISSES_PER_ADAPTER });
      const gaps = nearMiss.recordNew(ledgerDir, { showId: show.id, night, kind: 'gap', items: nearMiss.gapCandidates(pass.sightings || [], { firstSeen: firstSightings, now: stamp }), now: stamp });
      const health = nearMiss.recordNew(ledgerDir, { showId: show.id, night, kind: 'source-health', items: sourceHealth.alerts(stamp), now: stamp });
      // BRO-7891 item 3: aggregators ahead of the site. Every review a roundup cites tonight (admitted or not), timed from
      // its first sighting; a copy held against a live original counts as live. Rides with the source-health alerts.
      for (const s of pass.sightings || []) {
        if (!s || !s.aggregatorCited || !s.knownOutlet || aggregatorCited.has(s.key)) continue;
        if (s.rejectedFor && nearMiss.INTENDED_REJECTIONS.has(s.rejectedFor) && !nearMiss.windowMismatch(s)) continue;
        aggregatorCited.set(s.key, { firstSeenMs: stamp, url: s.url, outletId: s.outletId, via: s.via || s.adapter });
      }
      // Live by URL, or by critic+outlet (the key publish merges on, so a cited URL the site carries under another URL
      // counts), or a copy whose original is live.
      const isLiveNow = (k) => liveKeys.has(k) || (keyTaken.has(k) && liveTaken.has(keyTaken.get(k)))
        || (copySkipped.has(k) && liveTaken.has(copySkipped.get(k).takenKey));
      const parity = nearMiss.aggregatorParity(aggregatorCited, isLiveNow, { now: stamp, alerted: parityAlerted });
      if (parity) {
        health.push(...nearMiss.recordNew(ledgerDir, { showId: show.id, night, kind: 'aggregator-parity', items: [parity], now: stamp }));
        for (const k of parity.newKeys) parityAlerted.add(k);
      }
      // Not awaited here: the admitted reviews below are the lane's job and must not wait on Discord or Linear.
      if ((nearMisses.length || gaps.length || health.length) && onPressSignals) {
        const p = Promise.resolve().then(() => onPressSignals({ show, night, nearMisses, gaps, sourceHealth: health }))
          .catch((e) => errors.push({ adapter: 'press-signals', error: String((e && e.message) || e).slice(0, 150) }))
          .finally(() => alerting.delete(p));
        alerting.add(p);
      }
    } catch (e) { errors.push({ adapter: 'press-signals', error: String((e && e.message) || e).slice(0, 150) }); }

    // BRO-7741: inbox URLs first, outside discovery (no memo, no title match, no merge): a person already vouched for them.
    const manual = await manualCandidates();
    const manualKeys = new Set(manual.map((m) => m.key));
    for (const a of [...manual, ...pass.admitted.filter((x) => !manualKeys.has(x.key))]) {
      const entry = a.source === trust.MANUAL_SOURCE ? a.manualEntry : null;
      try {
        if (!awaiting.has(a.key)) await wait(latency.fetchMs || 0); // a held teaser is re-offered without a fetch
        const fetched = await fetchReview(a);
        ledger.appendEvent(ledgerDir, { show: show.id, night, reviewKey: a.key, stage: 'fetched', at: now() });
        let row = trust.buildLaneReview({
          showId: show.id, night, source: a.source, seenAt: new Date(stamp).toISOString(), outletId: fetched.outletId || a.outletId,
          outlet: fetched.outlet, criticName: fetched.criticName || null, bylineConflict: fetched.bylineConflict || null, url: a.url, publishDate: a.publishDate || fetched.publishDate || null,
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
        if (entry) row = applyManualEntry(row, { entry, night, timeZone });
        // A review a roundup cites whose own page has no date (Cititour): the roundup's date, provisional (BRO-7587). Held
        // for three reads otherwise, then left to the regular pipeline hours later.
        // Not for a show with an earlier run (transfer, revival): its roundup also cites the earlier run's reviews, and a date from
        // the roundup would pass them as tonight's.
        const hasEarlierRun = (Array.isArray(show.priorRuns) && show.priorRuns.length > 0) || !!show.transferOf;
        if (!row.publishDate && a.source === 'aggregator' && !hasEarlierRun) {
          const fb = trust.roundupFallbackDate({ aggregatorDate: a.aggregatorDate, night });
          if (fb) Object.assign(row, fb);
        }
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
          const takenKey = `${criticKey(row.criticName)}|${copyOf}`;
          copySkipped.set(a.key, { takenKey, primary: copyOf, criticName: row.criticName });
          // BRO-7891: not 'already-in' (the sweep would re-send a copy URL that never reaches the site, and the original
          // may only be queued): held against its original until that is live.
          if (entry) { manualByKey.delete(a.key); holdCopy(entry, takenKey, copyOf, row.criticName); }
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
        // BRO-7884: the review file gets the market's calendar day too. The rebuild's normaliser takes the UTC day of a
        // timestamp, so a Nov 19 press-night review saved as 2026-11-20T03:00Z would flip to Nov 20 on the next rebuild.
        row = publish.toCalendarDay(row, timeZone);
        if (persistReview) {
          // The guarded writer can preserve a human correction. Publish precisely what survived on disk.
          const persisted = persistReview(row);
          row = persisted.row;
          const base = require('path').basename(persisted.file);
          fileToKey.set(base, a.key);
          // BRO-7283: the same within-band comparative pass the regular pipeline runs hours later (and moves scores
          // with). Run here, the published score is the settled one and that later pass finds the group settled.
          // A failure publishes the isolated scores, exactly as before this existed.
          if (settleComparative) {
            try {
              if (settled.runs >= settleMaxRuns) throw new Error(`settle skipped: ${settleMaxRuns} runs already made tonight`);
              // Each model call is bounded by its own 300s abort (comparative-core), so a hang ends in `unsettled`, not a late write.
              const res = await settleComparative({ file: base });
              if (res && res.rescoresDone > 0) settled.runs++; // only runs that called a model count against the cap
              for (const c of (res && res.changed) || []) {
                if (c.file === base) row = JSON.parse(require('fs').readFileSync(persisted.file, 'utf8'));
                else if (fileToKey.has(c.file)) settled.rescored.push({ key: fileToKey.get(c.file), file: c.file });
                else settled.foreign.push(c.file); // not published by this run: the regular rebuild carries its new score
                settled.moved = (settled.moved || 0) + 1;
              }
              for (const u of (res && res.unsettled) || []) settled.failed.push({ file: base, reason: String(u.reason).slice(0, 160) });
            } catch (e) { settled.failed.push({ file: base, reason: String((e && e.message) || e).slice(0, 160) }); }
          }
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
          const pulled = pending.at(i);
          skipped.push({ key: pulled.key, reason: `syndicated copy of the ${row.outletId} review by ${row.criticName}` });
          pending.splice(i, 1);
          const takenKey = `${criticKey(row.criticName)}|${row.outletId}`;
          copySkipped.set(pulled.key, { takenKey, primary: row.outletId, criticName: row.criticName });
          if (manualByKey.has(pulled.key)) { const e = manualByKey.get(pulled.key); manualByKey.delete(pulled.key); holdCopy(e, takenKey, row.outletId, row.criticName); }
        }
        for (const [k, live] of livePublished) {
          const q = live.row;
          if (criticKey(q.criticName) !== criticKey(row.criticName) || !getSyndicationPrimaries(q.criticName, q.outletId).includes(row.outletId)) continue;
          if (!stagedRemovals.some((x) => x.key === live.key)) stagedRemovals.push({ key: live.key, criticName: q.criticName, outletId: q.outletId, primaryKey: a.key, primaryOutlet: row.outletId });
        }
        pending.push({ key: a.key, row, scoredAt: now() });
        if (entry) noteInbox(entry, 'queued');
        // BRO-7283: siblings whose score the settle just moved ride in this batch: swapped in place when still queued,
        // queued again (marked `rescored`, so publish waits for the new score to be live) when already on the site.
        for (const sib of settled.rescored.splice(0)) {
          const file = [...fileToKey].find(([, k]) => k === sib.key)?.[0];
          if (!file || sib.key === a.key) continue;
          let sibRow;
          try { sibRow = card.toCardRow(JSON.parse(require('fs').readFileSync(require('path').join(reviewTextsDir, show.id, file), 'utf8')), show); } catch { continue; }
          const queued = pending.find((q) => q.key === sib.key);
          if (queued) queued.row = sibRow;
          else pending.push({ key: sib.key, row: sibRow, scoredAt: now(), rescored: true });
        }
        taken.add(`${criticKey(row.criticName)}|${row.outletId}`);
        keyTaken.set(a.key, `${criticKey(row.criticName)}|${row.outletId}`);
        seen.add(a.key);
        awaiting.delete(a.key);
        admitted.push(a);
        admittedKeys.add(a.key);
        await maybePublish({ midPass: true }); // a long pass publishes what it has (see maybePublish)
      } catch (e) {
        if (e && e.awaiting) { awaiting.add(a.key); continue; } // held for evidence: not seen, not an error, re-offered next pass
        errors.push({ adapter: a.adapter, error: `${a.key}: ${String((e && e.message) || e).slice(0, 150)}` });
        if (e && e.permanent) { seen.add(a.key); awaiting.delete(a.key); failed.push({ key: a.key, reason: String(e.message).slice(0, 200) }); } // else: retried next pass
        if (entry) {
          // A pass where inline-score only waited out its backoff made no attempt: it does not count as a try.
          const tries = (manualTries.get(gen(entry)) || 0) + (e && e.backoff ? 0 : 1);
          manualTries.set(gen(entry), tries);
          if (e && (e.permanent || e.manualRejected || tries >= MANUAL_TRIES)) {
            manualByKey.delete(a.key);
            noteInbox(entry, e && e.manualRejected ? 'rejected' : 'failed', String((e && e.message) || e).slice(0, 300));
          }
        }
      }
    }
    await flushInbox();
    await maybePublish();
    await wait(passIntervalMs);
  }
  } finally { if (midPassTimer) clearInterval(midPassTimer); await Promise.allSettled([...alerting]); }

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
  await Promise.allSettled([...alerting]);
  // BRO-7891: an inbox entry still 'queued' when the lane ends never went live (a stand-down dropped the queue, or
  // publishes kept failing). 'failed' alerts the person and the drain sends it to ingest-urls. A held copy stays
  // 'queued' (its original never went live either; the drain sends it on and the rebuild decides).
  for (const e of new Set(manualByKey.values())) {
    if (!manualQueued.has(gen(e)) || manualClosed.has(gen(e))) continue;
    noteInbox(e, 'failed', abandonPending() ? 'the lane stood down before publishing it; the drain sends it to ingest-urls' : 'not live when the lane ended; the drain sends it to ingest-urls');
  }
  await flushInbox();
  return { passes, admitted, published, errors, failed, skipped, removedCopies, quoteless, unpublished: pending.map((r) => r.key), awaiting: [...awaiting], stopped,
    inbox: readInbox ? { worked: [...manualByKey.values()].map((e) => e.id), closed: [...manualClosed].map((g) => g.split('@')[0]), unwritten: inboxUpdates.length } : null, settle: settleComparative ? { runs: settled.runs, moved: settled.moved || 0, failed: settled.failed, foreign: [...new Set(settled.foreign)] } : null };
}

module.exports = { runLaneNight, loadDone, applyManualEntry, MANUAL_TRIES };
