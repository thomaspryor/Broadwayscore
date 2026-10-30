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
// postmortem), West End ~21:00 UK. A show's `reviewEmbargoAt` (ISO UTC, shows.json) wins over the
// market hour when it is on the opening night (BRO-6614: A Few Good Men's reviews came out ~23:00 ET).
const EMBARGO_HOUR_LOCAL = { broadway: 22, 'off-broadway': 22, 'west-end': 21, 'off-west-end': 21 };

// A reviewEmbargoAt counts as the opening night when it falls in [openingDate 12:00, next day 04:00) local.
const OVERRIDE_NIGHT_FROM_HOUR = 12;
const OVERRIDE_NIGHT_TO_HOUR_NEXT_DAY = 4;
// The orchestrator dispatches the probe once per run, and its evening crons fire about an hour before the
// market default (opening-night-orchestrator.yml schedule) with a [-150, +180] min start window (probeDue).
// An override more than this far from the market default is not reached by any scheduled run.
const OVERRIDE_REACH_MIN = { before: 180, after: 120 };
// The probe waits until embargo - PROBE_LEAD_MIN (press-night-probe.yml) and starts the lane shadow then.
const PROBE_LEAD_MIN = 30;
// Grading: a first lane discovery more than this after the assumed embargo means the release was later.
const LATE_RELEASE_MIN = 30;

// sameNight*: BRO-6070. Files first seen between nightStartH before and sameNightEndH after the embargo
// are "of the night"; those seen by +2h must be live at +2h, later ones within lateLiveWithinMin of first seen.
const DEFAULT_GATES = { firstLiveWithinMin: 30, coverage2h: 0.8, lateLiveWithinMin: 30, nightStartH: 4, sameNightEndH: 3 };

const MIN = 60000;
const HOUR = 3600000;

/** The market's fixed-hour embargo for the opening day, ignoring any per-show override. */
function marketEmbargoAt(show) {
  const { MARKET_TZ, utcFromZoned } = require('./opening-night-windows');
  const tz = MARKET_TZ[show.category];
  const hour = EMBARGO_HOUR_LOCAL[show.category];
  if (!tz || hour == null || !show.openingDate) return null;
  return utcFromZoned(show.openingDate, hour, 0, tz).toISOString();
}

/**
 * Why a show's reviewEmbargoAt cannot be used, or null when it is absent or valid. It must be an ISO time
 * with Z or an explicit offset, on the show's opening night in the market's time zone, so a typo cannot
 * move the night.
 */
function embargoOverrideProblem(show) {
  if (!show || show.reviewEmbargoAt == null) return null;
  const v = show.reviewEmbargoAt;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    return `reviewEmbargoAt ${JSON.stringify(v)} is not an ISO time with Z or an offset`;
  }
  const ms = Date.parse(v);
  // Date.parse rolls an impossible date forward (Feb 30 -> Mar 2); the written fields must round-trip.
  const [y, mo, d, h, mi] = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).slice(1).map(Number);
  const f = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (!Number.isFinite(ms) || f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d || f.getUTCHours() !== h || f.getUTCMinutes() !== mi) {
    return `reviewEmbargoAt ${v} does not parse`;
  }
  const { MARKET_TZ, utcFromZoned, nextDay } = require('./opening-night-windows');
  const tz = MARKET_TZ[show.category];
  if (!tz) return `reviewEmbargoAt set on a show whose category ${show.category || '(none)'} has no press-night market`;
  if (!show.openingDate || !/^\d{4}-\d{2}-\d{2}$/.test(show.openingDate)) return 'reviewEmbargoAt set but openingDate is missing';
  const from = utcFromZoned(show.openingDate, OVERRIDE_NIGHT_FROM_HOUR, 0, tz).getTime();
  const to = utcFromZoned(nextDay(show.openingDate), OVERRIDE_NIGHT_TO_HOUR_NEXT_DAY, 0, tz).getTime();
  if (ms < from || ms >= to) {
    return `reviewEmbargoAt ${v} is not on the opening night of ${show.openingDate} (${tz} ${OVERRIDE_NIGHT_FROM_HOUR}:00 to ${OVERRIDE_NIGHT_TO_HOUR_NEXT_DAY}:00 next day)`;
  }
  return null;
}

