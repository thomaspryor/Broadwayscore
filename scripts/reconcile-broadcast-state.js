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
  return { ok: false, error: `HTTP ${statusCode}: ${(body || '').slice(0, 200)}` };
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
        res.on('end', () => resolve(parseBroadcastResponse(res.statusCode, body)));
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

  const entries = Object.entries(shows);

  for (const [key, rec] of entries) {
    // Skip keys that aren't show-level broadcast records (previews, overdue alerts).
    if (key.startsWith('preview:') || key.startsWith('overdue-alert:')) {
      skipped++;
      continue;
    }
    if (showFilter && !key.startsWith(showFilter) && key !== showFilter) {
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

    log(`  Polling ${key} (draft ${rec.draftId.slice(0, 8)}...)`);
    const response = await getBroadcast(rec.draftId);
    polled++;

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
    if (updatedRec !== rec) updated++;
  }

  raw.shows = shows;

  if (!dryRun) {
    fs.writeFileSync(SENT_PATH, JSON.stringify(raw, null, 2) + '\n');
    log(`\nWrote ${path.relative(REPO_ROOT, SENT_PATH)}`);
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

module.exports = { main, parseBroadcastResponse };
