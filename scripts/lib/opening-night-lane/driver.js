'use strict';
/**
 * Production driver for the opening-night lane (BRO-4831): the one place that turns the lane on for a real night.
 *
 *   1. arm-check: the last rehearsal on a recorded fixture (never the synthetic one, BRO-6619) must have passed,
 *      recently, on this exact lane code (rehearsal.armDecision).
 *      A refusal is a safe fallback (the regular pipeline still runs), so it goes to the owner digest, not a page.
 *   2. claim the night lease. held-by-other is the normal answer for the second of the two armed starters, so it is
 *      logged, not alerted.
 *   3. heartbeat on a timer. A definitive loss (held-by-other / expired / no-lease) stops discovery and scoring through
 *      runLaneNight's shouldStop, since publish would refuse every row anyway; a transient failure (store unreadable,
 *      push failed) is reported once and the lane keeps going until the TTL decides.
 *   4. run the night; always release the lease, even when the night throws.
 *
 * LANE_STANDDOWN (BRO-6617, standdown.js) is checked before step 1 and at every heartbeat. Set before the start, the
 * lane exits 3 without claiming. Set mid-run, the lane stops, drops its unpublished queue (already in review-texts,
 * the regular pipeline publishes it), waits for in-flight publishes, then releases the lease in the usual `finally`.
 * The owner flips it on purpose, so neither case pages.
 *
 * Exit codes: 0 done, 1 failure, 3 not armed / lease held elsewhere / stood down, 4 finished with scored reviews
 * unpublished or the lease lost. Nothing schedules this yet; see scripts/opening-night-lane.js.
 */
const fs = require('fs');
const path = require('path');
const { beginPressNightSpend } = require('../spend-purpose');

const HEARTBEAT_MS = 10 * 60 * 1000;
const LEASE_TTL_MS = 30 * 60 * 1000;
const LEASE_LOST_REASONS = new Set(['held-by-other', 'expired', 'no-lease']);

