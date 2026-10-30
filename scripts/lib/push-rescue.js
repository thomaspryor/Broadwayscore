#!/usr/bin/env node
'use strict';
/**
 * Push rescue for the broadway-review-texts repo (BRO-6615).
 *
 * When every push attempt fails, the job's commits used to die with the
 * runner. opening-night-poller run 41013824281 (2026-10-30) lost 29 files
 * that way, including a new review stub (_pending/a-few-good-men-2026/
 * new-york-sun--4b16c00e.json) no later run re-created. The Git Data API
 * fallback cannot carry ADDED review files: the cross-show ownership gate
 * (validate-added-review-ownership.js) needs a working tree (BRO-5589), so
 * loosening that disqualifier was rejected in review.
 *
 * Instead the unpushed commit is pushed to a NEW branch,
 * push-rescue/<UTC stamp>-<run id>-<base sha>. Creating a fresh ref cannot
 * lose a race to main's churn, so this lands even when main pushes do not.
 * replay-push-rescue.yml then restores the added files on a fresh checkout,
 * runs the real ownership gate on them, pushes through push-review-texts,
 * and deletes the branch only once every restored file is on main.
 *
 * Only ADDS are replayed. Modifications and deletions need the local flow's
 * three-way context; they are named in the logs and otherwise lost, as before
 * (later runs redo enrichment and stub drains).
 *
 * CLI (cwd = a review-texts checkout):
 *   rescue <base> <head>       push <head> to a rescue branch when the range
 *                              adds review files; never fails the caller
 *   replay [--manifest=F]      restore added files from every rescue branch
 *   prune --manifest=F         delete rescue branches whose restored files
 *                              are all on origin/main now, byte for byte
 *
 * Branches are never deleted on age or on doubt: one with a conflict (main
 * or another rescue holds different content at the path), a file the
 * ownership gate dropped, is kept and named every hour
 * until a human resolves it. PUSH_RESCUE_DISABLE=1 turns off `rescue`.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isReviewFilePath } = require('./review-texts-api-fallback.js');

const RESCUE_PREFIX = 'push-rescue/';
const REF_RE = /^push-rescue\/(\d{8}T\d{6}Z)-([A-Za-z0-9_.]+)-([0-9a-f]{40})$/;

/** Review files plus pending stubs (_pending/<show>/<file>.json). */
function isRecoverablePath(p) {
  if (isReviewFilePath(p)) return true;
  const parts = String(p || '').split('/');
  return parts.length === 3 && parts[0] === '_pending' && parts[1] && !parts[1].startsWith('.')
    && parts[2].endsWith('.json');
}

/** Rows of `git diff --name-status -z --no-renames`. */
function parseNameStatusZ(out) {
  const parts = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]) rows.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return rows;
}

function recoverableAdds(rows) {
  return rows.filter((r) => r.status === 'A' && isRecoverablePath(r.path)).map((r) => r.path);
}

function rescueRefName({ now, runId, base }) {
  if (!/^[0-9a-f]{40}$/.test(String(base || ''))) throw new Error(`push-rescue: base must be a full sha, got '${base}'`);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = String(runId || 'local').replace(/[^A-Za-z0-9_.]/g, '_') || 'local';
  return `${RESCUE_PREFIX}${stamp}-${id}-${base}`;
}

