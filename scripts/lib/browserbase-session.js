/**
 * browserbase-session.js — the one place that creates a Browserbase session.
 *
 * Task #752: Browserbase was the most expensive provider (~$0.10/session vs
 * Bright Data's ~$0.0015) and the ONLY one with zero per-call attribution — 8
 * scripts hand-rolled the session-create POST independently. When Browserbase
 * spend rebounded on 2026-08-01, the billing API could count sessions but
 * could not say which script created them.
 *
 * Every caller migrates to createBbSession({ apiKey, projectId, caller, purpose, body }):
 *   - records one telemetry line + durable ledger row (provider-telemetry.js)
 *   - sets Browserbase's own `userMetadata: {caller, purpose}` on session create,
 *     so attribution also lives in the vendor's API and survives a lost ledger.
 *     Confirmed supported on our plan by a live create+release round-trip
 *     2026-08-02 (userMetadata echoed back in the response) — do not re-assume
 *     this away without re-checking, per the plan's "verify, don't assume" rule.
 *     Browserbase rejects userMetadata VALUES containing spaces/colons/slashes
 *     (400 "Value is not a valid metadata value") — confirmed live 2026-08-02
 *     against real `purpose` strings like "Stagedoor critic-reviews Cloudflare
 *     bypass". Values are sanitized to [A-Za-z0-9._-] before send; the free-text
 *     `purpose` still reaches the durable ledger unsanitized via provider-telemetry.js.
 *   - `body` carries per-caller session options (keepAlive, timeout,
 *     browserSettings, proxies, etc.) that vary across the 8 original call sites.
 *
 * A NEW Browserbase session-create call site outside this module fails the
 * direct-provider-call CI gate under --strict (scripts/lib/direct-provider-detector.js).
 *
 * BROWSERBASE_KILL_SWITCH is enforced HERE, not per-caller (card #114 audit,
 * 2026-08-11): only collect-review-texts.js and bww-rr-discover.js checked it
 * themselves — the other 7 call sites (opening-night-poller.js,
 * sweep-we-aggregators.js, scrape-thestage-roundups.js,
 * newspapers-com-extract.js, newspapers-browserbase-login.js,
 * scrape-stagedoor-critics.js, gather-reviews.js) could keep creating paid
 * sessions after the owner flipped the emergency stop. Checking once in the
 * shared chokepoint closes the gap for every current AND future caller.
 *
 * Card #1248 (2026-08-11): the numeric $25/day account-wide ceiling had the
 * SAME gap — only collect-review-texts.js (local usage-file counter, maxed
 * against live count) and bww-rr-discover.js (live count only) enforced it;
 * the other 7 callers could blow through it uncapped. #114 deliberately left
 * this out to keep that fix surgical (needs a live session count, not just an
 * env-var read). Enforced HERE now using the live-count check, the same
 * mechanism bww-rr-discover.js already used — the shared chokepoint doesn't
 * have a durable local counter of its own (short-lived CLI processes), so the
 * live Browserbase API count (which reflects every caller's spend already) is
 * the one source of truth available here. Per-run/per-domain caps stay
 * caller-side (scripts/lib/browserbase-caps.js) — they need per-process state
 * this chokepoint doesn't have.
 *
 * Card #1333 (2026-08-12): the flat day-cap above had the SAME opening-window
 * starvation gap #1315 fixed for Bright Data and #1330 fixed for ScrapingDog
 * — a routine bulk sweep could exhaust the day's Browserbase sessions a show
 * needs for its opening-night BWW reviews.php / paywall-login flow. Bulk
 * (non-exempt) callers now check the live count against a REDUCED ceiling
 * (raw ceiling minus reservePerShow * shows-in-window, brightdata-caps.js's
 * own effectiveCeilingForOpeningWindow, reused rather than duplicated —
 * already the pattern scrapingdog-caps.js's check-sd-breaker.js follows).
 * Exempt (opening-night) callers keep checking the RAW ceiling, unchanged
 * from before this card — unlike BD/SD's breaker, this chokepoint has no
 * separate exempt per-run budget to fall back to, so bypassing the check
 * entirely for exempt callers would remove the only real-dollar backstop on
 * Browserbase's $0.10/session cost; checking them against the raw ceiling
 * preserves that backstop while still freeing the reserved slice from the
 * bulk callers that were starving them.
 */