async function runProductionLane({ show, night, holder, deps, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!show || !show.id || !night || !holder || !deps) throw new Error('driver: show, night, holder and deps are required');
  const { armCheck, claim, heartbeat, release, runNight, log = console.log } = deps;
  // An alert that fails must never take the night down with it (from inside the timer it would be an unhandled
  // rejection that kills the process before `finally` releases the lease).
  const page = async (p) => { try { await deps.page(p); } catch (e) { log(`opening-night lane: alert failed (${String(e && e.message).slice(0, 160)}): ${p.title}`); } };
  const setTimer = deps.setInterval || setInterval;
  const clearTimer = deps.clearInterval || clearInterval;
  const key = (what) => `opening-night-lane-${what}:${show.id}:${night}`;
  // A failed read never stands the lane down: readStanddownLive already falls back to the job-start value.
  // A degraded read (no token, 403, timeout) is logged once so a switch the lane cannot see is visible in the run log.
  let warnedFallback = false;
  const checkStanddown = async () => {
    if (typeof deps.standdown !== 'function') return null;
    try {
      const s = await deps.standdown();
      if (s && s.source === 'env-fallback' && !warnedFallback) {
        warnedFallback = true;
        log(`opening-night lane: cannot read LANE_STANDDOWN live (${s.detail || 'unknown'}); using the job-start value "${s.value}", so a change made during this run will not be seen`);
      }
      return s && s.standDown ? s : null;
    } catch (e) { log(`opening-night lane: stand-down check failed (${String(e && e.message).slice(0, 160)}); carrying on`); return null; }
  };

  const before = await checkStanddown();
  if (before) {
    log(`opening-night lane: LANE_STANDDOWN=${before.value} (${before.source}) stands ${show.id} down; not claiming`);
    return { exit: 3, reason: `stood-down:${before.value}` };
  }

  const decision = await armCheck();
  if (!decision || !decision.arm) {
    const reason = (decision && decision.reason) || 'unknown';
    await page({ conditionKey: key('arm-refused'), title: `Opening-night lane not armed for ${show.id} (${reason})`, description: `The lane refused to arm for ${show.id} on ${night}: ${reason}. The regular pipeline still covers the night. ${['no-recorded-rehearsal', 'no-rehearsal-record'].includes(reason) ? 'Only a rehearsal on a fixture recorded from a real opening arms the lane (BRO-6619); none has passed on this code, and rerunning the synthetic one cannot fix that.' : 'Rehearse with scripts/opening-night-lane-rehearse.js --rehearse.'}` });
    return { exit: 3, reason: `not-armed:${reason}` };
  }

  const claimed = await claim();
  if (!claimed || !claimed.ok) {
    const reason = (claimed && claimed.reason) || 'unknown';
    if (reason === 'held-by-other') { log(`opening-night lane: ${show.id} ${night} is held by ${claimed.holder}; standing down`); return { exit: 3, reason }; }
    await page({ conditionKey: key('claim-failed'), title: `Opening-night lane could not claim ${show.id} (${reason})`, description: `Lease claim for ${show.id} on ${night} failed: ${reason} ${String((claimed && claimed.detail) || '').slice(0, 200)}. The regular pipeline still covers the night.` });
    return { exit: 1, reason: `claim-failed:${reason}` };
  }

  let leaseLost = null;
  let stoodDown = null;
  let transientReported = false;
  let beat = null; // the heartbeat in progress; awaited before release so a late renew cannot read as a lost lease
  const timer = setTimer(() => {
    if (beat) return; // a slow store or variable read must not overlap the next tick
    beat = onHeartbeat().catch((e) => log(`opening-night lane: heartbeat handler failed: ${String(e && e.message).slice(0, 160)}`)).finally(() => { beat = null; });
  }, heartbeatMs);
  async function onHeartbeat() {
    // Keep renewing after a stand-down: the lease is released once, in `finally`, after in-flight publishes drain.
    if (!stoodDown && !leaseLost) {
      const s = await checkStanddown();
      if (s) {
        stoodDown = s.value;
        log(`opening-night lane: LANE_STANDDOWN=${s.value} (${s.source}) stands ${show.id} down mid-run; finishing in-flight publishes, then releasing the lease`);
      }
    }
    let hb;
    try { hb = await heartbeat(); } catch (e) { hb = { ok: false, reason: 'heartbeat-threw', detail: String(e && e.message) }; }
    if (hb && hb.ok) return;
    const reason = (hb && hb.reason) || 'unknown';
    if (LEASE_LOST_REASONS.has(reason)) {
      if (leaseLost) return;
      leaseLost = reason;
      await page({ conditionKey: key('lease-lost'), title: `Opening-night lane lost the lease for ${show.id} (${reason})`, description: `Heartbeat for ${show.id} on ${night} returned ${reason}; the lane stopped discovering and is flushing what it already scored.` });
    } else if (!transientReported) {
      transientReported = true;
      await page({ conditionKey: key('heartbeat-failing'), title: `Opening-night lane heartbeat failing for ${show.id} (${reason})`, description: `Heartbeat for ${show.id} on ${night} failed (${reason}); the lane keeps going and the lease expires in 30 minutes if this persists.` });
    }
  }

  let result;
  const restoreSpend = beginPressNightSpend(show);
  try {
    result = await runNight({ shouldStop: () => leaseLost !== null || stoodDown !== null, abandonPending: () => stoodDown !== null });
  } catch (e) {
    await page({ conditionKey: key('crashed'), title: `Opening-night lane crashed for ${show.id}`, description: String((e && e.message) || e).slice(0, 400) });
    return { exit: 1, reason: 'run-threw' };
  } finally {
    restoreSpend();
    clearTimer(timer);
    if (beat) await beat;
    try { await release(); } catch (e) { log(`opening-night lane: release failed (${String(e && e.message).slice(0, 160)}); the lease expires by TTL`); }
  }

  const unpublished = result.unpublished || [];
  const failed = result.failed || [];
  const errors = result.errors || [];
  // A lost lease outranks the stand-down: exit 4 and its summary page still apply.
  if (stoodDown !== null && !leaseLost) {
    log(`opening-night lane: stood down for ${show.id}; ${unpublished.length} scored reviews left to the regular pipeline`);
    if (failed.length || errors.length) {
      await page({ conditionKey: key('summary'), title: `Opening-night lane for ${show.id} (stood down): ${failed.length} failed, ${errors.length} errors`,
        description: [...failed.slice(0, 5).map((f) => `failed: ${f.key} (${f.reason})`), ...errors.slice(0, 5).map((e) => `error: ${e.adapter}: ${e.error}`)].join('\n') });
    }
    return { exit: 3, reason: `stood-down-mid-run:${stoodDown}`, result };
  }
  if (unpublished.length || failed.length || errors.length || leaseLost) {
    await page({ conditionKey: key('summary'), title: `Opening-night lane for ${show.id}: ${unpublished.length} unpublished, ${failed.length} failed, ${errors.length} errors`,
      description: [`passes ${result.passes}, admitted ${(result.admitted || []).length}${leaseLost ? `, lease lost (${leaseLost})` : ''}`,
        ...unpublished.slice(0, 5).map((k) => `unpublished: ${k}`), ...failed.slice(0, 5).map((f) => `failed: ${f.key} (${f.reason})`),
        ...errors.slice(0, 5).map((e) => `error: ${e.adapter}: ${e.error}`)].join('\n') });
  }
  return { exit: unpublished.length || leaseLost ? 4 : 0, reason: leaseLost ? `lease-lost:${leaseLost}` : 'done', result };
}

