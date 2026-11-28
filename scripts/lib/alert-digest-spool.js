#!/usr/bin/env node
'use strict';
/**
 * alert-digest-spool.js — the owner digest queue for jobs that run OFF CI
 * (BRO-7171).
 *
 * The digest queue (data/audit/alert-digest-queue.json) is drained only by
 * CI's health-check. On the Mac, owner-alert-router used to write the tracked
 * copy in the shared checkout, where sync-audit-checkout.sh resets dirty
 * non-jsonl data/audit files and nothing commits them: the row was lost, and
 * the machine-local alert ledger had already recorded the condition as
 * notified, so it was never queued again.
 *
 * Off CI the router now writes this spool (same bare-array format, outside any
 * checkout), and `flush` publishes it into origin's tracked queue with a
 * working-tree-free plumbing commit (gap-recovery-publish.publishComputed),
 * merged by conditionKey with merge-alert-digest-queue (later queuedAt wins).
 * scripts/lib/sync-audit-checkout.sh runs the flush every checkout-sync tick.
 *
 * Exactly-once: before the push the flush journals {commit, rows} in the meta
 * file. A crash after the push but before the spool is trimmed is resolved on
 * the next tick by checking that commit's ancestry on origin, never by
 * re-pushing (which would bring back rows health-check had already drained).
 *
 * Removals: removeDigestLines() off CI tombstones a key this machine already
 * published, so the flush removes it from origin's queue too (only rows queued
 * at or before the removal).
 *
 * CLI: node scripts/lib/alert-digest-spool.js flush [--repo=DIR]
 *      node scripts/lib/alert-digest-spool.js status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const QUEUE_REL = 'data/audit/alert-digest-queue.json';

function spoolPath() {
  return process.env.ALERT_DIGEST_SPOOL_PATH
    || path.join(os.homedir(), '.broadwayscore-state', 'alert-digest-spool.json');
}
const metaPath = () => `${spoolPath()}.meta.json`;

function readJson(p, fallback) {
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return j == null ? fallback : j; } catch { return fallback; }
}
function writeJsonAtomic(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
const readSpool = () => { const a = readJson(spoolPath(), []); return Array.isArray(a) ? a : []; };
function readMeta() {
  const m = readJson(metaPath(), {});
  return { published: m.published || {}, removals: m.removals || {}, inflight: m.inflight || null };
}

/** Same lock the router takes around spool read-modify-writes. */
function withSpoolLock(fn) {
  fs.mkdirSync(path.dirname(spoolPath()), { recursive: true });
  return require('./file-lock').withFileLock(`${spoolPath()}.lock`, fn, { timeoutMs: 15000, sleepWait: true });
}

/** Tombstone keys this machine already published (others have nothing to remove on origin). */
function recordRemovals(keys, nowIso = new Date().toISOString()) {
  return withSpoolLock(() => {
    const meta = readMeta();
    let n = 0;
    for (const k of keys) if (meta.published[k]) { meta.removals[k] = nowIso; n++; }
    if (n) writeJsonAtomic(metaPath(), meta);
    return n;
  });
}

/**
 * Pure: origin's queue minus tombstoned rows, then the spool rows merged in by
 * conditionKey (later queuedAt wins; a tie keeps origin's).
 */
function mergeIntoOrigin(originRows, spoolRows, removals) {
  const { mergeAlertDigestQueue } = require('./merge-alert-digest-queue');
  const origin = (Array.isArray(originRows) ? originRows : []).filter((r) => {
    const at = r && removals[r.conditionKey];
    return !(at && String(r.queuedAt || '') <= at);
  });
  return mergeAlertDigestQueue(origin, spoolRows, null).merged;
}

/** After a landed (or no-op) publish: drop exactly the rows/tombstones that were published. */
function finalize(sent) {
  withSpoolLock(() => {
    const sentRows = new Map(sent.rows.map((r) => [r.k, r.q]));
    const spool = readSpool();
    const kept = spool.filter((r) => !(r && sentRows.has(r.conditionKey) && sentRows.get(r.conditionKey) === r.queuedAt));
    if (kept.length !== spool.length) writeJsonAtomic(spoolPath(), kept);
    const meta = readMeta();
    for (const [k, q] of sentRows) meta.published[k] = q;
    for (const [k, at] of Object.entries(sent.removals || {})) if (meta.removals[k] === at) delete meta.removals[k];
    meta.inflight = null;
    writeJsonAtomic(metaPath(), meta);
  });
}

/**
 * @returns {{pushed:boolean, upToDate?:boolean, commit?:string, rows:number, removals:number, resolvedInflight?:boolean}}
 */
function flush({ repoDir, remote = 'origin', branch = 'main', log = () => {}, attempts = 5 } = {}) {
  const pub = require('./gap-recovery-publish');
  let resolvedInflight = false;
  const inflight = readMeta().inflight;
  if (inflight && inflight.commit) {
    if (pub.landedOnOrigin({ repoDir, commit: inflight.commit, remote, branch })) {
      finalize(inflight);
      resolvedInflight = true;
      log(`earlier flush ${inflight.commit.slice(0, 10)} had landed; spool trimmed`);
    } else {
      withSpoolLock(() => { const m = readMeta(); m.inflight = null; writeJsonAtomic(metaPath(), m); });
    }
  }
  const rows = readSpool().filter((r) => r && typeof r.conditionKey === 'string');
  const removals = { ...readMeta().removals };
  if (!rows.length && !Object.keys(removals).length) return { pushed: false, upToDate: true, rows: 0, removals: 0, resolvedInflight };
  const sent = { rows: rows.map((r) => ({ k: r.conditionKey, q: r.queuedAt })), removals };
  const r = pub.publishComputed({
    repoDir, remote, branch, attempts, log, label: 'alert digest spool',
    message: `data: Mac alert digest rows (${rows.length} queued, ${Object.keys(removals).length} removed) [skip ci]`,
    compute: (originText) => {
      let origin = [];
      try { const j = JSON.parse(originText(QUEUE_REL) || '[]'); if (Array.isArray(j)) origin = j; } catch { /* corrupt on origin: rebuild from ours */ }
      return [{ rel: QUEUE_REL, text: JSON.stringify(mergeIntoOrigin(origin, rows, removals), null, 2) + '\n' }];
    },
    beforePush: (commit) => withSpoolLock(() => { const m = readMeta(); m.inflight = { commit, ...sent }; writeJsonAtomic(metaPath(), m); }),
  });
  finalize(sent);
  return { ...r, rows: rows.length, removals: Object.keys(removals).length, resolvedInflight };
}

module.exports = { spoolPath, metaPath, recordRemovals, mergeIntoOrigin, flush, readSpool, readMeta, QUEUE_REL };

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  const repoArg = process.argv.find((a) => a.startsWith('--repo='));
  const repoDir = repoArg ? repoArg.slice(7) : path.join(__dirname, '..', '..');
  if (cmd === 'status') {
    console.log(JSON.stringify({ spool: spoolPath(), rows: readSpool().length, meta: readMeta() }, null, 2));
  } else if (cmd === 'flush') {
    try {
      const r = flush({ repoDir, log: (m) => console.log(`[alert-digest-spool] ${m}`) });
      console.log(`[alert-digest-spool] ${r.pushed ? `published ${r.rows} row(s), ${r.removals} removal(s) as ${r.commit.slice(0, 10)}` : 'nothing to publish'}`);
    } catch (e) {
      console.error(`[alert-digest-spool] flush failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error('usage: alert-digest-spool.js flush|status [--repo=DIR]');
    process.exitCode = 2;
  }
}