'use strict';

const { recordBbCall } = require('./provider-telemetry');
// Not destructured — kept as a module reference so tests can mock.method()
// the export in place (browserbase-session.test.mjs).
const browserbaseLiveUsage = require('./browserbase-live-usage');
const openingNightSelection = require('./opening-night-selection');
const path = require('path');
const { resolveMaxSessionsPerDay, resolveOpeningWindowReservePerShow, resolveExemptScripts } = require('./browserbase-caps');
const { isExemptCaller, effectiveCeilingForOpeningWindow } = require('./brightdata-caps');

const SESSIONS_URL = 'https://api.browserbase.com/v1/sessions';
const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

// Short TTL cache for the live day-cap count (#1248 ship-check finding):
// without this, every createBbSession() call hits the live-usage API, which
// defeats collect-review-texts.js's own deliberate "only re-check live count
// every 5th session, to bound API calls" cadence (scripts/collect-review-texts.js
// ~line 2109) — a big collection run would 5x its live-usage API traffic.
// 15s keeps the check genuinely "live" (a burst can admit at most a handful
// of extra sessions during the window, negligible against the $25/day
// ceiling's own headroom) while collapsing rapid-fire creates to one fetch.
const DAY_CAP_CACHE_TTL_MS = 15000;
let _dayCapCache = { key: null, count: null, ts: 0 };

async function getCachedLiveSessionsToday(apiKey, projectId) {
  const key = `${apiKey}:${projectId}`;
  const now = Date.now();
  if (_dayCapCache.key === key && now - _dayCapCache.ts < DAY_CAP_CACHE_TTL_MS) {
    return _dayCapCache.count;
  }
  const count = await browserbaseLiveUsage.fetchLiveBrowserbaseSessionsToday(apiKey, projectId);
  _dayCapCache = { key, count, ts: now };
  return count;
}

// Opening-window show count changes on the order of minutes, not seconds —
// a much longer TTL than the live-session cache above, since this reads and
// parses the full shows.json (2,800+ shows) off disk rather than hitting an
// API. Without this cache a big collection run (potentially hundreds of
// createBbSession calls) would re-read and re-parse shows.json every call.
const OPENING_WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;
let _openingWindowCache = { count: null, ts: 0 };

function getCachedOpeningWindowShows() {
  const now = Date.now();
  if (_openingWindowCache.count !== null && now - _openingWindowCache.ts < OPENING_WINDOW_CACHE_TTL_MS) {
    return _openingWindowCache.count;
  }
  const count = openingNightSelection.countShowsInOpeningWindow(SHOWS_PATH, { lookbackDays: 1, lookAheadHours: 72 });
  _openingWindowCache = { count, ts: now };
  return count;
}

// Browserbase 400s on userMetadata values containing anything outside this
// set (spaces, colons, slashes all rejected — confirmed live 2026-08-02).
function sanitizeMetadataValue(value) {
  if (value == null) return value;
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255) || null;
}

/**
 * Create a Browserbase session, recording attribution telemetry + ledger row.
 * @param {Object} opts
 * @param {string} [opts.apiKey] - defaults to process.env.BROWSERBASE_API_KEY
 * @param {string} [opts.projectId] - defaults to process.env.BROWSERBASE_PROJECT_ID
 * @param {string} opts.caller - short label for who's asking (e.g. 'gather-reviews:talkin-broadway')
 * @param {string} [opts.purpose] - free-text reason, surfaced in userMetadata for vendor-side lookup
 * @param {Object} [opts.body] - extra session-create fields merged in (keepAlive, timeout, browserSettings, proxies, ...)
 * @returns {Promise<{id: string, connectUrl: string, raw: Object}>}
 */
