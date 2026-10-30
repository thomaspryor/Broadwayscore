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
 * Only ADDS are replayed. A modified file in the rescued commit stays on the
 * branch for a human, and the branch is kept while it holds one (see
 * replayPlan): modifications need the local flow's three-way context.
 *
 * CLI (cwd = a review-texts checkout):
 *   rescue <base> <head>       push <head> to a rescue branch when the range
 *                              adds review files; never fails the caller
 *   replay [--manifest=F] [--max-age-days=N]
 *                              restore added files from every rescue branch
 *   prune --manifest=F         delete rescue branches whose restored files
 *                              are all on origin/main now
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
 * @param {{adds: string[], modified: string[], onMain: Set<string>, touchedOnMain: Set<string>}} s
 *   onMain: paths present on origin/main now; touchedOnMain: paths any main
 *   commit since the rescue's base changed (e.g. a later run drained the
 *   stub). Neither is ever overwritten or resurrected.
 */
function replayPlan({ adds, modified = [], onMain, touchedOnMain }) {
  const restore = [];
  const skipped = [];
  for (const p of adds) {
    if (onMain.has(p)) skipped.push({ path: p, why: 'already on main' });
    else if (touchedOnMain.has(p)) skipped.push({ path: p, why: 'changed on main since the rescue (e.g. drained or moved)' });
    else restore.push(p);
  }
  return { restore, skipped, keepForHuman: modified.length > 0 };
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

function cliReplay(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  const maxAgeDays = Number((args.find((a) => a.startsWith('--max-age-days=')) || '--max-age-days=14').split('=')[1]);
  const refs = listRescueRefs();
  const manifest = { refs: [] };
  if (refs.length === 0) console.log('push-rescue: no rescue branches');
  for (const { sha, ref, info } of refs) {
    if (!info) { console.log(`::warning::push-rescue: ignoring malformed branch ${ref}`); continue; }
    if (Date.now() - info.at > maxAgeDays * 86400000) {
      console.log(`::warning::push-rescue: ${ref} is older than ${maxAgeDays} days; pruning without replay`);
      manifest.refs.push({ ref, restored: [], skipped: [], stale: true });
      continue;
    }
    gitOk(['fetch', '--no-tags', '--depth=1', 'origin', sha, info.base], { timeout: netTimeoutMs() * 2 });
    const baseTime = Number(gitOk(['show', '-s', '--format=%ct', info.base]).trim());
    // Main's history since the rescue's base, so a path a later commit
    // drained or moved is seen as touched instead of absent.
    gitOk(['fetch', '--no-tags', `--shallow-since=${new Date((baseTime - 3600) * 1000).toISOString()}`, 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 3 });
    const rows = parseNameStatusZ(gitOk(['diff', '--name-status', '-z', '--no-renames', info.base, sha]));
    const adds = recoverableAdds(rows);
    const modified = rows.filter((r) => r.status !== 'A').map((r) => r.path);
    const onMain = new Set(adds.filter((p) => git(['cat-file', '-e', `origin/main:${p}`]).status === 0));
    const touched = new Set(adds.filter((p) => !onMain.has(p)
      && gitOk(['log', '-1', '--format=%H', `--since=${baseTime}`, 'origin/main', '--', p]).trim() !== ''));
    const plan = replayPlan({ adds, modified, onMain, touchedOnMain: touched });
    for (const p of plan.restore) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, gitOk(['show', `${sha}:${p}`]));
    }
    console.log(`push-rescue: ${ref}: restoring ${plan.restore.length}, skipping ${plan.skipped.length}${plan.keepForHuman ? `, ${modified.length} modified/deleted path(s) left on the branch` : ''}`);
    for (const s of plan.skipped) console.log(`  skip ${s.path}: ${s.why}`);
    manifest.refs.push({ ref, restored: plan.restore, skipped: plan.skipped, keepForHuman: plan.keepForHuman, modified: modified.slice(0, 50) });
  }
  // The real cross-show ownership gate, untracked-file mode: deletes any
  // restored review whose URL another show now owns.
  if (manifest.refs.some((r) => r.restored.length)) {
    const gate = spawnSync(process.execPath, [path.join(__dirname, '..', 'validate-added-review-ownership.js')], { stdio: 'inherit' });
    if (gate.status !== 0) throw new Error(`validate-added-review-ownership.js exited ${gate.status}; refusing to push unchecked restores`);
    for (const r of manifest.refs) {
      r.dropped = r.restored.filter((p) => !fs.existsSync(p));
      r.restored = r.restored.filter((p) => fs.existsSync(p));
    }
  }
  if (manifestPath) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const n = manifest.refs.reduce((a, r) => a + r.restored.length, 0);
  console.log(`push-rescue: restored ${n} file(s) from ${manifest.refs.length} branch(es)`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `restored=${n}\nbranches=${manifest.refs.length}\n`);
}

/** Branches safe to delete: every restored file is on main, nothing left for a human. */
function prunable(manifest, isOnMain) {
  return (manifest.refs || []).filter((r) => r.stale || (!r.keepForHuman && r.restored.every(isOnMain)));
}

function cliPrune(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  gitOk(['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 2 });
  const onMain = (p) => git(['cat-file', '-e', `origin/main:${p}`]).status === 0;
  const ok = prunable(manifest, onMain);
  for (const r of ok) {
    gitOk(['push', 'origin', '--delete', `refs/heads/${r.ref}`], { timeout: netTimeoutMs() });
    console.log(`push-rescue: deleted ${r.ref}`);
  }
  const kept = (manifest.refs || []).filter((r) => !ok.includes(r));
  for (const r of kept) {
    console.log(`::warning::push-rescue: kept ${r.ref}: ${r.keepForHuman ? `it also modified/deleted ${r.modified.length} path(s), which need a human (${r.modified.slice(0, 5).join(', ')})` : 'a restored file is not on main yet; the next run retries'}`);
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