/** URLs this show already has in reviews.json, so the lane does not fetch and score them again. */
function onDiskUrlsFor(reviewsFile, showId) {
  try { return JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews.filter((r) => r && r.showId === showId && r.url).map((r) => r.url); } catch { return []; }
}

/** {criticName, outletId} of this show's rows in reviews.json, so the lane's syndication check sees published primaries. */
function onDiskRowsFor(reviewsFile, showId) {
  try { return JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews.filter((r) => r && r.showId === showId).map((r) => ({ criticName: r.criticName, outletId: r.outletId })); } catch { return []; }
}

/** Show Score's same-title guards need the curated URL map and every show; without them the adapter refuses to run. */
function showScoreGuards(repoDir) {
  const ss = require('../show-score-discover');
  let allShows = [];
  try { allShows = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'shows.json'), 'utf8')); allShows = Array.isArray(allShows) ? allShows : allShows.shows || []; } catch { /* guards stay off: the adapter refuses */ }
  return { urlMap: ss.loadShowScoreUrlMap(repoDir), allShows };
}

/** Site-restricted web search through the shared SERP chain (Bright Data, then ScrapingBee). Required lazily: it is only used after +3h. */
function realSerpSearch(env) {
  return async (query) => {
    // serpQuery returns nothing when no key is set; that must read as a failure, not as "no results".
    if (!env.BRIGHTDATA_TOKEN && !env.SCRAPINGBEE_API_KEY) throw new Error('SERP: no BRIGHTDATA_TOKEN or SCRAPINGBEE_API_KEY');
    const { serpQuery } = require('../url-discovery');
    return (await serpQuery(query, { nbResults: 10, emptyAuthoritative: false, brightDataKey: env.BRIGHTDATA_TOKEN, scrapingBeeKey: env.SCRAPINGBEE_API_KEY, log: () => {} })) || [];
  };
}

/** BRO-6651: the discovery page recorder when LANE_RECORD_DIR is set and a key exists (otherwise null: nothing is recorded). */
function recorderFromEnv(env) {
  if (!env.LANE_RECORD_DIR) return null;
  const rec = require('./fetch-recording');
  const r = rec.createFetchRecorder({ dir: env.LANE_RECORD_DIR, key: rec.keyFromEnv(env), dateOf: require('./discovery').extractPublishDate });
  if (!r.enabled) console.error('lane recording: LANE_RECORD_DIR set but no LANE_RECORDING_KEY / REVIEW_TEXTS_TOKEN, so nothing is recorded (pages are copyrighted and the repo is public)');
  return r;
}

