/**
 * The `--recreate-draft` step of send-opening-night-broadcast.js, with every
 * side effect injected so a test can run the real decision logic without
 * Resend, git or the filesystem (BRO-7580).
 *
 * Why this is its own module: the 2026-04-21 bug was a `--dry-run
 * --recreate-draft` run that DELETED a live Resend draft. The fix lived inline
 * in main(), which no test could reach without a full opening-night fixture.
 * Here the same code is one call, and tests/unit/recreate-draft-flow.test.mjs
 * pins "dry run makes zero writes" against it.
 *
 * Contract: the live-status GETs run under --dry-run (read-only, so a dispatch
 * can be rehearsed). The DELETE and the tracker write do not. Every refusal
 * returns { ok: false, reason } and the caller exits non-zero; nothing is
 * thrown for a refusal so a caller cannot half-handle it.
 */

const { collectRecreateDraftIds, recreateDraftBlockReason } = require('./recreate-draft-guard');

/**
 * @param {object} p
 * @param {object} p.sentShows       opening-night-sent.json `.shows` (read; entries are only cleared through clearEntries)
 * @param {string} p.broadcastKey    key this run would record under
 * @param {string[]} p.showIds
 * @param {string|null} p.sendTo     --send-to value (refused, see below)
 * @param {boolean} p.dryRun
 * @param {boolean} p.hasApiKey      RESEND_API_KEY present
 * @param {(id:string)=>Promise<object>} p.getBroadcast     Resend GET (read-only)
 * @param {(id:string)=>Promise<{statusCode:number, body:any}>} p.deleteBroadcast  Resend DELETE (a write)
 * @param {(keys:string[])=>void} p.clearEntries   tracker clear (a write)
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{ok:true, dryRun:boolean, keys:string[], draftIds:string[]} | {ok:false, reason:string}>}
 */
async function runRecreateDraft({
  sentShows, broadcastKey, showIds, sendTo, dryRun, hasApiKey,
  getBroadcast, deleteBroadcast, clearEntries, log = console.log,
}) {
  // A preview run would delete the draft and then only email a preview.
  if (sendTo) return { ok: false, reason: '--recreate-draft cannot be combined with --send-to' };

  const { keys, draftIds, blockReason } = collectRecreateDraftIds(sentShows, broadcastKey, showIds);
  if (blockReason) return { ok: false, reason: blockReason };

  if (draftIds.length && hasApiKey) {
    for (const id of draftIds) {
      const live = await getBroadcast(id);
      const why = recreateDraftBlockReason(live);
      if (why) return { ok: false, reason: `draft ${id}: ${why}` };
      log(`\n--recreate-draft: old draft ${id} is still unsent (status ${live.data.status})`);
    }
  } else if (draftIds.length) {
    // Only reachable under --dry-run (main() exits earlier without a key otherwise).
    log(`\n[DRY RUN] No RESEND_API_KEY: cannot check live status of ${draftIds.join(', ')}`);
  }

  if (dryRun) {
    log(`\n[DRY RUN] Would delete old draft(s) ${draftIds.join(', ') || '(none)'} and clear records: ${keys.join(', ') || '(none)'}`);
    return { ok: true, dryRun: true, keys, draftIds };
  }

  const deletedIds = new Set();
  for (const id of draftIds) {
    log(`--recreate-draft: deleting old draft ${id}...`);
    const res = await deleteBroadcast(id);
    if (!(res.statusCode >= 200 && res.statusCode < 300)) {
      // Drafts deleted earlier in this loop are gone from Resend: drop their
      // records now, or a rerun would GET a 404 for them and refuse forever.
      if (deletedIds.size) {
        clearEntries(keys.filter(key => deletedIds.has(sentShows[key]?.draftId)));
      }
      return { ok: false, reason: `could not delete old draft ${id} (${res.statusCode}: ${String(res.body).slice(0, 100)})` };
    }
    deletedIds.add(id);
    log('  Old draft deleted from Resend');
  }
  // Clear every record of the deleted draft(s) so the script treats the show as new
  clearEntries(keys);
  log(`  Sent records cleared (${keys.join(', ') || 'none'}) — creating fresh draft`);
  return { ok: true, dryRun: false, keys, draftIds };
}

module.exports = { runRecreateDraft };
