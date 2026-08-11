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
 */
'use strict';

const { recordBbCall } = require('./provider-telemetry');

const SESSIONS_URL = 'https://api.browserbase.com/v1/sessions';

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

module.exports = { createBbSession, SESSIONS_URL, sanitizeMetadataValue };