async function createBbSession(opts) {
  if (process.env.BROWSERBASE_KILL_SWITCH === 'true') {
    throw new Error('Browserbase kill switch active (BROWSERBASE_KILL_SWITCH=true)');
  }
  const apiKey = opts.apiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = opts.projectId || process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('createBbSession: BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set');
  }
  if (!opts.caller) {
    throw new Error('createBbSession: opts.caller is required (attribution would be lost otherwise)');
  }

  // Account-wide daily ceiling (#1248). Live count already reflects every
  // caller's spend, so no local counter is needed here. null means the API
  // call itself failed — treat as unknown, not zero, same as every other
  // live-count caller in this codebase (a network hiccup must not look like
  // a clean budget).
  const maxPerDay = resolveMaxSessionsPerDay();

  // Opening-window reserve (#1333). Bulk (non-exempt) callers get checked
  // against a ceiling reduced by reservePerShow * shows-in-window, so a
  // routine sweep stops before it can eat into the slice an opening-window
  // show needs. Exempt callers (opening-night scripts/workflows) keep
  // checking the RAW ceiling — see module docstring for why this chokepoint
  // doesn't bypass the check entirely for them the way BD/SD's breakers do.
  const exempt = isExemptCaller(
    process.argv[1] || null,
    resolveExemptScripts(),
    process.env.GITHUB_WORKFLOW || null,
    process.env.BD_OPENING_NIGHT || null,
  );
  const effectiveMaxPerDay = exempt
    ? maxPerDay
    : effectiveCeilingForOpeningWindow({
      ceiling: maxPerDay,
      openingWindowShows: getCachedOpeningWindowShows(),
      reservePerShow: resolveOpeningWindowReservePerShow(),
    });

  const liveSessionsToday = await getCachedLiveSessionsToday(apiKey, projectId);
  if (liveSessionsToday !== null && liveSessionsToday >= effectiveMaxPerDay) {
    recordBbCall({ caller: opts.caller, purpose: opts.purpose, success: false, status: 'day-cap-reached' });
    const reserveNote = effectiveMaxPerDay !== maxPerDay ? ` (raw ceiling ${maxPerDay}, reduced for opening-window reserve)` : '';
    throw new Error(`Browserbase daily cap reached (${liveSessionsToday}/${effectiveMaxPerDay}${reserveNote}) — session create blocked for ${opts.caller}`);
  }

  const rawUserMetadata = { ...(opts.body && opts.body.userMetadata) };
  const sanitizedUserMetadata = {};
  for (const [k, v] of Object.entries(rawUserMetadata)) {
    sanitizedUserMetadata[k] = sanitizeMetadataValue(v);
  }

  const body = {
    ...(opts.body || {}),
    projectId,
    userMetadata: {
      ...sanitizedUserMetadata,
      caller: sanitizeMetadataValue(opts.caller),
      purpose: sanitizeMetadataValue(opts.purpose),
    },
  };

  let res;
  let status = null;
  try {
    res = await fetch(SESSIONS_URL, {
      method: 'POST',
      headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status;
  } catch (err) {
    recordBbCall({ caller: opts.caller, purpose: opts.purpose, success: false, status: err.message || 'network-error' });
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    recordBbCall({ caller: opts.caller, purpose: opts.purpose, success: false, status });
    throw new Error(`Browserbase session create failed: ${status} ${text.slice(0, 200)}`);
  }

  const session = await res.json();
  if (!session || !session.id) {
    recordBbCall({ caller: opts.caller, purpose: opts.purpose, success: false, status: 'no-session-id' });
    throw new Error(`Browserbase session create returned no id: ${JSON.stringify(session).slice(0, 200)}`);
  }

  recordBbCall({ caller: opts.caller, purpose: opts.purpose, success: true, status });

  const connectUrl = session.connectUrl
    || `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${session.id}`;
  return { id: session.id, connectUrl, raw: session };
}

// Test-only escape hatch: the day-cap cache is module-level state, so tests
// that stub fetchLiveBrowserbaseSessionsToday with different return values
// back-to-back need to clear it between cases or they'll read a stale value
// cached by the previous test's mock.
function _resetDayCapCacheForTests() {
  _dayCapCache = { key: null, count: null, ts: 0 };
  _openingWindowCache = { count: null, ts: 0 };
}

module.exports = { createBbSession, SESSIONS_URL, sanitizeMetadataValue, _resetDayCapCacheForTests };
