'use strict';
/**
 * Production driver for the opening-night lane (BRO-4831): the one place that turns the lane on for a real night.
 *
 *   1. arm-check: the last rehearsal must have passed, recently, on this exact lane code (rehearsal.armDecision).
 *      A refusal is a safe fallback (the regular pipeline still runs), so it goes to the owner digest, not a page.
 *   2. claim the night lease. held-by-other is the normal answer for the second of the two armed starters, so it is
 *      logged, not alerted.
 *   3. heartbeat on a timer. A definitive loss (held-by-other / expired / no-lease) stops discovery and scoring through
 *      runLaneNight's shouldStop, since publish would refuse every row anyway; a transient failure (store unreadable,
 *      push failed) is reported once and the lane keeps going until the TTL decides.
 *   4. run the night; always release the lease, even when the night throws.
 *
 * Exit codes: 0 done, 1 failure, 3 not armed / lease held elsewhere, 4 finished with scored reviews unpublished or the
 * lease lost. Nothing schedules this yet; see scripts/opening-night-lane.js.
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

  const decision = await armCheck();
  if (!decision || !decision.arm) {
    const reason = (decision && decision.reason) || 'unknown';
    await page({ conditionKey: key('arm-refused'), title: `Opening-night lane not armed for ${show.id} (${reason})`, description: `The lane refused to arm for ${show.id} on ${night}: ${reason}. The regular pipeline still covers the night. Rehearse with scripts/opening-night-lane-rehearse.js --rehearse.` });
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
  let transientReported = false;
  const timer = setTimer(() => { onHeartbeat().catch((e) => log(`opening-night lane: heartbeat handler failed: ${String(e && e.message).slice(0, 160)}`)); }, heartbeatMs);
  async function onHeartbeat() {
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
    result = await runNight({ shouldStop: () => leaseLost !== null });
  } catch (e) {
    await page({ conditionKey: key('crashed'), title: `Opening-night lane crashed for ${show.id}`, description: String((e && e.message) || e).slice(0, 400) });
    return { exit: 1, reason: 'run-threw' };
  } finally {
    restoreSpend();
    clearTimer(timer);
    try { await release(); } catch (e) { log(`opening-night lane: release failed (${String(e && e.message).slice(0, 160)}); the lease expires by TTL`); }
  }

  const unpublished = result.unpublished || [];
  const failed = result.failed || [];
  const errors = result.errors || [];
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
    return (await serpQuery(query, { nbResults: 10, brightDataKey: env.BRIGHTDATA_TOKEN, scrapingBeeKey: env.SCRAPINGBEE_API_KEY, log: () => {} })) || [];
  };
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
    runNight: ({ shouldStop }) => {
      const { runLaneNight } = require('./lane-runner');
      const discovery = require('./discovery');
      const inline = require('./inline-score');
      const { createRealPublishPorts } = require('./real-ports');
      const { fetchPage } = require('../scraper');
      const scorer = new ScorerClass(env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY, env.OPENROUTER_API_KEY);
      const scoring = inline.createInlineScoring({ show, night, ledgerDir, now: Date.now, ...inline.realFetchPorts(), scoreText: inline.ensembleScoreText(scorer) });
      const fetchText = discovery.fetchTextFrom(fetchPage);
      return runLaneNight({
        show, night, openingDate, timeZone, ledgerDir, fetchText, shouldStop,
        // A CI job caps the lane step below the 6 h default window; without this it is always killed mid-run (BRO-4835).
        ...(Number(process.env.OPENING_NIGHT_LANE_WINDOW_MIN) > 0 ? { windowMs: Number(process.env.OPENING_NIGHT_LANE_WINDOW_MIN) * 60 * 1000 } : {}),
        reviewTextsDir: path.join(repoDir, 'data', 'review-texts'),
        adapters: [
          discovery.bwwRoundupAdapter(), discovery.dtliAdapter(), discovery.showScoreAdapter(showScoreGuards(repoDir)), discovery.playbillVerdictAdapter(),
          discovery.talkinBroadwayAdapter(), discovery.googleNewsAdapter({ decodeImpl: require('../google-news-decode').decodeGoogleNewsLink }),
          discovery.rssAdapter({ feeds: adaptersConfig.feeds }), discovery.sectionIndexAdapter({ outlets: adaptersConfig.outlets || [] }),
          discovery.serpAdapter({ search: adaptersConfig.search || realSerpSearch(env) }),
        ],
        // Outlets already captured (any seen URL resolving to them) drop out, so SERP stops searching for them.
        missingOutlets: ({ seen }) => {
          const { resolveOutletFromUrl } = require('../review-normalization');
          const have = new Set([...seen].map((u) => (resolveOutletFromUrl(u) || {}).outletId).filter(Boolean));
          return (adaptersConfig.missingOutlets || []).filter((id) => !have.has(id));
        },
        fetchReview: scoring.fetchReview, scoreReview: scoring.scoreReview,
        // One instance for the whole night: its push queue and pending merges must be shared by every batch.
        publishPorts: createRealPublishPorts({ show: show.id, repoDir, coreDir, holder }),
        onDiskUrls: onDiskUrlsFor(path.join(repoDir, 'data', 'reviews.json'), show.id),
        onDiskRows: onDiskRowsFor(path.join(repoDir, 'data', 'reviews.json'), show.id),
        now: Date.now, wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    },
  };
}

module.exports = { HEARTBEAT_MS, LEASE_TTL_MS, runProductionLane, buildRealLaneDeps, onDiskUrlsFor, onDiskRowsFor };