/**
 * Real dependencies. Checks the scorer keys before anything claims a lease. `routeAlert` and `ScorerClass`
 * (EnsembleReviewScorer, TypeScript, hence `npx tsx`) are passed in by the CLI rather than required here: anything this
 * folder requires joins rehearsal.laneCodeHash, and the alert router alone would pull ~44 Linear/notify files into it,
 * so an unrelated edit there would silently disarm the lane until the next rehearsal.
 */
function buildRealLaneDeps({
  show, night, openingDate, timeZone, holder, repoDir, coreDir, ledgerDir, recordFile, maxAgeMs, adaptersConfig = {}, env = process.env,
  routeAlert, ScorerClass,
}) {
  const missing = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`driver: missing scorer keys ${missing.join(', ')}`);
  if (typeof routeAlert !== 'function' || typeof ScorerClass !== 'function') throw new Error('driver: routeAlert and ScorerClass are required');
  const rehearsal = require('./rehearsal');
  const store = require('./lease-store');
  const storeOpts = { repoDir };
  const leaseArgs = { show: show.id, night, holder };
  return {
    armCheck: () => rehearsal.armDecision(rehearsal.readRehearsalRecord(recordFile), { laneHash: rehearsal.laneCodeHash(), ...(maxAgeMs ? { maxAgeMs } : {}) }),
    page: (opts) => routeAlert({ severity: 'warn', disposition: 'digest', cooldownHours: 12, ...opts }),
    claim: () => store.claim(storeOpts, { ...leaseArgs, ttlMs: LEASE_TTL_MS }),
    heartbeat: () => store.heartbeat(storeOpts, { ...leaseArgs, ttlMs: LEASE_TTL_MS }),
    release: () => store.release(storeOpts, leaseArgs),
    standdown: require('./standdown').createStanddownCheck({ show, repo: env.GITHUB_REPOSITORY, token: env.LANE_STANDDOWN_TOKEN, envValue: env.LANE_STANDDOWN }),
    runNight: ({ shouldStop, abandonPending }) => {
      const inline = require('./inline-score');
      const { createRealPublishPorts } = require('./real-ports');
      // One routed fetch for discovery and review fetch alike: Talkin' Broadway through one Browserbase session (BRO-6073).
      const laneFetch = require('./browserbase-fetch').createLaneFetch({ env });
      const scorer = new ScorerClass(env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY, env.OPENROUTER_API_KEY);
      const reviewsFile = path.join(repoDir, 'data', 'reviews.json');
      return wireLaneNight({
        show, night, openingDate, timeZone, ledgerDir, adaptersConfig, laneFetch,
        recorder: recorderFromEnv(env),
        scoreText: inline.ensembleScoreText(scorer),
        // One instance for the whole night: its push queue and pending merges must be shared by every batch.
        publishPorts: createRealPublishPorts({ show: show.id, repoDir, coreDir, holder }),
        now: Date.now, wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        reviewTextsDir: path.join(repoDir, 'data', 'review-texts'),
        onDiskUrls: onDiskUrlsFor(reviewsFile, show.id), onDiskRows: onDiskRowsFor(reviewsFile, show.id),
        showScoreGuards: showScoreGuards(repoDir),
        search: realSerpSearch(env), decodeImpl: require('../google-news-decode').decodeGoogleNewsLink,
        // A CI job caps the lane step below the 6 h default window; without this it is always killed mid-run (BRO-4835).
        windowMs: Number(env.OPENING_NIGHT_LANE_WINDOW_MIN) > 0 ? Number(env.OPENING_NIGHT_LANE_WINDOW_MIN) * 60 * 1000 : undefined,
      })({ shouldStop, abandonPending });
    },
  };
}

// runLaneNight tuning a replay may set. dryRun is deliberately not among them: a replay passes ports that answer the
// lease check, so it runs the same publish guard production does.
const TUNING_KEYS = ['passIntervalMs', 'maxPasses', 'startedAt', 'latency', 'pollMs', 'publishTimeoutMs', 'maxInflight'];

