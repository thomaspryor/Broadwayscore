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
 * sync retries 3x, then writes an `unknown` marker: per-show writers (poller, gather) treat every
 * show as leased until the next successful sync; enumerating callers (rebuild, enforce) warn and proceed.
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
    // Could not reach the store: mark the local state unknown so per-show checks fail closed
    // (a blip on a fresh runner must not unlock the lane's show); enumeration-based callers
    // (rebuild, enforce) cannot name shows from it and proceed with a warning.
    require('fs').mkdirSync(path.dirname(guard.leasesFile()), { recursive: true });
    require('fs').writeFileSync(guard.leasesFile(), JSON.stringify({ leases: {}, unknown: true }) + '\n');
    console.log(`::warning::opening-night lease sync failed after 3 tries; per-show writers will treat shows as leased (${String(lastErr.message).slice(0, 160)})`);
    return 0;
  }
  if (cmd === 'list') {
    const ids = guard.leasedShowIds();
    ids.forEach((s) => console.log(s));
    return 0;
  }
  if (cmd === 'enforce') {
    const dir = path.resolve(arg('dir') || 'data/review-texts');
    let shows;
    try { shows = guard.leasedShowIds(); } catch (e) {
      console.log(`::warning::opening-night lease file unreadable, cannot enforce (${String(e.message).slice(0, 160)})`);
      return 0;
    }
    const reverted = guard.revertLeasedChanges(dir, shows);
    if (reverted.length) console.log(`::warning::opening-night lease: refused ${reverted.length} write(s) under leased show(s) ${shows.join(', ')}:\n${reverted.slice(0, 20).join('\n')}`);
    else console.log(`opening-night lease: no writes to leased shows (${shows.length} leased)`);
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
