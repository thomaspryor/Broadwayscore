#!/usr/bin/env node
/**
 * Poll Resend for every draft recorded in data/opening-night-sent.json and
 * update the local record with the actual draftStatus (draft/queued/sending/
 * sent/cancelled/deleted). Writes the file back in place.
 *
 * Why: our tracker used to conflate "draft created" with "broadcast sent".
 * If Tom cancels or deletes a draft in the Resend UI, only the Resend API
 * knows. This job is the round-trip.
 *
 * Non-destructive otherwise: never creates drafts, never sends email, never
 * deletes existing entries. All writes go through
 * scripts/lib/broadcast-state.js:applyResendStatusUpdate (pure, unit-tested).
 *
 * Usage:
 *   node scripts/reconcile-broadcast-state.js                   # poll all
 *   node scripts/reconcile-broadcast-state.js --show=cats-2026  # single show
 *   node scripts/reconcile-broadcast-state.js --dry-run         # no writes
 *
 * Exit codes:
 *   0 — success (all reconcilable)
 *   1 — RESEND_API_KEY missing or fatal file error
 *   0 — individual GET failures are logged but don't fail the job
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const {
  parseResendStatus,
  migrateSentRecord,
  applyResendStatusUpdate,
} = require('./lib/broadcast-state');
const { syncTrackerToOrigin } = require('./lib/opening-night-tracker-sync');

const args = process.argv.slice(2);
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const dryRun = args.includes('--dry-run');

const REPO_ROOT = path.resolve(__dirname, '..');
const SENT_PATH = path.join(REPO_ROOT, 'data', 'opening-night-sent.json');
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function log(...m) { console.log(...m); }
function warn(...m) { console.warn(...m); }

/**
 * Pure parser for the Resend GET /broadcasts/{id} response.
 *
 * CRITICAL: 404 MUST route to `{ok: true, data: {status: 'deleted'}}` so that
 * applyResendStatusUpdate's retention-reap protection engages (see
 * scripts/lib/broadcast-state.js and memory/feedback_404_not_terminal.md).
 *
 * If a future refactor changes 404 to return null / `{ok: false}` / anything
 * else, the retention-reap protection silently stops engaging and previously-
 * sent broadcasts start getting re-queued 12h later. Test coverage lives in
 * tests/unit/reconcile-broadcast-state.test.mjs.
 */
function parseBroadcastResponse(statusCode, body) {
  if (statusCode === 200) {
    try { return { ok: true, data: JSON.parse(body) }; }
    catch (e) { return { ok: false, error: `parse:${e.message}` }; }
  }
  if (statusCode === 404) {
    return { ok: true, data: { status: 'deleted' } };
  }
  return { ok: false, statusCode, error: `HTTP ${statusCode}: ${(body || '').slice(0, 200)}` };
}

// Resend allows 10 requests/second per API key. The loop below used to fire
// one GET per tracker key back to back, and every multi-show or single-show
// draft is recorded under SEVERAL keys (the `market:id` broadcastKey plus one
// mirror per show, see recordDraftCompletion in send-opening-night-broadcast.js),
// so ~20 GETs went out in ~2s. The ~20th got HTTP 429 on both the 2026-09-29
// and 2026-09-30 runs, and it was always the same key: school-girls' per-show
// mirror stayed `draft` while its broadway: twin recorded the owner's send,
// and check-missed-broadcasts paged the owner for an email they had sent
// (BRO-4474). Pacing + one GET per draftId + a 429 retry close all three gaps.
const POLL_INTERVAL_MS = Number.isFinite(Number(process.env.RESEND_POLL_INTERVAL_MS))
  ? Number(process.env.RESEND_POLL_INTERVAL_MS)
  : 250;