/**
 * One lane night with every port passed in (BRO-5201 S4-T2). buildRealLaneDeps passes the real ones; an offline replay
 * of a recorded night passes recorded pages, recorded scores and a virtual clock, and so runs this same wiring: the
 * adapter list, inline fetch-and-score, syndication rows and missing-outlet SERP gating. Nothing here reads env or the
 * wall clock, and there is no default for any port, so nothing real can be reached by forgetting one.
 *
 *   laneFetch {fetchPage(url, opts), close()}, recorder? (fetch-recording.js: wraps the discovery fetchText only), scoreText(text, meta), fetchPorts? {extractArticle, extractMeta}
 *   (default: the real extractors over laneFetch), publishPorts | makePublishPorts(clock) (+ forkClock), now, wait,
 *   reviewTextsDir, onDiskUrls, onDiskRows, showScoreGuards, search (SERP backend), decodeImpl (Google News; null = off),
 *   windowMs?, tuning? (TUNING_KEYS)
 * @returns {({shouldStop?, abandonPending?}) => Promise<runLaneNight result>}
 */
function wireLaneNight({
  show, night, openingDate, timeZone, ledgerDir, adaptersConfig = {}, laneFetch, recorder = null, scoreText, fetchPorts, publishPorts, makePublishPorts, forkClock,
  now, wait, reviewTextsDir, onDiskUrls, onDiskRows, showScoreGuards: guards, search, decodeImpl, windowMs, tuning = {},
} = {}) {
  const required = { show, night, ledgerDir, laneFetch, scoreText, now, wait, reviewTextsDir, onDiskUrls, onDiskRows, showScoreGuards: guards, search };
  for (const [k, v] of Object.entries(required)) if (v === undefined || v === null) throw new Error(`driver: wireLaneNight needs ${k}`);
  if (typeof laneFetch.fetchPage !== 'function' || typeof laneFetch.close !== 'function') throw new Error('driver: laneFetch needs fetchPage and close');
  if (decodeImpl === undefined) throw new Error('driver: wireLaneNight needs decodeImpl (null turns Google News decoding off)');
  if (!publishPorts && !makePublishPorts) throw new Error('driver: wireLaneNight needs publishPorts or makePublishPorts');
  const unknown = Object.keys(tuning).filter((k) => !TUNING_KEYS.includes(k));
  if (unknown.length) throw new Error(`driver: unknown tuning ${unknown.join(', ')}`);
  return ({ shouldStop, abandonPending } = {}) => {
    const { runLaneNight } = require('./lane-runner');
    const discovery = require('./discovery');
    const inline = require('./inline-score');
    const { laneAdapters } = require('./adapters');
    const scoring = inline.createInlineScoring({ show, night, ledgerDir, now, fetchPage: laneFetch.fetchPage, ...(fetchPorts || inline.realFetchPorts({ fetchPage: laneFetch.fetchPage })), scoreText });
    return Promise.resolve().then(() => runLaneNight({
      show, night, openingDate, timeZone, ledgerDir, fetchText: recorder ? recorder.wrapFetchText(discovery.fetchTextFrom(laneFetch.fetchPage)) : discovery.fetchTextFrom(laneFetch.fetchPage), shouldStop, abandonPending,
      ...(windowMs > 0 ? { windowMs } : {}),
      ...tuning,
      reviewTextsDir,
      adapters: laneAdapters({ showScoreGuards: guards, adaptersConfig, search, decodeImpl, now, ledgerDir }),
      // Outlets already captured (any seen URL resolving to them) drop out, so SERP stops searching for them.
      missingOutlets: ({ seen }) => discovery.laneMissingOutlets({ show, seen, adaptersConfig }),
      fetchReview: scoring.fetchReview, scoreReview: scoring.scoreReview,
      ...(publishPorts ? { publishPorts } : { makePublishPorts, forkClock }),
      onDiskUrls, onDiskRows, now, wait,
    })).finally(() => laneFetch.close());
  };
}

module.exports = { recorderFromEnv, HEARTBEAT_MS, LEASE_TTL_MS, TUNING_KEYS, runProductionLane, buildRealLaneDeps, wireLaneNight, onDiskUrlsFor, onDiskRowsFor };
