#!/usr/bin/env node
// scripts/lib/cloud-memory-reconcile.js — keep the repo's cloud-memory/ mirror
// current from the private claude-config repo, without the Mac (BRO-5074).
//
// WHY THIS EXISTS
// ---------------
// cloud-memory/ used to be refreshed only by the Mac's session-stop, which
// runs scripts/sync-memory-to-repo.sh --commit FROM the Mac's own Broadwayscore
// checkout, commits there and bare-pushes main with all output discarded. The
// last such commit landed 2026-10-01; claude-config (which the Mac's
// claude-sync pushes the same memory dir to) kept updating. Cloud sessions
// read a mirror nine days stale and nothing said so. A fixed sync script
// cannot even reach the Mac while that checkout is wedged, because the Mac
// runs the copy in that checkout. So the mirror is now reconciled in CI from
// claude-config (.github/workflows/cloud-memory-reconcile.yml), and the
// result is recorded in data/audit/cloud-memory-drift.json for the digest.
//
// THE RULE (same safety contract as cloud-memory-merge.js: nothing written by
// a cloud session is ever dropped). claude-config's git history stands in for
// that file's manifest: a mirror blob that appears in the history of the same
// path in claude-config is content the Mac has already seen, so claude-config's
// current version supersedes it. Per root-level *.md note (MEMORY.md excluded,
// see NEVER_ADOPT in cloud-memory-merge.js; the index is the Mac's to write):
//
//   source only                          -> add
//   same content                         -> nothing
//   both, mirror blob in source history  -> update (Mac's version supersedes)
//   both, mirror edited by a cloud
//     session since the Mac last saw it  -> 3-way UNION merge against the
//                                           newest mirror version the Mac saw
//                                           (both sides' lines kept; notes
//                                           are append-mostly prose)
//   both, no shared version at all       -> leave, report as diverged
//   mirror only, blob in source history  -> delete (Mac deleted it)
//   mirror only, never seen by the Mac   -> leave, report as diverged
//
// Anything still different from claude-config afterwards (a merged note, a
// cloud-written note) is "waiting for the Mac": the Mac's own sync adopts it.
// The report keeps when each name first diverged, so the daily digest can say
// when the Mac has not picked one up for 48h (health-check.js
// cloudMemoryDriftResults).
//
// Known noise, never loss, once the Mac's sync works again: content written
// here is not in the Mac's manifest, so a Mac-side edit of such a note shows
// up as a conflict (a _conflicts/ copy), and a note the owner deleted locally
// before the Mac's next successful sync is adopted back.
//
// Pure decision functions (planReconcile, nextDivergence) + git I/O wrapper,
// per CLAUDE.md rule 15. Tests: scripts/lib/cloud-memory-reconcile.test.mjs.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { NEVER_ADOPT } = require('./cloud-memory-merge');

const REPORT_VERSION = 1;

/** Root-level, non-dot *.md names only — the filter cloud-memory-merge.js uses. */
function isNote(name) {
  return name.endsWith('.md') && !name.startsWith('.') && !name.includes('/') && !NEVER_ADOPT.has(name);
}

/**
 * Decide what to do. PURE.
 * @param {object} a
 * @param {Object<string,string>} a.mirror        name -> blob id now in the mirror
 * @param {Object<string,string>} a.source        name -> blob id now in claude-config
 * @param {Object<string,Set<string>>} a.sourceHistory  name -> every blob id that path ever had in claude-config
 * @param {Object<string,string[]>} a.mirrorHistory     name -> the mirror's blob ids for that path, newest first
 * @param {Object<string,{source,result}>} a.incorporated  name -> an earlier run's merge: the claude-config
 *   blob it merged in and the blob it wrote. Lets the next run use that claude-config version as the base,
 *   so a union merge is never re-applied against an older base (which would duplicate lines).
 */
function planReconcile({ mirror, source, sourceHistory = {}, mirrorHistory = {}, incorporated = {} }) {
  const plan = { add: [], update: [], merge: [], alreadyMerged: [], remove: [], diverged: [], unchanged: [] };
  const seen = (name, blob) => Boolean(sourceHistory[name] && sourceHistory[name].has(blob));
  const names = new Set([...Object.keys(mirror), ...Object.keys(source)]);
  for (const name of [...names].sort()) {
    if (!isNote(name)) continue;
    const m = mirror[name];
    const s = source[name];
    if (m === undefined) { plan.add.push(name); continue; }
    if (s === undefined) {
      if (seen(name, m)) plan.remove.push(name);
      else plan.diverged.push({ name, reason: 'only-in-mirror' });
      continue;
    }
    if (m === s) { plan.unchanged.push(name); continue; }
    if (seen(name, m)) { plan.update.push(name); continue; }
    // Newest mirror version whose claude-config side is known: one the Mac
    // saw itself, or one an earlier run produced by merging claude-config in.
    let base;
    for (const b of mirrorHistory[name] || [m]) {
      if (seen(name, b)) { base = b; break; }
      const inc = incorporated[name];
      if (inc && inc.result === b) { base = inc.source; break; }
    }
    if (!base) plan.diverged.push({ name, reason: 'no-common-version' });
    else if (base === s) plan.alreadyMerged.push(name); // claude-config has nothing new for it
    else plan.merge.push({ name, base });
  }
  return plan;
}

