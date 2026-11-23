'use strict';
/**
 * BRO-8179: reap stale top-level entries of /private/tmp.
 *
 * Why it exists: on 2026-11-23 /private/tmp held 384,253 top-level entries
 * (~40GB), growing ~200k items / ~20GB a day: mkdtemp dirs from `node --test`
 * suites (orj-*, merge-test-gate-*, manifest-paths-*, ...) and ad-hoc session
 * clones (/tmp/bro*, /tmp/bromain). macOS only clears /tmp at reboot and this
 * Mac rarely reboots, so disk exhaustion stalled dispatch repeatedly.
 * reap-temp-checkouts.js only knew makeFreshCheckout's named prefixes.
 *
 * An entry is removed only when ALL hold:
 *   - it sits directly under the root and is owned by this uid;
 *   - it is a plain file or a real directory (sockets, fifos, devices and
 *     symlinks are never touched);
 *   - its name is not a dotfile, not claude-* and not on KEEP_NAME_RE
 *     (system/launchd/tmux/ssh-agent style names), and not one of
 *     reap-temp-checkouts.js's own prefixes (that reaper owns those);
 *   - neither it nor anything under it (node_modules / .git/objects pruned)
 *     changed within maxAgeH (default 24h);
 *   - no process holds a file or cwd under it, per one lsof snapshot taken
 *     before the scan and a fresh one taken just before the deletes (an
 *     lsof failure keeps everything).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { openPathSnapshot, TEMP_CHECKOUT_PREFIXES } = require('./reap-temp-checkouts.js');

const DEFAULT_ROOT = '/private/tmp';
const MAX_AGE_H = Number(process.env.TMP_REAP_MAX_AGE_H) > 0 ? Number(process.env.TMP_REAP_MAX_AGE_H) : 24;
// Names nothing in this repo creates but the OS, launchd agents or tools rely on.
const KEEP_NAME_RE = /^(?:\.|claude|com\.apple|launch|tmux-|ssh-|powerlog|KSOutOfProcessFetcher|MozillaUpdateLock|boost_interprocess)/i;
// Bounded walk: a huge clone is judged by what was seen before the cap plus
// its explicit git markers instead of stat-ing every file.
const WALK_LIMIT = 50000;
const PRUNE_DIRS = new Set(['node_modules', 'objects']);

function isProtectedName(name) {
  if (KEEP_NAME_RE.test(name)) return true;
  return TEMP_CHECKOUT_PREFIXES.some((p) => name.startsWith(p));
}

/** Top-level names under root that some process holds open. null = lsof failed. */
function openTopNames(snapshot, root) {
  if (snapshot === null) return null;
  const prefix = `${root}/`;
  const names = new Set();
  for (const p of snapshot) {
    if (!p.startsWith(prefix)) continue;
    names.add(p.slice(prefix.length).split('/')[0]);
  }
  return names;
}

/**
 * True when anything under dir changed after cutoffMs. Early-exits on the
 * first recent mtime. Unreadable subtrees count as recent (keep).
 */
function touchedSince(dir, cutoffMs, limit = WALK_LIMIT) {
  for (const marker of ['.git/index', '.git/HEAD', '.git/logs/HEAD']) {
    try { if (fs.lstatSync(path.join(dir, marker)).mtimeMs > cutoffMs) return true; } catch { /* absent */ }
  }
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; return true; }
    for (const ent of ents) {
      if (++seen > limit) return false; // markers + first `limit` entries were all old
      const p = path.join(d, ent.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.mtimeMs > cutoffMs) return true;
      if (ent.isDirectory() && !PRUNE_DIRS.has(ent.name)) stack.push(p);
    }
  }
  return false;
}

/** Pure-ish decision for one top-level entry. Never deletes. */
function decideEntry(root, name, { now = Date.now(), maxAgeH = MAX_AGE_H, openNames, uid = process.getuid() } = {}) {
  if (!name || name.includes('/') || name === '.' || name === '..') return { reap: false, reason: 'bad name' };
  if (isProtectedName(name)) return { reap: false, reason: 'protected name' };
  const p = path.join(root, name);
  let st;
  try { st = fs.lstatSync(p); } catch { return { reap: false, reason: 'gone' }; }
  if (st.uid !== uid) return { reap: false, reason: 'not ours' };
  if (st.isSymbolicLink()) return { reap: false, reason: 'symlink' };
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return { reap: false, reason: 'socket/fifo/device' };
  const cutoff = now - maxAgeH * 3600 * 1000;
  if (st.mtimeMs > cutoff) return { reap: false, reason: `younger than ${maxAgeH}h` };
  if (!openNames || openNames.has(name)) return { reap: false, reason: 'open handle under it (or lsof failed)' };
  if (isDir && touchedSince(p, cutoff)) return { reap: false, reason: `something inside changed within ${maxAgeH}h` };
  return { reap: true, path: p, isDir, bytes: isDir ? 0 : st.size, reason: `idle >${maxAgeH}h, nothing open` };
}