function parseRescueRef(ref) {
  const m = REF_RE.exec(String(ref || '').replace(/^refs\/heads\//, ''));
  if (!m) return null;
  const s = m[1];
  const at = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return { stamp: s, at, runId: m[2], base: m[3] };
}

/**
 * Pure decision for one rescue branch.
 * @param {{adds: string[], mainBlob: Map<string,string>,
 *   touchedOnMain: Set<string>, rescueBlob: Map<string,string>,
 *   claimed?: Map<string,string>}} s
 *   mainBlob: blob sha of each path on origin/main now (absent = not there);
 *   touchedOnMain: paths a main commit since the rescue's base changed (e.g.
 *   a later run drained the stub); rescueBlob: blob sha on the rescue branch;
 *   claimed: paths an earlier branch in the same replay already restored.
 *   Nothing on main is ever overwritten or resurrected.
 */
function replayPlan({ adds, mainBlob, touchedOnMain, rescueBlob, claimed = new Map() }) {
  const restore = [];
  const skipped = [];
  const conflicts = [];
  for (const p of adds) {
    const ours = rescueBlob.get(p);
    if (mainBlob.has(p)) {
      if (mainBlob.get(p) === ours) skipped.push({ path: p, why: 'already on main' });
      else conflicts.push({ path: p, why: 'main holds a different version' });
    } else if (touchedOnMain.has(p)) skipped.push({ path: p, why: 'changed on main since the rescue (e.g. drained or moved)' });
    else if (claimed.has(p)) {
      if (claimed.get(p) === ours) skipped.push({ path: p, why: 'restored from another rescue branch' });
      else conflicts.push({ path: p, why: 'another rescue branch holds a different version' });
    } else restore.push(p);
  }
  return { restore, skipped, conflicts, keepForHuman: conflicts.length > 0 };
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}
function gitOk(args, opts) {
  const r = git(args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
  return r.stdout;
}
const netTimeoutMs = () => (Number(process.env.GIT_NET_TIMEOUT_SEC) || 60) * 1000;
const annotate = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function cliRescue([base, head]) {
  if (process.env.PUSH_RESCUE_DISABLE === '1') return;
  try {
    if (!base || !head) throw new Error('usage: rescue <base> <head>');
    const baseSha = gitOk(['rev-parse', '--verify', `${base}^{commit}`]).trim();
    const headSha = gitOk(['rev-parse', '--verify', `${head}^{commit}`]).trim();
    const adds = recoverableAdds(parseNameStatusZ(gitOk(['diff', '--name-status', '-z', '--no-renames', baseSha, headSha])));
    if (adds.length === 0) return;
    const ref = rescueRefName({ now: Date.now(), runId: [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT].filter(Boolean).join('.'), base: baseSha });
    const r = git(['push', 'origin', `${headSha}:refs/heads/${ref}`], { timeout: netTimeoutMs() });
    const list = adds.slice(0, 20).join(', ') + (adds.length > 20 ? ` (+${adds.length - 20} more)` : '');
    if (r.status === 0) {
      console.log(`::error title=review-texts push failed; new reviews rescued::${annotate(`${adds.length} new review file(s) did not reach main. Saved to branch ${ref}; replay-push-rescue.yml restores them through the ownership gate within the hour: ${list}`)}`);
    } else {
      console.log(`::error title=review-texts push failed; rescue ALSO failed::${annotate(`${adds.length} new review file(s) are lost with this runner (rescue push to ${ref} failed: ${(r.stderr || r.error || '').toString().trim().slice(0, 300)}): ${list}`)}`);
    }
  } catch (e) {
    // Fail-open: the caller is already failing; this must never mask its rc.
    console.log(`::warning::push-rescue: could not check or rescue unpushed review files: ${annotate(String(e && e.message || e).slice(0, 400))}`);
  }
}

function listRescueRefs() {
  const out = gitOk(['ls-remote', 'origin', `refs/heads/${RESCUE_PREFIX}*`], { timeout: netTimeoutMs() });
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return { sha, ref: ref.replace(/^refs\/heads\//, ''), info: parseRescueRef(ref) };
  });
}

function blobAt(rev, p) {
  const r = git(['rev-parse', '--verify', '--quiet', `${rev}:${p}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function replayOne({ sha, ref, info }, claimed) {
  gitOk(['fetch', '--no-tags', '--depth=1', 'origin', sha, info.base], { timeout: netTimeoutMs() * 2 });
  const baseTime = Number(gitOk(['show', '-s', '--format=%ct', info.base]).trim());
  // Main's history since the rescue's base, so a path a later commit
  // drained or moved is seen as touched instead of absent.
  gitOk(['fetch', '--no-tags', `--shallow-since=${new Date((baseTime - 3600) * 1000).toISOString()}`, 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 3 });
  const rows = parseNameStatusZ(gitOk(['diff', '--name-status', '-z', '--no-renames', info.base, sha]));
  const adds = recoverableAdds(rows);
  const modified = rows.filter((r) => !(r.status === 'A' && isRecoverablePath(r.path))).map((r) => r.path);
  const mainBlob = new Map();
  const rescueBlob = new Map();
  for (const p of adds) {
    rescueBlob.set(p, blobAt(sha, p));
    const m = blobAt('origin/main', p);
    if (m) mainBlob.set(p, m);
  }
  const since = new Date(baseTime * 1000).toISOString();
  const touched = new Set(adds.filter((p) => !mainBlob.has(p)
    && gitOk(['log', '-1', '--format=%H', `--since=${since}`, 'origin/main', '--', p]).trim() !== ''));
  const plan = replayPlan({ adds, mainBlob, touchedOnMain: touched, rescueBlob, claimed });
  for (const p of plan.restore) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, gitOk(['show', `${sha}:${p}`]));
    claimed.set(p, rescueBlob.get(p));
  }
  console.log(`push-rescue: ${ref}: restoring ${plan.restore.length}, skipping ${plan.skipped.length}, conflicts ${plan.conflicts.length}${modified.length ? `, ${modified.length} modified/deleted path(s) not replayed` : ''}`);
  for (const x of [...plan.skipped, ...plan.conflicts]) console.log(`  ${plan.conflicts.includes(x) ? 'CONFLICT' : 'skip'} ${x.path}: ${x.why}`);
  return { ref, restored: plan.restore, restoredBlobs: Object.fromEntries(plan.restore.map((p) => [p, rescueBlob.get(p)])), skipped: plan.skipped, conflicts: plan.conflicts, keepForHuman: plan.keepForHuman, modified: modified.slice(0, 50) };
}

function cliReplay(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  const refs = listRescueRefs();
  const manifest = { refs: [], failed: [] };
  const claimed = new Map();
  if (refs.length === 0) console.log('push-rescue: no rescue branches');
  for (const entry of refs) {
    if (!entry.info) { console.log(`::warning::push-rescue: ignoring malformed branch ${entry.ref}`); continue; }
    try {
      manifest.refs.push(replayOne(entry, claimed));
    } catch (e) {
      // One bad branch must not block the others; the job fails at the end.
      manifest.failed.push(entry.ref);
      console.log(`::error::push-rescue: could not replay ${entry.ref}: ${annotate(String(e && e.message || e).slice(0, 400))}`);
    }
  }
  // The real cross-show ownership gate, untracked-file mode, strict: deletes
  // any restored review whose URL another show now owns, and exits non-zero
  // on its own crash instead of letting restores through unchecked.
  if (manifest.refs.some((r) => r.restored.length)) {
    const gate = spawnSync(process.execPath, [path.join(__dirname, '..', 'validate-added-review-ownership.js'), '--strict'], { stdio: 'inherit' });
    if (gate.status !== 0) throw new Error(`validate-added-review-ownership.js exited ${gate.status}; refusing to push unchecked restores`);
    for (const r of manifest.refs) {
      r.dropped = r.restored.filter((p) => !fs.existsSync(p));
      r.restored = r.restored.filter((p) => fs.existsSync(p));
      // A dropped file is kept on its branch for a human: the gate can drop
      // both halves of a pair restored in one batch.
      if (r.dropped.length) {
        r.keepForHuman = true;
        console.log(`::warning::push-rescue: ownership gate dropped ${r.dropped.length} restored file(s) from ${r.ref}: ${r.dropped.slice(0, 5).join(', ')}`);
      }
    }
  }
  if (manifestPath) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const n = manifest.refs.reduce((a, r) => a + r.restored.length, 0);
  console.log(`push-rescue: restored ${n} file(s) from ${manifest.refs.length} branch(es), ${manifest.failed.length} failed`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `restored=${n}\nbranches=${manifest.refs.length}\nfailed=${manifest.failed.length}\n`);
}

/**
 * Branches safe to delete: nothing kept for a human, and every restored file
 * is on main with exactly the restored content.
 * @param {(p: string) => string|null} blobOnMain
 */
function prunable(manifest, blobOnMain) {
  return (manifest.refs || []).filter((r) => !r.keepForHuman
    && r.restored.every((p) => blobOnMain(p) === (r.restoredBlobs || {})[p]));
}

function cliPrune(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  gitOk(['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 2 });
  const ok = prunable(manifest, (p) => blobAt('origin/main', p));
  for (const r of ok) {
    gitOk(['push', 'origin', '--delete', `refs/heads/${r.ref}`], { timeout: netTimeoutMs() });
    console.log(`push-rescue: deleted ${r.ref}${r.modified && r.modified.length ? ` (its ${r.modified.length} modified/deleted path(s) were not replayed: ${r.modified.slice(0, 5).join(', ')})` : ''}`);
  }
  for (const r of (manifest.refs || []).filter((x) => !ok.includes(x))) {
    const why = r.keepForHuman
      ? [r.conflicts && r.conflicts.length ? `${r.conflicts.length} conflicting path(s) (${r.conflicts.slice(0, 3).map((c) => c.path).join(', ')})` : '',
        r.dropped && r.dropped.length ? `${r.dropped.length} file(s) the ownership gate dropped` : ''].filter(Boolean).join('; ')
      : 'a restored file is not on main yet; the next run retries';
    console.log(`::warning::push-rescue: kept ${r.ref}: ${why}. Inspect: git log -1 --stat origin/${r.ref}`);
  }
  // A branch only a person can settle fails the run every hour (warning severity,
  // digest repeat-failure row) instead of sitting behind a green check.
  const human = (manifest.refs || []).filter((r) => r.keepForHuman);
  if (human.length) {
    console.log(`::error::push-rescue: ${human.length} rescue branch(es) need a person: ${human.map((r) => r.ref).join(', ')}`);
    process.exitCode = 1;
  }
}

module.exports = { RESCUE_PREFIX, isRecoverablePath, parseNameStatusZ, recoverableAdds, rescueRefName, parseRescueRef, replayPlan, prunable };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'rescue') cliRescue(rest);
  else if (cmd === 'replay') cliReplay(rest);
  else if (cmd === 'prune') cliPrune(rest);
  else {
    console.error('usage: push-rescue.js rescue <base> <head> | replay [--manifest=F] | prune --manifest=F');
    process.exit(2);
  }
}
