'use strict';

/**
 * press-night-record.js — pure logic for the per-night press-night record (BRO-5912).
 *
 * One JSON file per show per press night (data/audit/press-night/<show>-<night>.json)
 * answers "how fast did the night go?" from the DEPLOYED site, the only source that
 * matches what a reader sees and that no writer has to remember to log. A probe
 * samples https://broadwayscorecard.com/data/shows/<id>.json every few minutes from
 * the embargo, and this module turns those samples into:
 *   firstLiveAt / lastLiveAt / liveCountAt{1h,2h,6h}  (the new per-review first-live series)
 *   perReview[] and dropped[]                         (stability)
 *   reference{2h,end}                                 (census coverage, via review-census.js)
 *   a pass/fail/unknown verdict against the plan's gates (evaluateCheck)
 *
 * PUBLIC DATA ONLY. Every field comes from the public show JSON or from outlet ids in
 * the census, never review text or private fields, so `--check` works from a fresh
 * public checkout.
 *
 * "Unknown" is a first-class answer. A missing census, a date-only publish time or a
 * night with no samples must never read as a pass (the BRO-4210 / BRO-3260 closures
 * happened because absence of evidence looked like success).
 *
 * Pure: no network, no clock reads except through injected `now`/`sleep`.
 */

const SCHEMA_VERSION = 1;
const OFFSET_HOURS = [1, 2, 6];

// Press embargo lifts, local hour on opening day. Broadway ~22:00 ET (860 and ODC
// postmortem), West End ~21:00 UK. The orchestrator can override with an explicit time.
const EMBARGO_HOUR_LOCAL = { broadway: 22, 'off-broadway': 22, 'west-end': 21, 'off-west-end': 21 };

const DEFAULT_GATES = { firstLiveWithinMin: 30, coverage2h: 0.8 };

const MIN = 60000;
const HOUR = 3600000;

function defaultEmbargoAt(show) {
  const { MARKET_TZ, utcFromZoned } = require('./opening-night-windows');
  const tz = MARKET_TZ[show.category];
  const hour = EMBARGO_HOUR_LOCAL[show.category];
  if (!tz || hour == null || !show.openingDate) return null;
  return utcFromZoned(show.openingDate, hour, 0, tz).toISOString();
}

/**
 * Is this show's press night close enough for the orchestrator to start the probe now?
 * Only the opening-day embargo counts (night = openingDate), and the dispatch window is
 * [embargo - leadMin, embargo + lateMin]. Wide on purpose: the orchestrator marks later runs
 * of the same market redundant, so the one run that fires first must catch the night even
 * with GitHub's cron delay; a late start still yields a (baseline-flagged) record.
 * Returns {showId, night, market, embargoAt} or null.
 */
function probeDue(show, nowMs, { leadMin = 150, lateMin = 180 } = {}) {
  if (!show || !show.openingDate || show.category === 'tour') return null;
  const embargoAt = defaultEmbargoAt(show);
  if (!embargoAt) return null;
  const embMs = new Date(embargoAt).getTime();
  if (nowMs < embMs - leadMin * MIN || nowMs > embMs + lateMin * MIN) return null;
  return { showId: show.id || show.slug, night: show.openingDate, market: show.category, embargoAt };
}

function recordPath(dir, showId, night) {
  return `${dir.replace(/\/$/, '')}/${showId}-${night}.json`;
}

function emptyRecord({ showId, night, market = null, embargoAt, intervalMin = 5 }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    showId,
    night,
    market,
    embargoAt,
    probe: { startedAt: null, endedAt: null, intervalMin, samples: 0, failedSamples: 0, lastSampleAt: null, lastOkSampleAt: null },
    firstLiveAt: null,
    firstLiveBaseline: false, // reviews were already live at the first sample, so firstLiveAt is an upper bound
    lastLiveAt: null,
    liveCount: 0,
    liveCountAt: { '1h': null, '2h': null, '6h': null },
    liveCountSampleAt: { '1h': null, '2h': null, '6h': null }, // when each count was actually taken
    firstOutletPublishAt: { at: null, precision: 'unknown', source: 'prod-rv-publishDate', tierScope: null },
    perReview: [],
    dropped: [],
    reference: {},
  };
}

