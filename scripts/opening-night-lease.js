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
 * view (rebuild) warns and proceeds. scripts/opening-night-lease-alert.js raises it (the sync action, page: 'true').
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
    const started = Date.now();
    for (let i = 1; i <= 3; i++) {
      if (i > 1 && Date.now() - started > 45000) break; // fit the 2-minute steps: a hung git already used the budget
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

if (require.main === module) process.exit(main());