/**
 * A valid override the scheduled orchestrator cannot reach (it fires near the market default), or null.
 * Advisory: the override is still honored, but the probe must be dispatched by hand.
 */
function embargoOverrideReachWarning(show) {
  if (!show || show.reviewEmbargoAt == null || embargoOverrideProblem(show)) return null;
  const def = marketEmbargoAt(show);
  if (!def) return null;
  const diffMin = (Date.parse(show.reviewEmbargoAt) - Date.parse(def)) / MIN;
  if (diffMin < -OVERRIDE_REACH_MIN.before || diffMin > OVERRIDE_REACH_MIN.after) {
    return `reviewEmbargoAt ${show.reviewEmbargoAt} is ${Math.round(diffMin)} min from the market default ${def}; no scheduled orchestrator run starts the probe for it, dispatch press-night-probe.yml by hand`;
  }
  return null;
}

/** {at, source: 'override'|'market-default'|null, problem}. An invalid override is ignored, never used. */
function embargoInfo(show) {
  const problem = embargoOverrideProblem(show);
  if (show && show.reviewEmbargoAt != null && !problem) {
    return { at: new Date(show.reviewEmbargoAt).toISOString(), source: 'override', problem: null };
  }
  const at = show ? marketEmbargoAt(show) : null;
  return { at, source: at ? 'market-default' : null, problem };
}

function defaultEmbargoAt(show) {
  return embargoInfo(show).at;
}

/**
 * Where a record's embargo came from, by comparison: the probe workflow always passes --embargo-at, so the
 * CLI cannot see whether the default was used. 'override' when it equals the show's valid override,
 * 'market-default' when it equals the market hour, 'manual' otherwise (an operator's explicit time).
 */
function classifyEmbargo(show, embargoAt) {
  const ms = Date.parse(embargoAt);
  if (!show || !Number.isFinite(ms)) return 'manual';
  const info = embargoInfo(show);
  if (info.source === 'override' && Date.parse(info.at) === ms) return 'override';
  const def = marketEmbargoAt(show);
  if (def && Date.parse(def) === ms) return 'market-default';
  return 'manual';
}

/**
 * Is this show's press night close enough for the orchestrator to start the probe now?
 * Only the opening-day embargo counts (night = openingDate), and the dispatch window is
 * [embargo - leadMin, embargo + lateMin]. Wide on purpose: the orchestrator marks later runs
 * of the same market redundant, so the one run that fires first must catch the night even
 * with GitHub's cron delay; a late start still yields a (baseline-flagged) record. The embargo is the
 * show's reviewEmbargoAt when set (BRO-6614), so the window moves with it.
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

function emptyRecord({ showId, night, market = null, embargoAt, embargoSource = null, intervalMin = 5 }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    showId,
    night,
    market,
    embargoAt,
    ...(embargoSource ? { embargoSource } : {}),
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
    // BRO-6652: hand fixes inside the night window. Stamped from the start, so an empty list means "none",
    // and a record without the field (older than the stamp) never counts as passed on its own.
    manualActions: [],
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
 * BRO-6652: who published the night. The regular pipeline unless the lane alone published: the old path
 * stood down for this show (lane-only-markets.js oldPathStandsDown) at a capture. Sticky: one stand-down
 * seen makes the night a lane night. A record without the stamp (older, or the stamp could not run) is
 * 'regular', which is what every night before the lane-only cutover was.
 */
function publishPath(rec) {
  const p = rec && rec.publishedBy && rec.publishedBy.path;
  return p === 'lane' || p === 'unknown' ? p : 'regular';
}

// A lane-only answer that proves the old path published: the market is not lane-only, the lane stood down,
// or (inside the night, so not the end capture, which always falls outside the lane's +6h window) the lane
// held no lease. Every other "keep the old path" answer is an unread input or out of window: unknown.
function provesRegular(c) {
  if (c.standDown !== false) return false;
  const r = String(c.reason || '');
  if (/^market not lane-only$|^lane .* stood down \(exit 3\)$|^LANE_STANDDOWN covers the show$/.test(r)) return true;
  return r === 'no live lane lease' && c.label !== 'end';
}