const MAX_429_RETRIES = 4;
// Whole-run cap on 429 retries. Records that never reach sent+sentAt (stuck,
// cancelled, ambiguous-deleted drafts) are re-polled every run, so under a
// sustained 429 the per-draft retries alone could outlast the workflow's
// 10-minute timeout, and the file is only written at the end: a killed run
// would lose every update it had made.
const MAX_429_RETRIES_PER_RUN = 20;
let retriesUsed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff before retry `attempt` (0-based) after a 429. Honors a numeric
 * Retry-After header (seconds) when Resend sends one, capped at 10s.
 * Pure, exported for tests.
 */
function retryDelayMs(attempt, retryAfterHeader, baseMs = POLL_INTERVAL_MS) {
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return Math.min(Math.max(baseMs, 250) * 2 ** (attempt + 1), 10_000);
}

async function getBroadcastWithRetry(broadcastId) {
  let response;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    response = await getBroadcast(broadcastId);
    if (response.ok || response.statusCode !== 429) return response;
    if (attempt === MAX_429_RETRIES || retriesUsed >= MAX_429_RETRIES_PER_RUN) break;
    retriesUsed++;
    const wait = POLL_INTERVAL_MS === 0 ? 0 : retryDelayMs(attempt, response.retryAfter);
    warn(`    429 rate-limited, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`);
    await sleep(wait);
  }
  return response;
}

