#!/usr/bin/env node
'use strict';
/**
 * Night-lease CLI (BRO-4786). Used by the lane (claim/heartbeat/release) and by every competing
 * workflow (sync, enforce).
 *
 *   sync                                  fetch the shared lease state into data/opening-night/leases.json
 *   list                                  print leased show ids
 *   enforce --dir=data/review-texts       revert uncommitted changes under leased show dirs (run before commit)
 *   claim|heartbeat|release --show= --night=YYYY-MM-DD --holder= [--ttl-min=30]
 *
 * claim exits 0 when this holder owns the night, 3 when another holder does, 1 on any failure.
 * sync retries 3x, then writes an `unknown` marker carrying `tonight` (the shows whose press night is now):
 * writers hold only those until the next successful sync, every other show writes (BRO-6648); the publish
 * view (rebuild) warns and proceeds. `sync --page` (the poller, whose job commits the alert ledger) also
 * raises the failure: a worker card when a show is tonight, else a digest line.
 * enforce reverts uncommitted changes under blocked shows (known: leased; unknown: tonight's).
 */
const path = require('path');
const store = require('./lib/opening-night-lane/lease-store');
const guard = require('./lib/opening-night-lane/lease-guard');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const repoDir = path.resolve(__dirname, '..');
const storeOpts = () => ({ repoDir, remote: arg('remote') || 'origin', branch: arg('branch') || store.DEFAULT_BRANCH });

function main() {
  if (cmd === 'sync') {
    let lastErr;
    for (let i = 1; i <= 3; i++) {
      try {
        const state = store.syncLocalFile(storeOpts(), guard.leasesFile());
        console.log(`opening-night lease sync: ${Object.keys(state.leases).length} lease(s) in store`);
        return 0;
      } catch (e) { lastErr = e; if (i < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * i); }
    }
    // Could not reach the store: a blip must not unlock the lane's show tonight, and must not
    // silence every other show either. The marker names tonight's shows; they wait.
    const tonight = guard.tonightShowIds();
    store.writeAtomic(guard.leasesFile(), JSON.stringify({ leases: {}, unknown: true, tonight, at: new Date().toISOString() }) + '\n');
    const why = String((lastErr && lastErr.message) || lastErr).slice(0, 160);
    console.log(`::warning::opening-night lease sync failed after 3 tries; tonight's show(s) wait [${tonight.join(', ') || 'none'}], every other show writes (${why})`);
    if (argv.includes('--page')) return raiseSyncFailure(syncFailureAlert({ tonight, why })).then(() => 0);
    return 0;
  }
  if (cmd === 'list') {
    const ids = guard.leasedShowIds();
    ids.forEach((s) => console.log(s));
    return 0;
  }
  if (cmd === 'enforce') {
    const dir = path.resolve(arg('dir') || 'data/review-texts');
    const { unknown, shows } = guard.writeBlockedShowIds();
    const reverted = guard.revertLeasedChanges(dir, shows);
    const what = unknown ? `tonight's show(s) while the lease store is unknown` : 'leased show(s)';
    if (reverted.length) console.log(`::${unknown ? 'error' : 'warning'}::opening-night lease: held back ${reverted.length} write(s) under ${what} ${shows.join(', ')} (a later run collects them again):\n${reverted.slice(0, 20).join('\n')}`);
    else console.log(`opening-night lease: no writes to ${what} (${shows.length} blocked)`);
    return 0;
  }
  if (['claim', 'heartbeat', 'release'].includes(cmd)) {
    const args = { show: arg('show'), night: arg('night'), holder: arg('holder') };
    const ttl = arg('ttl-min');
    if (ttl) args.ttlMs = Number(ttl) * 60000;
    const out = store[cmd](storeOpts(), args);
    console.log(JSON.stringify({ ok: out.ok, reason: out.reason, holder: out.holder, attempts: out.attempts, detail: out.detail }));
    if (out.ok) return 0;
    return out.reason === 'held-by-other' ? 3 : 1;
  }
  console.error('usage: opening-night-lease.js sync|list|enforce|claim|heartbeat|release');
  return 2;
}

/** The alert for a failed sync. Pure. A show tonight = worker card (the owner cannot fix a git outage), else digest. */
function syncFailureAlert({ tonight, why }) {
  const shows = tonight.join(', ');
  if (tonight.length) {
    return {
      kind: 'card',
      conditionKey: 'opening-night-lease-store-unknown-tonight',
      title: `Opening-night lease store unreachable on ${shows}'s press night`,
      description: `scripts/opening-night-lease.js sync could not read the opening-night-leases branch after 3 tries (${why}). ` +
        `Old-path writers hold ${shows} until a sync succeeds; every other show writes. Check git access to the branch ` +
        `and re-run the poller; if the lane is not running tonight, nothing collects ${shows} while this lasts.`,
    };
  }
  return {
    kind: 'digest',
    conditionKey: 'opening-night-lease-store-unknown',
    title: 'Opening-night lease store unreachable (no press night now)',
    description: `scripts/opening-night-lease.js sync could not read the opening-night-leases branch after 3 tries (${why}). No show's press night is now, so every writer proceeds.`,
  };
}

async function raiseSyncFailure(alert) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    if (alert.kind === 'card') {
      await require('./lib/guard-escalation').escalateGuard(routeAlert, { conditionKey: alert.conditionKey, title: alert.title, description: alert.description });
    } else {
      await routeAlert({ conditionKey: alert.conditionKey, title: alert.title, description: alert.description, disposition: 'digest', cooldownHours: 12 });
    }
  } catch (e) {
    console.log(`::warning::opening-night lease: could not raise the sync failure (${String(e.message).slice(0, 160)}); the warning above stands`);
  }
}

module.exports = { syncFailureAlert };

if (require.main === module) Promise.resolve(main()).then((code) => process.exit(code));