/**
 * Merge one lane-only decision into rec.publishedBy. `decision` is oldPathStandsDown output, or null when
 * it could not be read (then the stamp records the error and keeps any earlier lane answer).
 */
function stampPublishedBy(rec, decision, { checkedAt, label = null, error = null } = {}) {
  const check = {
    at: checkedAt, label, standDown: decision ? !!decision.standDown : null,
    reason: decision ? decision.reason : (error || 'decision unavailable'),
    ...(decision && decision.holder ? { holder: decision.holder } : {}),
  };
  const checks = [...((rec.publishedBy && rec.publishedBy.checks) || []), check];
  const lane = checks.find((c) => c.standDown === true);
  rec.publishedBy = {
    path: lane ? 'lane' : checks.some(provesRegular) ? 'regular' : 'unknown',
    method: 'lane-only-decision',
    ...(lane ? { holder: lane.holder || null, stoodDownSeenAt: lane.at } : {}),
    checks,
  };
  return rec.publishedBy;
}

/**
 * BRO-6652: log a hand fix made during the night (an ingest, a rescore, a manual deploy). A night with any
 * entry never counts as passed on its own. Same outlet, time and kind = one entry.
 */
function addManualAction(rec, { at, outletId = null, outlet = null, kind = 'hand-fix', source = null }) {
  if (toMs(at) == null) throw new Error('manual action: --at must be an ISO time');
  if (!source) throw new Error('manual action: --source must name the card or comment');
  if (!Array.isArray(rec.manualActions)) rec.manualActions = [];
  const dup = rec.manualActions.find((m) => toMs(m.at) === toMs(at) && (m.outletId || null) === (outletId || null) && m.kind === kind);
  if (dup) return { entry: dup, added: false };
  const entry = { at: new Date(toMs(at)).toISOString(), outletId, outlet, kind, source };
  rec.manualActions.push(entry);
  rec.manualActions.sort((a, b) => toMs(a.at) - toMs(b.at));
  return { entry, added: true };
}

/** Hand fixes inside the night window ([embargo - nightStartH, embargo + 6h]). Undefined = never stamped. */
function nightManualActions(rec, g = DEFAULT_GATES) {
  if (!rec || !Array.isArray(rec.manualActions)) return undefined;
  const embMs = toMs(rec.embargoAt);
  if (embMs == null) return rec.manualActions;
  return rec.manualActions.filter((m) => toMs(m.at) >= embMs - g.nightStartH * HOUR && toMs(m.at) <= embMs + 6 * HOUR);
}

/**
 * Census coverage AS OF a past moment, from the record's own per-review live series (plus the
 * lane shadow's site-live times). Lets a census fetched later (the roundup was not archived at +2h)
 * still answer "how much was live at +2h". The later census can only add outlets, so this is a
 * conservative (lower) coverage; outlets the lane first found after asOf are listed (discoveredAfter).
 */
function coverageAt(rec, census, asOfMs, { fetchedAt = null, excluded = [], deferLateSeen = false } = {}) {
  const { censusVerdict } = require('./review-census');
  census = filterCensus(census, excluded);
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
  let scoped = census;
  let deferredLate = [];
  // Re-judging +2h against a later census (BRO-6079): a listing whose only night file was first seen (or
  // published, by a timed publishDate) after asOf is graded by the 30-min rule of same-night-completeness,
  // not held to the +2h bar. An outlet with no file, or a file seen by asOf, stays in the denominator.
  if (deferLateSeen && census && Array.isArray(census.entries) && rec.fileState && Array.isArray(rec.fileState.files)) {
    const embMs = toMs(rec.embargoAt);
    const winStart = embMs == null ? null : embMs - DEFAULT_GATES.nightStartH * HOUR;
    const earliest = new Map();
    for (const f of rec.fileState.files) {
      if (!f.includable || !f.outletId) continue;
      const seen = toMs(f.firstSeenAt);
      if (seen == null || (winStart != null && seen < winStart)) continue;
      const pub = typeof f.publishDate === 'string' && f.publishDate.includes('T') ? toMs(f.publishDate) : null;
      const t = pub != null ? Math.min(seen, pub) : seen;
      if (!earliest.has(f.outletId) || t < earliest.get(f.outletId)) earliest.set(f.outletId, t);
    }
    // Only within the same-night window: sameNightCheck grades nothing first seen after it, so a deferral
    // past it would leave the review graded by neither rule.
    const lateEnd = embMs == null ? asOfMs : embMs + DEFAULT_GATES.sameNightEndH * HOUR;
    const isDeferred = (e) => !liveSet.has(e.outletId) && earliest.has(e.outletId) && earliest.get(e.outletId) > asOfMs && earliest.get(e.outletId) <= lateEnd;
    deferredLate = census.entries.filter(isDeferred).map((e) => e.outletId);
    const entries = census.entries.filter((e) => !isDeferred(e));
    scoped = { ...census, entries, count: entries.length };
  }
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
  return { ...ref, asOf, method: 'timeline', notYetPublished, discoveredAfter, ...(deferredLate.length ? { deferredToLateRule: deferredLate } : {}), ...(excluded.length ? { excluded } : {}) };
}