async function getBroadcast(broadcastId) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: `/broadcasts/${broadcastId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const parsed = parseBroadcastResponse(res.statusCode, body);
          if (!parsed.ok && res.headers) parsed.retryAfter = res.headers['retry-after'];
          resolve(parsed);
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

async function main() {
  if (!RESEND_API_KEY) {
    console.error('ERROR: RESEND_API_KEY not set');
    process.exit(1);
  }
  if (!fs.existsSync(SENT_PATH)) {
    console.error(`ERROR: ${SENT_PATH} not found`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
  const shows = raw.shows || {};

  // Migrate legacy records up-front (idempotent — noop if already migrated).
  for (const key of Object.keys(shows)) {
    shows[key] = migrateSentRecord(shows[key]);
  }

  let polled = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // Only entries this run actually re-verified against Resend go to origin —
  // NOT the full local `shows` table. A local CLI run's disk copy can be
  // stale relative to origin (it's gitignored, not refreshed by `git pull`,
  // and the hourly cron keeps writing other shows' state to origin the whole
  // time). mergeTrackerEntries does whole-key last-write-wins, so syncing the
  // full stale table would silently roll back every OTHER show's freshest
  // origin state back to this machine's old local copy — the same class of
  // state-divergence incident (2026-04-11) this sync exists to prevent, just
  // inverted. Scoping the payload to freshly-polled keys makes that
  // impossible: an untouched key is never part of the merge's local side.
  const touchedShows = {};

  const entries = Object.entries(shows);

  // One GET per draftId per run: the per-show mirrors share their
  // broadcastKey record's draftId, so polling each key separately both
  // multiplied the request count and let mirrors of ONE broadcast disagree
  // when a single GET failed. A failed GET is cached too, so the mirrors of a
  // draft Resend refused stay untouched together rather than half-updated.
  const responseByDraftId = new Map();
  let lastRequestAt = 0;

  const isShowRecordKey = (key) => !key.startsWith('preview:') && !key.startsWith('overdue-alert:');

  // A record already observed sent (sent + sentAt) is terminal and skipped
  // below, so its mirrors were polled ALONE on every later run. Once Resend
  // reaps the sent broadcast (~24h) that lone poll 404s, and a mirror whose
  // own last state was `draft` becomes deleted + completed:false, which
  // shouldRequeueShow reads as "never went out" and re-queues (BRO-4474
  // review: School Girls' per-show mirror was one 404 away from this). So a
  // sibling's observed send is applied to the mirror directly, with no GET.
  const sentRecordByDraftId = new Map();
  for (const [key, rec] of entries) {
    if (isShowRecordKey(key) && rec && rec.draftId && rec.draftStatus === 'sent' && rec.sentAt) {
      sentRecordByDraftId.set(rec.draftId, rec);
    }
  }

  // --show=X selects the matching keys AND every other key sharing their
  // draftId, so a manual correction can't update one copy of a broadcast and
  // leave its mirror behind.
  let filterDraftIds = null;
  if (showFilter) {
    filterDraftIds = new Set();
    for (const [key, rec] of entries) {
      if ((key === showFilter || key.startsWith(showFilter)) && rec && rec.draftId) filterDraftIds.add(rec.draftId);
    }
  }

  for (const [key, rec] of entries) {
    // Skip keys that aren't show-level broadcast records (previews, overdue alerts).
    if (!isShowRecordKey(key)) {
      skipped++;
      continue;
    }
    if (showFilter && !key.startsWith(showFilter) && key !== showFilter
        && !(rec && rec.draftId && filterDraftIds.has(rec.draftId))) {
      skipped++;
      continue;
    }
    if (!rec || !rec.draftId) {
      skipped++;
      continue;
    }
    // Terminal success: no need to re-poll sent broadcasts.
    if (rec.draftStatus === 'sent' && rec.sentAt) {
      skipped++;
      continue;
    }

    const sentTwin = sentRecordByDraftId.get(rec.draftId);
    let response = responseByDraftId.get(rec.draftId);
    if (sentTwin) {
      log(`  ${key}: draft ${rec.draftId.slice(0, 8)}... already observed sent on a sibling record, copying (no GET)`);
      response = {
        ok: true,
        data: {
          status: 'sent',
          sent_at: sentTwin.sentAt,
          ...(typeof sentTwin.recipientCount === 'number' ? { total_recipients: sentTwin.recipientCount } : {}),
        },
      };
    } else if (response) {
      log(`  Reusing poll for ${key} (draft ${rec.draftId.slice(0, 8)}...)`);
    } else {
      const since = Date.now() - lastRequestAt;
      if (since < POLL_INTERVAL_MS) await sleep(POLL_INTERVAL_MS - since);
      log(`  Polling ${key} (draft ${rec.draftId.slice(0, 8)}...)`);
      response = await getBroadcastWithRetry(rec.draftId);
      lastRequestAt = Date.now();
      responseByDraftId.set(rec.draftId, response);
      polled++;
    }

    if (!response.ok) {
      warn(`    ✗ ${response.error}`);
      failed++;
      continue;
    }

    const newStatus = parseResendStatus(response.data && response.data.status);
    if (newStatus !== rec.draftStatus) {
      log(`    ${rec.draftStatus || '(unset)'} → ${newStatus}`);
    }

    const updatedRec = applyResendStatusUpdate(rec, response.data);
    shows[key] = updatedRec;
    touchedShows[key] = updatedRec;
    if (updatedRec !== rec) updated++;
  }

  raw.shows = shows;

  if (!dryRun) {
    fs.writeFileSync(SENT_PATH, JSON.stringify(raw, null, 2) + '\n');
    log(`\nWrote ${path.relative(REPO_ROOT, SENT_PATH)}`);

    // Manual/CLI runs (e.g. `--show=X` corrections) write this file locally
    // with no other commit path back to origin/main — unlike the hourly cron,
    // which relies on the workflow's push-core-data step. Without this sync,
    // a local correction is invisible to CI until the next scheduled run
    // overwrites it (racily) or a human pushes the private data repo by hand.
    // No-ops under GITHUB_ACTIONS=true (the workflow's own commit step
    // handles that path) — see scripts/lib/opening-night-tracker-sync.js.
    if (Object.keys(touchedShows).length > 0) {
      syncTrackerToOrigin({ shows: touchedShows });
    } else {
      log('  (nothing freshly polled — skipping origin sync)');
    }
  } else {
    log('\n(dry-run — no file written)');
  }

  log(`Polled: ${polled}, updated: ${updated}, skipped: ${skipped}, failed: ${failed}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseBroadcastResponse, retryDelayMs, getBroadcastWithRetry, SENT_PATH };