function duKb(p) {
  try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s/)[0]) || 0; }
  catch { return 0; }
}

/**
 * Reap every eligible entry. Never throws.
 * @returns {{scanned:number, removed:number, freedKb:number, kept:object, skipped?:string}}
 */
function reapStaleTmp({ root = process.env.TMP_REAP_ROOT || DEFAULT_ROOT, maxAgeH = MAX_AGE_H, dryRun = false, now = Date.now(),
  budgetMs = Infinity, snapshotFn = openPathSnapshot, measure = true, batchSize = 500, log = () => {} } = {}) {
  const summary = { scanned: 0, removed: 0, freedKb: 0, kept: {} };
  if (process.env.TMP_REAP_DISABLED === '1') return { ...summary, skipped: 'TMP_REAP_DISABLED=1' };
  const started = Date.now();
  try {
    const real = fs.realpathSync(root);
    let names = fs.readdirSync(real);
    const openNames = openTopNames(snapshotFn({ excludePid: process.pid }), real);
    if (openNames === null) { log('lsof failed; keeping everything this run'); return { ...summary, skipped: 'lsof failed' }; }
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      // Fresh lsof right before deleting: the scan may be minutes old.
      const fresh = openTopNames(snapshotFn({ excludePid: process.pid }), real);
      for (const d of batch) {
        if (fresh === null || fresh.has(path.basename(d.path))) { summary.kept['opened since scan'] = (summary.kept['opened since scan'] || 0) + 1; continue; }
        const kb = measure ? (d.isDir ? duKb(d.path) : Math.ceil(d.bytes / 1024)) : 0;
        if (dryRun) { summary.removed++; summary.freedKb += kb; continue; }
        try {
          fs.rmSync(d.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          summary.removed++; summary.freedKb += kb;
        } catch (e) { summary.kept['removal failed'] = (summary.kept['removal failed'] || 0) + 1; log(`rm failed ${d.path}: ${e.message}`); }
      }
      batch = [];
    };
    for (const name of names) {
      if (Date.now() - started > budgetMs) { summary.skipped = `budget ${budgetMs}ms spent`; break; }
      summary.scanned++;
      const d = decideEntry(real, name, { now, maxAgeH, openNames });
      if (!d.reap) { summary.kept[d.reason] = (summary.kept[d.reason] || 0) + 1; continue; }
      batch.push(d);
      if (batch.length >= batchSize) flush();
    }
    flush();
    names = null;
  } catch (e) {
    log(`stale tmp reap failed (non-fatal): ${e.message}`);
    summary.skipped = `error: ${e.message}`;
  }
  return summary;
}

function formatSummary(s, dryRun) {
  const gb = (s.freedKb / 1024 / 1024).toFixed(2);
  const kept = Object.entries(s.kept).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('; ');
  return `STALE-TMP-REAP scanned=${s.scanned} ${dryRun ? 'would_remove' : 'removed'}=${s.removed} freed=${gb}GB${s.skipped ? ` skipped=${s.skipped}` : ''} kept: ${kept || 'none'}`;
}

module.exports = { DEFAULT_ROOT, MAX_AGE_H, isProtectedName, openTopNames, touchedSince, decideEntry, reapStaleTmp, formatSummary };

// CLI: node scripts/lib/reap-stale-tmp.js [--dry-run] [--root DIR] [--max-age-h N] [--budget-min N] [--no-measure]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const dryRun = argv.includes('--dry-run');
  const opts = { dryRun, measure: !argv.includes('--no-measure'), log: (l) => console.log(l) };
  if (val('--root')) opts.root = val('--root');
  if (Number(val('--max-age-h')) > 0) opts.maxAgeH = Number(val('--max-age-h'));
  if (Number(val('--budget-min')) > 0) opts.budgetMs = Number(val('--budget-min')) * 60000;
  console.log(formatSummary(reapStaleTmp(opts), dryRun));
}