/**
 * Drop census entries the rebuild correctly keeps off the site (wrongProduction, wrongShow, non-review,
 * roundup, rejected, or a syndicated copy of a live primary; see press-night-review-state.censusExclusions).
 * They are not "missing": counting them made a correct night read 14/16 (BRO-6070).
 */
function filterCensus(census, excluded) {
  if (!census || !Array.isArray(census.entries) || !excluded || !excluded.length) return census;
  const drop = new Set(excluded.map((x) => x.outletId));
  const entries = census.entries.filter((e) => !drop.has(e.outletId));
  return { ...census, entries, count: entries.length };
}

const { foldDiacritics } = require('./title-match');
const critKey = (c) => foldDiacritics(String(c || '')).toLowerCase().replace(/[^a-z]/g, ''); // fold first: 'Zoë' must not shred to 'zo'

/**
 * Earliest site-live time of the night's reviews, keyed by outlet|critic (byCritic) and by outlet (byOutlet,
 * which also folds in the lane shadow's finer polls). Preview-period rows are skipped: a review live weeks
 * before the embargo is not proof that another critic's night review is live (BRO-6070 review).
 */
function outletLiveMs(rec) {
  const byCritic = new Map();
  const byOutlet = new Map();
  const min = (m, k, ms) => { if (!m.has(k) || ms < m.get(k)) m.set(k, ms); };
  for (const p of rec.perReview) {
    if (!isNightReview(p, rec.night)) continue;
    const oid = outletIdOf(p.outlet); const ms = toMs(p.firstLiveAt);
    if (!oid || ms == null) continue;
    min(byCritic, `${oid}|${critKey(p.critic)}`, ms);
    min(byOutlet, oid, ms);
  }
  const ls = rec.laneShadow;
  if (ls && Array.isArray(ls.liveFirstSeen)) {
    for (const r of ls.liveFirstSeen) {
      if (r.baseline) continue;
      const oid = outletIdOf(r.outlet); const ms = toMs(r.at);
      if (oid && ms != null) min(byOutlet, oid, ms);
    }
  }
  return { byCritic, byOutlet };
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * same-night-completeness (BRO-6070): "all reviews added the night a show opens".
 *  (a) at embargo +2h every includable listing (census, exclusions applied) and every includable review file
 *      first seen by +2h is live;
 *  (b) an includable file first seen later that night (until embargo +sameNightEndH) is live within
 *      lateLiveWithinMin of first seen.
 * Needs rec.fileState (the review-text snapshot taken at capture). Without it the gate is unknown.
 * items (BRO-6645, once the snapshot is readable): one row per review the night is held to, for the morning
 * email's plain-English line: {outletId, outlet, critic, seenAt, liveAt, status: ontime|late|missing|pending}.
 * A census outlet with no review file of the night gets one outlet-level row (critic null).
 * @returns {{status:string, detail:string, items?:Array}}
 */
function sameNightCheck(rec, g) {
  const embMs = toMs(rec.embargoAt);
  const fsnap = rec.fileState;
  if (embMs == null) return { status: 'unknown', detail: 'no embargo time' };
  if (!fsnap || !Array.isArray(fsnap.files)) return { status: 'unknown', detail: 'no review-file snapshot in the record (private review texts were not available at capture), so late or missing reviews cannot be named' };
  const { byCritic, byOutlet } = outletLiveMs(rec);
  const t2 = embMs + 2 * HOUR;
  const nightFiles = fsnap.files.filter((f) => f.includable && f.outletId && toMs(f.firstSeenAt) != null
    && toMs(f.firstSeenAt) >= embMs - g.nightStartH * HOUR && toMs(f.firstSeenAt) <= embMs + g.sameNightEndH * HOUR);
  const perOutletFiles = new Map();
  for (const f of nightFiles) perOutletFiles.set(f.outletId, (perOutletFiles.get(f.outletId) || 0) + 1);
  // Live time of this file's review. By critic when the file names one. The outlet-level time (which includes
  // the lane shadow) stands in only when the outlet has a single night file, so it cannot vouch for a second critic.
  const liveOf = (f) => {
    const ck = critKey(f.critic);
    const c = ck && ck !== 'unknown' ? byCritic.get(`${f.outletId}|${ck}`) : undefined;
    const o = (!ck || ck === 'unknown' || perOutletFiles.get(f.outletId) === 1) ? byOutlet.get(f.outletId) : undefined;
    return c != null && o != null ? Math.min(c, o) : (c != null ? c : o);
  };
  const winStart = embMs - g.nightStartH * HOUR;
  const winEnd = embMs + g.sameNightEndH * HOUR;
  const lastOk = toMs(rec.probe && rec.probe.lastOkSampleAt);
  const missA = new Map(); // outlet -> reason
  const missB = new Map();
  const unknownB = [];
  const items = [];
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const item = (f, seen, liveAt, status) => items.push({ outletId: f.outletId, outlet: f.outlet || null, critic: f.critic || null, seenAt: iso(seen), liveAt: iso(liveAt), status, ...(f.scoredAt ? { scoredAt: f.scoredAt } : {}) });
  const ref2 = rec.reference && rec.reference['2h'];
  const censusKnown = !!(ref2 && ref2.coverage != null && ref2.status !== 'no-census-yet');
  if (censusKnown) for (const o of ref2.missing) missA.set(o, 'listed by the aggregators, not live at +2h');
  for (const f of fsnap.files) {
    if (!f.includable || !f.outletId) continue;
    const seen = toMs(f.firstSeenAt);
    if (seen == null || seen < winStart || seen > winEnd) continue;
    const liveAt = liveOf(f);
    if (seen <= t2) {
      // Held to +2h, but a review first seen a minute before +2h gets the same latency the late branch allows.
      if (liveAt == null || liveAt > Math.max(t2, seen + g.lateLiveWithinMin * MIN)) {
        const when = liveAt == null ? 'never live in the probe window' : `live at ${hhmm(liveAt)}, after +2h`;
        missA.set(f.outletId, `review first seen ${hhmm(seen)}, ${when}`);
        item(f, seen, liveAt, liveAt == null ? 'missing' : 'late');
      } else item(f, seen, liveAt, 'ontime');
    } else if (liveAt == null) {
      if (lastOk != null && lastOk >= seen + g.lateLiveWithinMin * MIN) {
        missB.set(f.outletId, `first seen ${hhmm(seen)}, never live in the probe window`);
        item(f, seen, null, 'missing');
      } else {
        unknownB.push(f.outletId);
        item(f, seen, null, 'pending');
      }
    } else if (liveAt > seen + g.lateLiveWithinMin * MIN) {
      missB.set(f.outletId, `first seen ${hhmm(seen)}, live ${hhmm(liveAt)} (${Math.round((liveAt - seen) / MIN)} min later, bar ${g.lateLiveWithinMin})`);
      item(f, seen, liveAt, 'late');
    } else item(f, seen, liveAt, 'ontime');
  }
  // Census outlets held to +2h with no review file of the night: one outlet-level row.
  for (const o of missA.keys()) {
    if (items.some((x) => x.outletId === o)) continue;
    const named = fsnap.files.find((f) => f.outletId === o && f.outlet) || rec.perReview.find((p) => outletIdOf(p.outlet) === o);
    const liveAt = byOutlet.get(o);
    items.push({ outletId: o, outlet: named ? named.outlet : null, critic: null, seenAt: null, liveAt: iso(liveAt), status: liveAt == null ? 'missing' : 'late' });
  }
  // Night reviews live by +2h that no file row covers (no first-seen time in the snapshot, or seen before the
  // window): on time, and they belong in "N of M live".
  for (const p of rec.perReview) {
    if (!isNightReview(p, rec.night)) continue;
    const o = outletIdOf(p.outlet); const ms = toMs(p.firstLiveAt);
    if (!o || ms == null || ms > t2) continue;
    const ck = critKey(p.critic);
    if (items.some((x) => x.outletId === o && (!x.critic || critKey(x.critic) === ck || ck === 'unknown' || !ck))) continue;
    items.push({ outletId: o, outlet: p.outlet, critic: p.critic || null, seenAt: null, liveAt: iso(ms), status: 'ontime' });
  }
  const staleSnapshot = toMs(fsnap.capturedAt) != null && toMs(fsnap.capturedAt) < winEnd + g.lateLiveWithinMin * MIN;
  const list = (m) => [...m].map(([o, why]) => `${o} (${why})`).join('; ');
  const parts = [];
  if (missA.size) parts.push(`not live at +2h: ${list(missA)}`);
  if (missB.size) parts.push(`late-night reviews not live within ${g.lateLiveWithinMin} min: ${list(missB)}`);
  if (parts.length) return { status: 'fail', detail: parts.join(' | '), items };
  if (staleSnapshot) return { status: 'unknown', detail: `the review-file snapshot was taken ${hhmm(toMs(fsnap.capturedAt))}, before embargo +${g.sameNightEndH}h plus ${g.lateLiveWithinMin} min, so reviews first seen later that night cannot be checked (the late checkout failed, or the capture ran early)`, items };
  if (!censusKnown) return { status: 'unknown', detail: 'review files all live in time, but no census at +2h to check the aggregator listings against', items };
  if (unknownB.length) return { status: 'unknown', detail: `late-night review(s) not yet live and the probe did not run ${g.lateLiveWithinMin} min past first seen: ${unknownB.join(', ')}`, items };
  const excl = ref2.excluded && ref2.excluded.length ? `; excluded from the census: ${ref2.excluded.map((x) => `${x.outletId} (${x.reason})`).join(', ')}` : '';
  return { status: 'pass', detail: `every listed outlet and every includable review file first seen by +${g.sameNightEndH}h was live on time${excl}`, items };
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
 *   same-night-completeness  every listed + includable review live by +2h, late-night ones within 30 min, outlets named
 *   stability     no review dropped after going live
 *   coverage-end  coverage when the probe ended (informational, +6h, not +24h)
 * Anything that cannot be established is 'unknown', never 'pass'.
 */
function evaluateCheck(rec, opts = {}) {
  const result = gradeNight(rec, { ...DEFAULT_GATES, ...opts });
  const rel = rec ? observedRelease(rec) : null;
  if (!rel) return result;
  const observed = gradeNight(observedRecord(rec, rel), { ...DEFAULT_GATES, ...opts });
  return { ...result, release: { ...rel, verdictUses: 'assumed', observed } };
}

function gradeNight(rec, g) {
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
      `${ref2.covered}/${ref2.count} census outlets live at +2h = ${ref2.coverage} (bar ${g.coverage2h}; census ${(ref2.source || []).join('+') || '?'}${ref2.method === 'timeline' ? `, fetched ${ref2.fetchedAt}, judged on the live timeline` : ''}${ref2.derivedFrom ? `, re-derived from ${ref2.derivedFrom}` : ''})${ref2.missing.length ? `; missing: ${ref2.missing.join(', ')}` : ''}${ref2.discoveredAfter && ref2.discoveredAfter.length ? `; first found by the lane after +2h: ${ref2.discoveredAfter.join(', ')}` : ''}`));
  }

  // same-night-completeness (BRO-6070)
  const sn = sameNightCheck(rec, g);
  gates.push(gate('same-night-completeness', sn.status, sn.detail));

  // stability
  if (okSamples === 0) {
    gates.push(gate('stability', 'unknown', 'no successful probe samples'));
  } else {
    // A drop of a review the rebuild correctly excludes (a syndicated copy that went live first, a wrong-production
    // file) is the exclusion working, not instability (BRO-6070). Only with the file snapshot to prove it.
    const excl = new Set(((rec.fileState && rec.fileState.files) || []).filter((f) => !f.includable && f.outletId).map((f) => f.outletId));
    const isExcluded = (d) => excl.has(outletIdOf(d.outlet)) && !((rec.fileState.files).some((f) => f.includable && f.outletId === outletIdOf(d.outlet)));
    const open = rec.dropped.filter((d) => !d.restoredAt);
    const excused = open.filter(isExcluded);
    const stuck = open.filter((d) => !isExcluded(d));
    const flapped = rec.dropped.length - open.length;
    const note = excused.length ? ` (${excused.length} drop(s) of excluded review(s) not counted: ${excused.map((d) => d.outlet).join(', ')})` : '';
    if (stuck.length) gates.push(gate('stability', 'fail', `${stuck.length} review(s) dropped after going live and not restored: ${stuck.map((d) => d.outlet).join(', ')}${note}`));
    else gates.push(gate('stability', 'pass', (flapped ? `${flapped} drop(s), all restored` : (excused.length ? 'no counted drops' : 'no review dropped after going live')) + note));
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

/**
 * BRO-6614: the release looked later than the embargo the night was graded against. Only for an embargo
 * that was assumed (the market default; legacy records without embargoSource count as assumed), never an
 * override or an operator's explicit time, and only when the lane shadow was already polling before the
 * assumed embargo (a shadow started late finds reviews late without the release being late). The observed
 * release is the earlier of the lane's first discovery and the first night review seen live. A legacy record
 * from an operator's explicit --embargo-at also counts as assumed (it carries no embargoSource).
 * Returns {assumedAt, observedAt, lateMin, observedFrom: 'lane-discovery'|'first-live'|'outlet-publish'} or null.
 */
function observedRelease(rec) {
  if (!rec || rec.embargoSource === 'override' || rec.embargoSource === 'manual') return null;
  // BRO-6652: on a night the lane published, its first discovery is the thing being graded, so it cannot
  // also set the release. Only an outlet's own clock-time publish date can (first live only lowers it); with
  // none the assumed embargo stands.
  // A night nobody could tell gets the same rule: the lane may have been the one publishing.
  if (publishPath(rec) !== 'regular') return observedReleaseFromPublish(rec);
  const ls = rec.laneShadow;
  const embMs = toMs(rec.embargoAt);
  const discMs = ls ? toMs(ls.firstDiscoveredAt) : null;
  const startMs = ls ? toMs(ls.startedAt) : null;
  if (embMs == null || discMs == null || startMs == null || startMs > embMs) return null;
  // A review the probe (or the shadow) saw live before the lane's first discovery was released by then:
  // the lane found it late, the release was not late.
  const live = firstNightLive(rec);
  const liveMs = live ? toMs(live.at) : null;
  const relMs = liveMs != null && liveMs < discMs ? liveMs : discMs;
  if (relMs - embMs <= LATE_RELEASE_MIN * MIN) return null;
  return {
    assumedAt: new Date(embMs).toISOString(), observedAt: new Date(relMs).toISOString(), lateMin: Math.round((relMs - embMs) / MIN),
    observedFrom: relMs === discMs ? 'lane-discovery' : 'first-live',
  };
}

function observedReleaseFromPublish(rec) {
  const embMs = toMs(rec.embargoAt);
  const pub = firstOutletPublish(rec);
  const pubMs = pub.precision === 'exact' ? toMs(pub.at) : null;
  if (embMs == null || pubMs == null) return null;
  const live = firstNightLive(rec);
  const liveMs = live ? toMs(live.at) : null;
  const relMs = liveMs != null && liveMs < pubMs ? liveMs : pubMs;
  if (relMs - embMs <= LATE_RELEASE_MIN * MIN) return null;
  return {
    assumedAt: new Date(embMs).toISOString(), observedAt: new Date(relMs).toISOString(), lateMin: Math.round((relMs - embMs) / MIN),
    observedFrom: relMs === pubMs ? 'outlet-publish' : 'first-live',
  };
}

/** What the observed release time was taken from, for the CLI and audit-note wording. */
function releaseSourceLabel(rel) {
  if (rel.observedFrom === 'outlet-publish') return 'the first outlet publish time';
  return rel.observedFrom === 'first-live' ? 'the first night review seen live' : 'the first lane discovery';
}

/**
 * The record re-based on the observed release: embargoAt moves, and the +2h census reference is the one the
 * capture computed for that time (reference['2h-observed']), or for a record captured before BRO-6614 one
 * re-derived from the assumed +2h census (observedCoverage2h). Census exclusions stay as computed for the
 * assumed embargo.
 */
function observedRecord(rec, rel) {
  const obsMs = toMs(rel.observedAt);
  const reference = { ...(rec.reference || {}) };
  const stored = reference['2h-observed'];
  const ref2 = stored && toMs(stored.asOf) === obsMs + 2 * HOUR ? stored : observedCoverage2h(rec, obsMs);
  delete reference['2h-observed'];
  // An assumed +2h with no census (no-census-yet) stays, so the gate says why; otherwise one that cannot be
  // re-based is dropped and the gate reports the +2h as not captured.
  if (ref2) reference['2h'] = ref2;
  else if (!(reference['2h'] && reference['2h'].coverage == null)) delete reference['2h'];
  return { ...rec, embargoAt: rel.observedAt, embargoSource: 'observed', reference };
}

/**
 * +2h coverage at the observed release, from the assumed +2h census reference (records captured before
 * reference['2h-observed'] existed). Outlets covered at the assumed +2h stay covered at the later mark
 * unless a drop is open then (null: cannot tell). The rest (missing, deferred to the late rule) are
 * re-judged by coverageAt itself, so the live rules are the same.
 */
function observedCoverage2h(rec, obsMs) {
  const ref2 = rec.reference && rec.reference['2h'];
  if (!ref2 || ref2.coverage == null || !Array.isArray(ref2.missing)) return null;
  const asOfMs = obsMs + 2 * HOUR;
  if (toMs(ref2.asOf || ref2.fetchedAt) == null || toMs(ref2.asOf || ref2.fetchedAt) > asOfMs) return null;
  const openDrop = (rec.dropped || []).some((d) => toMs(d.droppedAt) <= asOfMs && (!d.restoredAt || toMs(d.restoredAt) > asOfMs));
  if (openDrop) return null;
  const ids = [...new Set([...ref2.missing, ...(ref2.suppressedMissing || []), ...(ref2.deferredToLateRule || [])])];
  const base = { ...ref2, asOf: new Date(asOfMs).toISOString(), method: 'timeline', derivedFrom: `the +2h census as of ${ref2.asOf || ref2.fetchedAt}` };
  if (!ids.length) return base;
  const census = { hadAnySource: true, sourcesPresent: ref2.source, count: ids.length, entries: ids.map((outletId) => ({ outletId })) };
  const sub = coverageAt({ ...rec, embargoAt: new Date(obsMs).toISOString() }, census, asOfMs, { deferLateSeen: true });
  const count = ref2.covered + sub.count;
  const covered = ref2.covered + (sub.covered || 0);
  return {
    ...base,
    status: sub.missing.length ? 'incomplete' : 'complete',
    count,
    covered,
    coverage: count ? Math.round((covered / count) * 1000) / 1000 : null,
    missing: sub.missing,
    suppressedMissing: [],
    discoveredAfter: sub.discoveredAfter,
    ...(sub.deferredToLateRule ? { deferredToLateRule: sub.deferredToLateRule } : { deferredToLateRule: undefined }),
  };
}

module.exports = {
  SCHEMA_VERSION, OFFSET_HOURS, DEFAULT_GATES, EMBARGO_HOUR_LOCAL, PROBE_LEAD_MIN, LATE_RELEASE_MIN,
  defaultEmbargoAt, marketEmbargoAt, embargoInfo, embargoOverrideProblem, embargoOverrideReachWarning, classifyEmbargo,
  observedRelease, releaseSourceLabel, observedRecord, observedCoverage2h, probeDue, recordPath, emptyRecord, reviewKey, applySample, firstOutletPublish,
  runProbe, referenceFrom, evaluateCheck, isNightReview, firstNightLive, laneShadowFrom, coverageAt,
  filterCensus, sameNightCheck, outletLiveMs,
  publishPath, stampPublishedBy, addManualAction, nightManualActions,
};