// Same identity as lib/dedup-by-critic.js, so counts agree with verify-opening-night-live.js.
function reviewKey(r) {
  const outlet = String(r.outlet || 'unknown').toLowerCase();
  const critic = String(r.critic || 'unknown').toLowerCase();
  return `${outlet}|${critic}`;
}

function tierNum(t) {
  if (t == null) return null;
  const n = parseInt(String(t).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function publishPrecision(d) {
  if (!d) return 'unknown';
  return /T\d{2}:\d{2}/.test(String(d)) ? 'exact' : 'approx';
}

function toMs(iso) {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fold one prod sample into the record (mutates and returns it).
 * @param {object} rec
 * @param {{at:string, reviews:Array|null}} sample  reviews = decodeSlimShow(json).reviews;
 *        null means the fetch failed or the page 404'd (counted, never read as "zero live").
 */
function applySample(rec, sample) {
  const at = sample.at;
  const atMs = toMs(at);
  rec.probe.samples += 1;
  if (!rec.probe.startedAt) rec.probe.startedAt = at;
  rec.probe.lastSampleAt = at;
  if (!Array.isArray(sample.reviews)) {
    rec.probe.failedSamples += 1;
    return rec;
  }
  const prevOk = rec.probe.lastOkSampleAt;
  rec.probe.lastOkSampleAt = at;

  const first = rec.probe.samples - rec.probe.failedSamples === 1;
  const byKey = new Map(rec.perReview.map((p) => [p.key, p]));
  const liveKeys = new Set();
  for (const r of sample.reviews) {
    const key = reviewKey(r);
    liveKeys.add(key);
    let p = byKey.get(key);
    if (!p) {
      p = {
        key,
        outlet: r.outlet || null,
        critic: r.critic || null,
        tier: tierNum(r.tier),
        publishAt: r.date || null,
        publishPrecision: publishPrecision(r.date),
        firstLiveAt: at,
        prevOkSampleAt: prevOk, // the last sample that saw the site without it: it went live in (prevOk, at]
        baseline: first,
        liveNow: true,
      };
      byKey.set(key, p);
      rec.perReview.push(p);
    } else {
      p.liveNow = true;
      // Keep the most precise publish time seen (a rebuild can upgrade date-only to a timestamp).
      const prec = publishPrecision(r.date);
      if (prec === 'exact' && p.publishPrecision !== 'exact') { p.publishAt = r.date; p.publishPrecision = prec; }
    }
  }

  // Rename: a critic/outlet label filled in mid-night (null -> name) changes the key of a
  // review that never left. Pair a vanished entry with a new one only when it is the single
  // candidate on both sides for that outlet; anything ambiguous stays a drop.
  const fresh = rec.perReview.filter((p) => p.firstLiveAt === at && !p.renamedFrom && p.liveNow && !p.pairChecked);
  for (const np of fresh) {
    np.pairChecked = true;
    const outletKey = String(np.outlet || '').toLowerCase();
    const gone = rec.perReview.filter((q) => q !== np && q.liveNow && !liveKeys.has(q.key) && String(q.outlet || '').toLowerCase() === outletKey);
    const sameOutletNew = fresh.filter((f) => String(f.outlet || '').toLowerCase() === outletKey);
    if (gone.length === 1 && sameOutletNew.length === 1) {
      const q = gone[0];
      q.renamedFrom = q.key;
      q.key = np.key;
      q.critic = np.critic;
      q.liveNow = true;
      if (np.publishPrecision === 'exact' && q.publishPrecision !== 'exact') { q.publishAt = np.publishAt; q.publishPrecision = np.publishPrecision; }
      rec.perReview.splice(rec.perReview.indexOf(np), 1);
    }
  }
  for (const p of rec.perReview) delete p.pairChecked;

  // Drops: seen live before, absent now. Restoration closes the entry.
  for (const p of rec.perReview) {
    if (liveKeys.has(p.key)) {
      const open = rec.dropped.find((d) => d.key === p.key && !d.restoredAt);
      if (open) open.restoredAt = at;
    } else if (p.liveNow) {
      p.liveNow = false;
      rec.dropped.push({ key: p.key, outlet: p.outlet, critic: p.critic, firstLiveAt: p.firstLiveAt, droppedAt: at, restoredAt: null });
    }
  }

  const prevCount = rec.liveCount;
  rec.liveCount = liveKeys.size;
  if (rec.liveCount > 0 && !rec.firstLiveAt) {
    rec.firstLiveAt = at;
    rec.firstLiveBaseline = first;
  }
  if (rec.liveCount > prevCount) rec.lastLiveAt = at;

  const embMs = toMs(rec.embargoAt);
  if (embMs != null && atMs != null) {
    for (const h of OFFSET_HOURS) {
      const k = `${h}h`;
      if (rec.liveCountSampleAt[k] == null && atMs >= embMs + h * HOUR) {
        // A sample taken long after the mark (late start, failed fetches) is not "the count at +Nh".
        const lateMs = atMs - (embMs + h * HOUR);
        rec.liveCountSampleAt[k] = at;
        if (lateMs <= 2 * (rec.probe.intervalMin || 5) * MIN) rec.liveCountAt[k] = rec.liveCount;
      }
    }
  }

  rec.firstOutletPublishAt = firstOutletPublish(rec);
  return rec;
}

/**
 * Earliest publish time among the first-tier (T1/T2) live reviews. Only reviews that
 * went live carry a publish time here, and only ~5% of them carry a clock time, so the
 * result says how sure it is: precision 'exact' | 'approx' (date only) | 'unknown'.
 */
function firstOutletPublish(rec) {
  // A preview-period review (published days before the night) is not "the first outlet publish" of the night.
  const withDate = rec.perReview.filter((p) => p.publishAt && isNightReview(p, rec.night));
  let pool = withDate.filter((p) => p.tier != null && p.tier <= 2);
  let tierScope = 'T1-T2';
  if (!pool.length) { pool = withDate; tierScope = withDate.length ? 'any' : null; }
  const exact = pool.filter((p) => p.publishPrecision === 'exact');
  const source = 'prod-rv-publishDate';
  if (exact.length) {
    const best = exact.reduce((a, b) => (toMs(a.publishAt) <= toMs(b.publishAt) ? a : b)); // mixed offsets: compare instants
    return { at: best.publishAt, precision: 'exact', source, tierScope };
  }
  if (pool.length) {
    const best = pool.reduce((a, b) => (a.publishAt <= b.publishAt ? a : b));
    return { at: best.publishAt, precision: 'approx', source, tierScope };
  }
  return { at: null, precision: 'unknown', source, tierScope };
}

/**
 * Is this review part of the press night (published on/after the night), as opposed to a
 * preview-period review that was live long before the embargo (BRO-6067: singleticket,
 * published 10-05, made every review "already live at the first sample")? A review with no
 * publish date counts only if the probe saw it go live (not at the first sample).
 */
function isNightReview(p, night) {
  if (!night) return true;
  if (p.publishAt) return String(p.publishAt).slice(0, 10) >= night;
  return !p.baseline;
}

function outletIdOf(name) {
  if (!name) return null;
  const { normalizeOutlet } = require('./review-normalization');
  return normalizeOutlet(String(name)) || null;
}

/**
 * When the first review of the night went live, merging the probe's per-review series with
 * the lane shadow's finer (2 min) site-live times. Returns {at, lowerAt, outlet, source, baseline} or null.
 * lowerAt is the previous poll: the review went live in (lowerAt, at].
 */
function firstNightLive(rec) {
  const intervalMs = (rec.probe && rec.probe.intervalMin ? rec.probe.intervalMin : 5) * MIN;
  const embMs = toMs(rec.embargoAt);
  const night = rec.perReview.filter((p) => isNightReview(p, rec.night));
  const nightOutlets = new Set(night.map((p) => outletIdOf(p.outlet)).filter(Boolean));
  const previewOutlets = new Set(rec.perReview.filter((p) => !isNightReview(p, rec.night)).map((p) => outletIdOf(p.outlet)).filter(Boolean));
  const cands = [];
  // Lower bound = the last poll that saw the site without the review. Older records lack prevOkSampleAt:
  // two intervals back is safe only when no sample failed; otherwise nothing bounds it below but the embargo.
  const probeLower = (p, ms) => {
    if (p.prevOkSampleAt !== undefined) return p.prevOkSampleAt ? toMs(p.prevOkSampleAt) : embMs;
    return rec.probe && rec.probe.failedSamples === 0 ? ms - 2 * intervalMs : embMs;
  };
  for (const p of night) {
    const ms = toMs(p.firstLiveAt);
    if (ms != null) cands.push({ ms, lowerMs: Math.min(ms, probeLower(p, ms)), outlet: p.outlet, source: 'probe', baseline: !!p.baseline });
  }
  const ls = rec.laneShadow;
  if (ls && Array.isArray(ls.liveFirstSeen)) {
    // Same rule for the shadow's 2-minute polls: a failed poll leaves no lower bound.
    const pollMs = ls.pollFailures === 0 ? 2 * (ls.pollMin || 2) * MIN : null;
    for (const r of ls.liveFirstSeen) {
      const ms = toMs(r.at);
      if (ms == null) continue;
      const oid = outletIdOf(r.outlet);
      // A shadow row is a night review if the probe knows it as one; otherwise only if it appeared after the
      // embargo and is not a preview-period outlet the probe already saw.
      const isNight = (oid && nightOutlets.has(oid)) || (embMs != null && ms >= embMs && !(oid && previewOutlets.has(oid)));
      // The shadow's first poll is a bound too (the review may have been live before it started).
      if (isNight) cands.push({ ms, lowerMs: pollMs != null ? ms - pollMs : Math.min(ms, embMs), outlet: r.outlet, source: 'lane-shadow', baseline: !!r.baseline });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.ms - b.ms || (a.baseline - b.baseline));
  const c = cands[0];
  return { at: new Date(c.ms).toISOString(), lowerAt: new Date(c.lowerMs).toISOString(), outlet: c.outlet, source: c.source, baseline: c.baseline };
}

/**
 * Fold a lane-shadow artifact (opening-night-lane-live.yml shadow job: shadow-report.json,
 * live-first-seen.jsonl, ledger/<show>-<night>.jsonl) into the record. Public fields only:
 * outlet names, review URLs and times. The earliest lane discovery is an upper bound on the
 * first outlet publish (a review cannot be found before it is published).
 */
function laneShadowFrom({ report = null, liveRows = [], ledgerRows = [], importedAt = null, runId = null }) {
  const startedMs = report && Number.isFinite(Number(report.startedAt)) ? Number(report.startedAt) : toMs(report && report.startedAt);
  const firstPoll = liveRows.reduce((m, r) => (Number.isFinite(r.at) && r.at < m ? r.at : m), Infinity);
  const startMs = startedMs != null ? startedMs : firstPoll;
  const liveFirstSeen = liveRows
    .filter((r) => r && Number.isFinite(r.at))
    .map((r) => ({ outlet: r.outlet || null, url: r.url || null, at: new Date(r.at).toISOString(), baseline: r.at - startMs < 3 * MIN }));
  const discovered = ledgerRows.filter((r) => r && r.stage === 'discovered' && toMs(r.at) != null);
  const firstDiscoveredAt = discovered.length ? discovered.map((r) => r.at).sort()[0] : null;
  const discoveredByOutlet = {};
  const roundups = new Set();
  for (const r of discovered) {
    const url = (r.meta && r.meta.url) || r.reviewKey;
    let oid = null;
    try { const { resolveOutletFromUrl } = require('./review-normalization'); const x = resolveOutletFromUrl(url); oid = x && x.outletId; } catch (_) { oid = null; }
    if (oid && (!discoveredByOutlet[oid] || r.at < discoveredByOutlet[oid])) discoveredByOutlet[oid] = r.at;
    if (r.meta && r.meta.adapter === 'bww-roundup' && /^https?:\/\//.test(r.meta.via || '')) roundups.add(r.meta.via);
  }
  return {
    importedAt, runId,
    startedAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    pollMin: 2,
    pollFailures: report && Number.isFinite(Number(report.livePollFailures)) ? Number(report.livePollFailures) : null,
    firstDiscoveredAt,
    discoveredByOutlet,
    bwwRoundupUrl: [...roundups][0] || null,
    liveFirstSeen,
  };
}

/**
 * Census coverage AS OF a past moment, from the record's own per-review live series (plus the
 * lane shadow's site-live times). Lets a census fetched later (the roundup was not archived at +2h)
 * still answer "how much was live at +2h". The later census can only add outlets, so this is a
 * conservative (lower) coverage; outlets the lane first found after asOf are listed (discoveredAfter).
 */
function coverageAt(rec, census, asOfMs, { fetchedAt = null } = {}) {
  const { censusVerdict } = require('./review-census');
  const asOf = new Date(asOfMs).toISOString();
  const liveSet = new Set();
  const droppedNow = new Set(); // probe-observed drops still open at asOf override any earlier sighting
  for (const p of rec.perReview) {
    const ms = toMs(p.firstLiveAt);
    if (ms == null || ms > asOfMs) continue;
    const oid = outletIdOf(p.outlet);
    const gone = rec.dropped.find((d) => d.key === p.key && toMs(d.droppedAt) <= asOfMs && (!d.restoredAt || toMs(d.restoredAt) > asOfMs));
    if (gone) { if (oid) droppedNow.add(oid); continue; }
    if (oid) liveSet.add(oid);
  }
  // The shadow's site-live times (finer polls) count unless the probe saw that outlet dropped by asOf.
  const ls = rec.laneShadow;
  if (ls && Array.isArray(ls.liveFirstSeen)) {
    for (const r of ls.liveFirstSeen) {
      const oid = outletIdOf(r.outlet);
      if (oid && !droppedNow.has(oid) && toMs(r.at) != null && toMs(r.at) <= asOfMs) liveSet.add(oid);
    }
  }
  // Every census outlet stays in the denominator: a lane discovery after asOf bounds the publish time
  // from above only, so it cannot prove the review was not out yet. Listed for the reader, never excluded.
  const scoped = census;
  const notYetPublished = [];
  const discoveredAfter = [];
  const disc = ls && ls.discoveredByOutlet;
  if (census && Array.isArray(census.entries) && disc) {
    for (const e of census.entries) {
      const d = disc[e.outletId];
      if (d && toMs(d) > asOfMs && !liveSet.has(e.outletId)) discoveredAfter.push(e.outletId);
    }
  }
  const ref = referenceFrom({ census: scoped, verdict: censusVerdict(scoped, liveSet), liveCount: liveSet.size, fetchedAt });
  return { ...ref, asOf, method: 'timeline', notYetPublished, discoveredAfter };
}

/**
 * Build the sampling loop. Resumable: pass an existing record. Stops when `untilMs`
 * is reached. All side effects (fetch, sleep, persistence, clock) are injected.
 */
async function runProbe({ rec, fetchReviews, now = () => Date.now(), sleep, untilMs, intervalMs, onSample = () => {}, maxSamples = Infinity }) {
  let n = 0;
  while (n < maxSamples) {
    const t = now();
    if (t >= untilMs) break;
    let reviews = null;
    try { reviews = await fetchReviews(); } catch (_) { reviews = null; }
    applySample(rec, { at: new Date(now()).toISOString(), reviews });
    n += 1;
    onSample(rec);
    if (n >= maxSamples) break;
    const remaining = untilMs - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return rec;
}

/**
 * Census coverage at one moment. `verdict` is review-census.censusVerdict output,
 * `census` its input. No census (or none archived yet) is 'no-census-yet', never 100%.
 */
function referenceFrom({ census, verdict, liveCount, fetchedAt }) {
  if (!verdict || verdict.verdict === 'no-census-yet' || !census || !census.count) {
    return { status: 'no-census-yet', source: null, count: 0, covered: null, coverage: null, missing: [], liveCount, fetchedAt };
  }
  const missing = verdict.missing.map((e) => e.outletId);
  const suppressed = verdict.suppressedMissing.map((e) => e.outletId);
  const covered = census.count - missing.length - suppressed.length;
  return {
    status: verdict.verdict,
    source: census.sourcesPresent,
    count: census.count,
    covered,
    coverage: Math.round((covered / census.count) * 1000) / 1000,
    missing,
    suppressedMissing: suppressed,
    liveCount,
    fetchedAt,
  };
}

function gate(name, status, detail, required = true) {
  return { name, status, detail, required };
}

/**
 * Verdict against the plan's gates (doc section 2). Pure.
 *   first-live    first review live within N min of the first outlet publish
 *   coverage-2h   census coverage at embargo +2h >= bar
 *   stability     no review dropped after going live
 *   coverage-end  coverage when the probe ended (informational, +6h, not +24h)
 * Anything that cannot be established is 'unknown', never 'pass'.
 */
function evaluateCheck(rec, opts = {}) {
  const g = { ...DEFAULT_GATES, ...opts };
  const gates = [];
  if (!rec) {
    return { verdict: 'UNKNOWN', gates: [gate('record', 'unknown', 'no record for this show and night (probe did not run, or the file is not committed yet)')] };
  }
  const okSamples = rec.probe.samples - rec.probe.failedSamples;
  const embMs = toMs(rec.embargoAt);

  // first-live: the first review OF THE NIGHT (preview-period reviews excluded, BRO-6067)
  const fl = firstNightLive(rec);
  if (okSamples === 0 || embMs == null) {
    gates.push(gate('first-live', 'unknown', 'no successful probe samples'));
  } else if (!fl) {
    const lastMs = toMs(rec.probe.lastOkSampleAt); // failed fetches prove nothing about the site
    const waited = lastMs != null ? Math.round((lastMs - embMs) / MIN) : null;
    // Nothing live is only our failure if some outlet demonstrably published (a census entry, a lane
    // discovery); a night no critic wrote up is not a slow site.
    const refs = Object.values(rec.reference || {});
    const published = refs.some((r) => r && r.count > 0) || !!(rec.laneShadow && rec.laneShadow.firstDiscoveredAt);
    if (waited != null && waited > g.firstLiveWithinMin && !published) {
      gates.push(gate('first-live', 'unknown', `no review of the night live ${waited} min after the embargo, and no census or lane discovery shows any outlet published`));
    } else if (waited != null && waited > g.firstLiveWithinMin) {
      gates.push(gate('first-live', 'fail', `no review of the night live ${waited} min after the embargo (bar ${g.firstLiveWithinMin})`));
    } else {
      gates.push(gate('first-live', 'unknown', 'no review of the night live yet and the probe stopped inside the bar'));
    }
  } else {
    const liveMs = toMs(fl.at);
    const liveLowerMs = toMs(fl.lowerAt);
    const afterEmbargo = Math.round((liveMs - embMs) / MIN);
    const pub = rec.firstOutletPublishAt || {};
    const exactPub = pub.precision === 'exact' && toMs(pub.at) != null ? toMs(pub.at) : null;
    // Publish window: an exact time pins it. Otherwise reviews are held to the embargo (lower bound) and the
    // lane shadow's first discovery is an upper bound (nothing is found before it is published).
    const discMs = rec.laneShadow ? toMs(rec.laneShadow.firstDiscoveredAt) : null;
    // An exact time is one outlet's publish, not necessarily the first: the first publish is at most
    // min(exact, first discovery) and, reviews being held, at least min(embargo, exact).
    const discHigh = discMs != null && discMs >= embMs - 30 * MIN ? Math.max(discMs, embMs) : null;
    // A discovery well before the assumed embargo (a market default) means the first publish may be earlier than
    // pubLow, so delayHigh bounds nothing and cannot PASS. A FAIL from delayLow still holds.
    const embargoDoubt = discMs != null && discHigh == null;
    const pubLow = exactPub != null ? Math.min(exactPub, embMs) : embMs;
    const highs = [exactPub, discHigh].filter((x) => x != null);
    const pubHigh = highs.length ? Math.min(...highs) : null;
    const delayHigh = Math.round((liveMs - pubLow) / MIN);
    const delayLow = pubHigh != null ? Math.max(0, Math.round((liveLowerMs - pubHigh) / MIN)) : null;
    const pubWhat = exactPub != null ? 'the first outlet publish' : (pubHigh != null ? 'the first outlet publish (embargo .. first lane discovery)' : 'the embargo');
    const range = delayLow != null && delayLow !== delayHigh ? `${delayLow}-${delayHigh}` : `${delayHigh}`;
    const who = `${fl.outlet || 'a review'} via ${fl.source}`;
    const detail = `first review of the night (${who}) live ${range} min after ${pubWhat}${pubWhat === 'the embargo' ? '' : `; ${afterEmbargo} min after embargo`} (bar ${g.firstLiveWithinMin})`;
    let status;
    // A baseline first-live time is only an upper bound on when it went live: it can clear the bar, never fail it.
    if (!embargoDoubt && delayHigh <= g.firstLiveWithinMin) status = 'pass';
    else if (fl.baseline) status = 'unknown';
    else if (delayLow != null && delayLow > g.firstLiveWithinMin) status = 'fail';
    else status = 'unknown';
    let why = '';
    if (status === 'unknown' && embargoDoubt) why = `; the lane found a review at ${rec.laneShadow.firstDiscoveredAt}, more than 30 min before the assumed embargo, so either the embargo (a market default) is wrong or that was an earlier review, and the delay cannot be measured`;
    else if (status === 'unknown') why = (fl.baseline ? ' (already live at the first sample, so only a bound)' : `; publish time is ${pub.precision || 'unknown'} and no lane discovery bounds it, so the publish-to-live delay cannot be measured`);
    gates.push(gate('first-live', status, detail + why));
  }

  // coverage-2h
  const ref2 = rec.reference && rec.reference['2h'];
  if (!ref2) {
    gates.push(gate('coverage-2h', 'unknown', 'no census captured at embargo +2h'));
  } else if ((ref2.asOf || ref2.fetchedAt) && embMs != null && Math.abs(toMs(ref2.asOf || ref2.fetchedAt) - (embMs + 2 * HOUR)) > 30 * MIN) {
    gates.push(gate('coverage-2h', 'unknown', `census coverage is as of ${ref2.asOf || ref2.fetchedAt}, not near embargo +2h`));
  } else if (ref2.status === 'no-census-yet' || ref2.coverage == null) {
    gates.push(gate('coverage-2h', 'unknown', `no census (${ref2.status || 'missing'}), cannot judge coverage`));
  } else {
    gates.push(gate('coverage-2h', ref2.coverage >= g.coverage2h ? 'pass' : 'fail',
      `${ref2.covered}/${ref2.count} census outlets live at +2h = ${ref2.coverage} (bar ${g.coverage2h}; census ${(ref2.source || []).join('+') || '?'}${ref2.method === 'timeline' ? `, fetched ${ref2.fetchedAt}, judged on the live timeline` : ''})${ref2.missing.length ? `; missing: ${ref2.missing.join(', ')}` : ''}${ref2.discoveredAfter && ref2.discoveredAfter.length ? `; first found by the lane after +2h: ${ref2.discoveredAfter.join(', ')}` : ''}`));
  }

  // stability
  if (okSamples === 0) {
    gates.push(gate('stability', 'unknown', 'no successful probe samples'));
  } else {
    const stuck = rec.dropped.filter((d) => !d.restoredAt);
    const flapped = rec.dropped.length - stuck.length;
    if (stuck.length) gates.push(gate('stability', 'fail', `${stuck.length} review(s) dropped after going live and not restored: ${stuck.map((d) => d.outlet).join(', ')}`));
    else gates.push(gate('stability', 'pass', flapped ? `${flapped} drop(s), all restored` : 'no review dropped after going live'));
  }

  // coverage-end (informational)
  const refEnd = rec.reference && rec.reference.end;
  if (refEnd && refEnd.coverage != null) {
    gates.push(gate('coverage-end', 'info', `${refEnd.covered}/${refEnd.count} census outlets live when the probe ended = ${refEnd.coverage}`, false));
  } else {
    gates.push(gate('coverage-end', 'unknown', 'no census at probe end (the probe stops at +6h; +24h is not measured)', false));
  }

  const required = gates.filter((x) => x.required);
  let verdict = 'PASS';
  if (required.some((x) => x.status === 'fail')) verdict = 'FAIL';
  else if (required.some((x) => x.status !== 'pass')) verdict = 'UNKNOWN';
  return { verdict, gates };
}

module.exports = {
  SCHEMA_VERSION, OFFSET_HOURS, DEFAULT_GATES, EMBARGO_HOUR_LOCAL,
  defaultEmbargoAt, probeDue, recordPath, emptyRecord, reviewKey, applySample, firstOutletPublish,
  runProbe, referenceFrom, evaluateCheck, isNightReview, firstNightLive, laneShadowFrom, coverageAt,
};
