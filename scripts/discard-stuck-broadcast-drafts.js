#!/usr/bin/env node
/**
 * Delete an opening-night Resend draft that will never be sent, WITHOUT
 * sending it, and mark its tracker records discarded (BRO-2935).
 *
 * Owner decision 2026-10-11: drafts nobody sent get deleted rather than left
 * sitting in Resend looking pending. This script never calls a send endpoint
 * (CLAUDE.md §17). It only deletes, and only after proving the draft unsent
 * the same two ways --recreate-draft does (scripts/lib/recreate-draft-guard.js):
 *   1. no tracker record of the draft says sent, and every show a combo draft
 *      covers is named on the command line (deleting it drops all of them);
 *   2. a live Resend GET reports the broadcast still in draft. A 404 or any
 *      other status refuses: Resend also 404s a broadcast it reaped after a send.
 * Resend itself only deletes broadcasts that have not gone out.
 *
 * Records are kept, stamped discardedAt (broadcast-state.js markDraftDiscarded),
 * so nothing re-queues, re-polls or re-reports the show as missed.
 *
 * --no-draft (BRO-3087): for a show with NO draft to delete (never drafted,
 * or its draft 404s), record "won't send" without touching Resend, so the
 * missed-broadcast page stops. Refused while a draft is waiting (use the
 * default mode, which deletes it) or the show was sent. lib/broadcast-dismiss.js.
 *
 * Usage:
 *   node scripts/discard-stuck-broadcast-drafts.js --show=a,b            # dry run (default)
 *   node scripts/discard-stuck-broadcast-drafts.js --show=a,b --execute  # delete + record
 *   node scripts/discard-stuck-broadcast-drafts.js --show=a --no-draft [--execute]
 *
 * Runs in CI via discard-broadcast-draft.yml (RESEND_API_KEY + core data).
 * Exit 0 on success or a clean dry run, 1 on any refusal or failed delete.
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');

const { markDraftDiscarded } = require('./lib/broadcast-state');
const { collectRecreateDraftIds, recreateDraftBlockReason } = require('./lib/recreate-draft-guard');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const NO_DRAFT = args.includes('--no-draft');
const showArg = (args.find((a) => a.startsWith('--show=')) || '').slice('--show='.length);
const SHOW_IDS = [...new Set(showArg.split(',').map((s) => s.trim()).filter(Boolean))];
const REASON = (args.find((a) => a.startsWith('--reason=')) || '').slice('--reason='.length)
  || 'owner decision: unsent draft deleted, not sent';

const SENT_PATH = path.join(process.cwd(), 'data', 'opening-night-sent.json');

function refuse(why) {
  console.error(`REFUSED: ${why}`);
  console.error('Nothing was deleted by this refusal.');
  process.exit(1);
}

// --no-draft: nothing in Resend to delete, so no delete call. A record the
// tracker still shows as a waiting draft is accepted only when a live GET
// (needs RESEND_API_KEY) says Resend 404s it: the sweep relabels those
// 'draft-unknown' and tells the owner to use this mode.
async function dismissWithoutDraft(raw, shows) {
  const { dismissBlockReason, planNoDraftDismissal, recordKeysForShow } = require('./lib/broadcast-dismiss');
  const { classifyBroadcastState } = require('./lib/missed-broadcasts');
  const showsJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'shows.json'), 'utf8'));
  const openingDates = new Map((showsJson.shows || []).map((sh) => [sh.id, sh.openingDate || null]));
  const today = new Date().toISOString().slice(0, 10);

  const goneDraftIds = new Set();
  const waiting = new Set();
  for (const id of SHOW_IDS) {
    for (const key of recordKeysForShow(shows, id)) {
      const rec = shows[key];
      if (rec && !rec.discardedAt && rec.draftId && classifyBroadcastState(rec) === 'draft-stuck') waiting.add(rec.draftId);
    }
  }
  if (waiting.size && process.env.RESEND_API_KEY) {
    const { getBroadcastWithRetry } = require('./reconcile-broadcast-state');
    for (const draftId of waiting) {
      const live = await getBroadcastWithRetry(draftId);
      // parseBroadcastResponse maps a 404 to { ok: true, data: { status: 'deleted' } }.
      const status = live.ok ? live.data && live.data.status : `error ${live.statusCode || '?'}`;
      console.log(`  ${draftId}: live status ${status}`);
      if (status === 'deleted') goneDraftIds.add(draftId);
    }
  }

  const why = dismissBlockReason(shows, SHOW_IDS, { openingDates, today, goneDraftIds });
  if (why) refuse(why);
  const writes = planNoDraftDismissal(shows, SHOW_IDS, { nowIso: new Date().toISOString(), reason: REASON, goneDraftIds });
  console.log(`Shows: ${SHOW_IDS.join(', ')} (no draft to delete)`);
  if (!Object.keys(writes).length) {
    console.log('Already recorded as "will not send". Nothing to change.');
    return;
  }
  console.log(`Tracker keys to mark discarded: ${Object.keys(writes).join(', ')}`);
  if (!EXECUTE) {
    console.log('\n[DRY RUN] Would record these shows as "will not send". Re-run with --execute.');
    return;
  }
  Object.assign(shows, writes);
  raw.shows = shows;
  fs.writeFileSync(SENT_PATH, JSON.stringify(raw, null, 2) + '\n');
  console.log(`Marked discarded: ${Object.keys(writes).join(', ')}`);
  const { syncTrackerToOrigin } = require('./lib/opening-night-tracker-sync');
  syncTrackerToOrigin({ shows: writes });
}

async function main() {
  if (!SHOW_IDS.length) refuse('pass --show=<id>[,<id>...]');
  if (!fs.existsSync(SENT_PATH)) refuse(`${SENT_PATH} not found`);
  const raw = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
  const shows = raw.shows || {};

  if (NO_DRAFT) return await dismissWithoutDraft(raw, shows);

  const hasKey = Boolean(process.env.RESEND_API_KEY);
  if (EXECUTE && !hasKey) refuse('RESEND_API_KEY not set');

  const unknown = SHOW_IDS.filter((id) => !shows[id] && !Object.keys(shows).some((k) => k.endsWith(`:${id}`)));
  if (unknown.length) refuse(`no tracker record for ${unknown.join(', ')}`);

  const { keys, draftIds, blockReason } = collectRecreateDraftIds(shows, '', SHOW_IDS);
  if (blockReason) refuse(blockReason);
  if (!draftIds.length) refuse('no undiscarded draft found for those shows');

  console.log(`Shows: ${SHOW_IDS.join(', ')}`);
  console.log(`Drafts: ${draftIds.join(', ')}`);
  console.log(`Tracker keys: ${keys.join(', ')}`);

  // Every live check runs before any delete, so one bad draft refuses the batch.
  if (hasKey) {
    const { getBroadcastWithRetry } = require('./reconcile-broadcast-state');
    for (const id of draftIds) {
      const live = await getBroadcastWithRetry(id);
      const why = recreateDraftBlockReason(live);
      if (why) refuse(`draft ${id}: ${why}`);
      // Stricter than --recreate-draft (which also takes 'cancelled'): only a
      // plain draft is discarded here.
      if (live.data.status !== 'draft') refuse(`draft ${id}: live status ${live.data.status}, not draft`);
      console.log(`  ${id}: live status ${live.data.status} (unsent)`);
    }
  } else {
    console.log('  (no RESEND_API_KEY: live status not checked)');
  }

  if (!EXECUTE) {
    console.log(`\n[DRY RUN] Would delete ${draftIds.length} draft(s) and mark ${keys.length} record(s) discarded. Re-run with --execute.`);
    return;
  }

  const { deleteBroadcast } = require('./reconcile-broadcast-state');
  const nowIso = new Date().toISOString();
  const touched = {};
  let failure = null;
  for (const id of draftIds) {
    const res = await deleteBroadcast(id);
    if (!(res.statusCode >= 200 && res.statusCode < 300)) {
      failure = `could not delete draft ${id} (${res.statusCode}: ${String(res.body).slice(0, 120)})`;
      break;
    }
    console.log(`  ${id}: deleted from Resend (not sent)`);
    for (const key of keys) {
      if (shows[key] && shows[key].draftId === id) {
        shows[key] = markDraftDiscarded(shows[key], { nowIso, reason: REASON });
        touched[key] = shows[key];
      }
    }
  }

  if (!failure) {
    // Records of these shows with no draftId (no Resend draft to delete) are
    // stamped too, and a show tracked only under a market: key gets a per-show
    // mirror, since the send filter reads the per-show record first.
    for (const key of keys) {
      if (shows[key] && !shows[key].draftId && !shows[key].discardedAt) {
        shows[key] = markDraftDiscarded(shows[key], { nowIso, reason: REASON });
        touched[key] = shows[key];
      }
    }
    for (const id of SHOW_IDS) {
      if (shows[id]) continue;
      const src = keys.find((k) => touched[k] && k.endsWith(`:${id}`));
      if (src) {
        shows[id] = { ...touched[src], broadcastKey: src };
        touched[id] = shows[id];
      }
    }
  }

  // Record whatever was deleted even when a later delete failed, so a rerun
  // does not GET a 404 for those and refuse forever.
  if (Object.keys(touched).length) {
    raw.shows = shows;
    fs.writeFileSync(SENT_PATH, JSON.stringify(raw, null, 2) + '\n');
    console.log(`Marked discarded: ${Object.keys(touched).join(', ')}`);
    // No-op under GITHUB_ACTIONS (the workflow's push-core-data step persists it).
    const { syncTrackerToOrigin } = require('./lib/opening-night-tracker-sync');
    syncTrackerToOrigin({ shows: touched });
  }
  if (failure) {
    console.error(`FAILED: ${failure}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