/**
 * Carry first-seen times forward. PURE.
 * @param {Array<{name,firstSeenAt}>} previous  last report's diverged list
 * @param {Array<{name,reason}>} current        names still different from claude-config
 */
function nextDivergence(previous, current, now) {
  const before = new Map((previous || []).map((d) => [d.name, d.firstSeenAt]));
  return current
    .map((d) => ({ ...d, firstSeenAt: before.get(d.name) || now.toISOString() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when two reports differ in anything but checkedAt (so an idle run commits nothing). */
// checkedAt and source change on every run (any claude-config commit moves
// source.commit), so neither alone is worth a commit to main.
function reportChanged(prev, next) {
  if (!prev) return true;
  const strip = ({ checkedAt, source, ...rest }) => JSON.stringify(rest);
  return strip(prev) !== strip(next);
}

// ---------------------------------------------------------------- git I/O --

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** name -> blob id for the files directly under `dir` at `rev`. */
function treeBlobs(repo, rev, dir) {
  const out = {};
  const listing = git(repo, ['ls-tree', `${rev}:${dir}`]);
  for (const line of listing.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/**
 * name -> blob ids the path has had, newest first, from one `git log --raw`
 * over the whole dir. Needs commits and trees only, so a --filter=blob:none
 * clone answers it without downloading a single note.
 */
function dirHistory(repo, rev, dir) {
  const out = {};
  // --full-history -m: also list blobs introduced on merged side branches and
  // by merge resolutions (default history simplification drops them, and an
  // unseen blob would be merged instead of updated). --topo-order keeps
  // "newest first" true across branches for the base choice.
  const raw = git(repo, ['log', '--raw', '--no-abbrev', '--no-renames', '--full-history', '-m', '--topo-order',
    '--format=', rev, '--', `${dir}/`]);
  const prefix = `${dir.replace(/\/$/, '')}/`;
  for (const line of raw.split('\n')) {
    const m = /^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) \w+\t(.+)$/.exec(line);
    if (!m || /^0+$/.test(m[1]) || !m[2].startsWith(prefix)) continue;
    const name = m[2].slice(prefix.length);
    (out[name] = out[name] || []).push(m[1]);
  }
  return out;
}

function catBlob(repo, blob) {
  return git(repo, ['cat-file', 'blob', blob]);
}

/** 3-way union merge; `ours` is claude-config's version so the Mac's order leads. */
function unionMerge(ours, base, theirs) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-merge-'));
  try {
    const p = (n, c) => { const f = path.join(tmp, n); fs.writeFileSync(f, c); return f; };
    return execFileSync('git', ['merge-file', '-p', '--union', p('ours', ours), p('base', base), p('theirs', theirs)], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Reconcile the mirror working tree in place and return the new report.
 * Mirror state is read from `mirrorRepo` HEAD (the caller resets to
 * origin/main first), so the plan is made against exactly what it commits on.
 */
// A near-empty claude-config memory dir (a bad claude-sync) would otherwise
// pass the history proof for every note and wipe the mirror in one push.
const MAX_REMOVE = 5;
const MAX_REMOVE_FRACTION = 0.1;
function massRemovalError(plan, mirrorCount) {
  const limit = Math.max(MAX_REMOVE, Math.floor(mirrorCount * MAX_REMOVE_FRACTION));
  if (plan.remove.length <= limit) return null;
  return `refusing to remove ${plan.remove.length} of ${mirrorCount} mirror notes in one run (limit ${limit}); `
    + `check claude-config's memory dir. First: ${plan.remove.slice(0, 5).join(', ')}`;
}

function reconcile({ sourceRepo, sourceDir, mirrorRepo, mirrorDir, previousReport = null, now = new Date(), dryRun = false }) {
  const mirror = treeBlobs(mirrorRepo, 'HEAD', mirrorDir);
  const source = treeBlobs(sourceRepo, 'HEAD', sourceDir);
  const sourceHistory = {};
  for (const [name, blobs] of Object.entries(dirHistory(sourceRepo, 'HEAD', sourceDir))) sourceHistory[name] = new Set(blobs);
  const mirrorHistory = dirHistory(mirrorRepo, 'HEAD', mirrorDir);
  const prevWaiting = new Map(((previousReport && previousReport.waitingForMac) || []).map((d) => [d.name, d]));
  const incorporated = {};
  for (const [name, d] of prevWaiting) if (d.source && d.result) incorporated[name] = { source: d.source, result: d.result };
  const plan = planReconcile({ mirror, source, sourceHistory, mirrorHistory, incorporated });
  const tooMany = massRemovalError(plan, Object.keys(mirror).filter(isNote).length);
  if (tooMany) throw Object.assign(new Error(tooMany), { code: 'MASS_REMOVE' });

  const target = (name) => path.join(mirrorRepo, mirrorDir, name);
  const sourceText = (name) => catBlob(sourceRepo, source[name]);
  const merged = [];
  const mergeRecords = [];
  if (!dryRun) {
    for (const name of [...plan.add, ...plan.update]) fs.writeFileSync(target(name), sourceText(name));
    for (const { name, base } of plan.merge) {
      const text = unionMerge(sourceText(name), catBlob(sourceRepo, base), catBlob(mirrorRepo, mirror[name]));
      fs.writeFileSync(target(name), text);
      merged.push(name);
      const result = git(mirrorRepo, ['hash-object', '--stdin'], { input: text }).trim();
      mergeRecords.push({ name, reason: 'cloud-edit-merged', source: source[name], result });
    }
    for (const name of plan.remove) fs.rmSync(target(name), { force: true });
  }

  // Still different from claude-config after this run = waiting for the Mac.
  const waiting = [
    ...(dryRun ? plan.merge.map(({ name }) => ({ name, reason: 'cloud-edit-merged' })) : mergeRecords),
    ...plan.alreadyMerged.map((name) => {
      const prev = prevWaiting.get(name) || {};
      return { name, reason: 'cloud-edit-merged', ...(prev.source ? { source: prev.source, result: prev.result } : {}) };
    }),
    ...plan.diverged,
  ];
  const sourceHead = git(sourceRepo, ['log', '-1', '--format=%H %cI', 'HEAD']).trim().split(' ');
  return {
    plan,
    merged,
    report: {
      version: REPORT_VERSION,
      checkedAt: now.toISOString(),
      source: { commit: sourceHead[0], committedAt: sourceHead[1] },
      lastApplied: (plan.add.length + plan.update.length + plan.merge.length + plan.remove.length)
        ? { at: now.toISOString(), added: plan.add, updated: plan.update, merged: plan.merge.map((m) => m.name), removed: plan.remove }
        : (previousReport && previousReport.lastApplied) || null,
      waitingForMac: nextDivergence(previousReport && previousReport.waitingForMac, waiting, now),
    },
  };
}

module.exports = {
  REPORT_VERSION, isNote, planReconcile, nextDivergence, reportChanged,
  treeBlobs, dirHistory, unionMerge, reconcile, massRemovalError,
};

// CLI: node scripts/lib/cloud-memory-reconcile.js --source-repo=PATH
//   --source-dir=projects/-Users-tompryor-Broadwayscore/memory
//   [--mirror-repo=.] [--mirror-dir=cloud-memory]
//   [--report=data/audit/cloud-memory-drift.json] [--dry-run]
//   [--error="why claude-config could not be read"]   (records the failure)
if (require.main === module) {
  const opt = (k, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const dryRun = process.argv.includes('--dry-run');
  const mirrorRepo = path.resolve(opt('mirror-repo', '.'));
  const reportPath = path.resolve(mirrorRepo, opt('report', 'data/audit/cloud-memory-drift.json'));
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* first run */ }
  const write = (report) => {
    if (dryRun || !reportChanged(previous, report)) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  };

  // Keep the last good state; the error field is what the digest reports.
  const fail = (error) => {
    write({ ...(previous || { version: REPORT_VERSION, waitingForMac: [] }), checkedAt: new Date().toISOString(), error });
    console.error(`cloud-memory-reconcile: recorded error: ${error}`);
    process.exit(1);
  };
  if (opt('error', null)) fail(opt('error', null));
  const sourceRepo = opt('source-repo', null);
  const sourceDir = opt('source-dir', null);
  if (!sourceRepo || !sourceDir) {
    console.error('usage: cloud-memory-reconcile.js --source-repo=PATH --source-dir=DIR [--mirror-repo=.] [--mirror-dir=cloud-memory] [--report=PATH] [--dry-run]');
    process.exit(2);
  }
  let result;
  try {
    result = reconcile({
      sourceRepo: path.resolve(sourceRepo), sourceDir, mirrorRepo,
      mirrorDir: opt('mirror-dir', 'cloud-memory'), previousReport: previous, dryRun,
    });
  } catch (e) {
    fail(e.code === 'MASS_REMOVE' ? e.message : `reconcile crashed: ${String(e.message).split('\n')[0].slice(0, 300)}`);
  }
  const { plan, report } = result;
  write(report);
  const say = (m) => console.log(`cloud-memory-reconcile: ${m}`);
  say(`${dryRun ? '[dry run] ' : ''}added ${plan.add.length}, updated ${plan.update.length}, merged ${plan.merge.length}, removed ${plan.remove.length}, unchanged ${plan.unchanged.length}`);
  for (const n of plan.add) say(`  add     ${n}`);
  for (const n of plan.update) say(`  update  ${n}`);
  for (const m of plan.merge) say(`  merge   ${m.name} (base ${m.base.slice(0, 8)})`);
  for (const n of plan.remove) say(`  remove  ${n}`);
  for (const d of report.waitingForMac) say(`  waiting for the Mac: ${d.name} (${d.reason}, since ${d.firstSeenAt})`);
}
