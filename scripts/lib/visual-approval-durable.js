#!/usr/bin/env node
/**
 * visual-approval-durable.js: an owner-approved UI diff that survives a container restart.
 *
 * The push gate's verdict and ledger live in gitignored .claude/visual-qa/, so a restart (or a fresh session on the
 * same branch) loses them and a test-only follow-up push re-blocks (BRO-7628: three blocked pushes, then NO-VERIFY).
 * This keeps one marker on origin: refs/heads/visual-approved/<YYYYMMDD>-<id>, where <id> is the --verbatim
 * patch-id of the UI-file diff (origin/main...ref). Same UI diff (whitespace and string literals included) =
 * same id; any UI edit = new id = re-blocked. Rules:
 *   - minted ONLY by the gate hook on its approved paths, and only when verdict.json's uiPatchId equals the
 *     current id (the verdict was made for exactly this diff). Never from NO-VERIFY / override paths.
 *   - accepted for TTL_DAYS (the ledger TTL), judged from the date in the ref name.
 *   - any git/network error means "no durable approval": the normal verdict flow runs (never fail-open to allow).
 *   - a plain branch is only as trustworthy as push access, the same trust as the NO-VERIFY comment bypass.
 *
 * CLI: node visual-approval-durable.js id    --repo R --ref REF       -> prints the id (or nothing)
 *      node visual-approval-durable.js check --repo R --ref REF       -> exit 0 approved, 1 not
 *      node visual-approval-durable.js mint  (env VISUAL_GATE_MINT=1) --repo R --ref REF --verdict-id ID   -> exit 0 minted, 1 not
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');

const UI_RE = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)/;
const PREFIX = 'refs/heads/visual-approved/';
const LOCAL_PREFIX = 'refs/visual-approved-local/'; // BRO-8164: same marker, kept in this repo's shared git dir
const TTL_DAYS = 7;
const NET_TIMEOUT_MS = 12000;

const git = (cwd, args, o = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();

/** Verbatim patch-id of the UI-file diff base...ref, or null (no UI change / any error). */
function uiPatchId(cwd, ref = 'HEAD', base = 'origin/main') {
  try {
    const files = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${ref}`]).split('\n').filter((f) => UI_RE.test(f));
    if (!files.length) return null;
    const diff = git(cwd, ['diff', '--binary', `${base}...${ref}`, '--', ...files]);
    if (!diff) return null;
    const out = execFileSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', cwd, maxBuffer: 256 * 1024 * 1024 }).trim();
    return out ? out.split(/\s+/)[0].slice(0, 20) : null;
  } catch { return null; }
}

/**
 * Same id as uiPatchId() for the WORKING TREE (BRO-8164): sessions screenshot before committing, so the verdict used to
 * carry no id and the durable marker never minted. Diffs <merge-base> against the working-tree content of the UI files
 * (tracked changes AND untracked new UI files); the same content committed gives the same id. '' on any error/no UI change.
 * Untracked UI files (a new component) used to return '': the verdict had no id, the marker never minted, and every
 * restart or re-screenshot asked the owner again. They are now marked intent-to-add in a THROWAWAY index (the real
 * index is never touched), so their full content is in the diff exactly as a commit would show it.
 */
function uiPatchIdWorkingTree(cwd, base = 'origin/main') {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  let tmp = '';
  try {
    const mb = git(cwd, ['merge-base', base, 'HEAD']);
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter((f) => UI_RE.test(f));
    let env;
    if (untracked.length) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-pid-'));
      const idx = path.join(tmp, 'index');
      const real = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      if (fs.existsSync(real)) fs.copyFileSync(real, idx);
      env = { ...process.env, GIT_INDEX_FILE: idx };
      git(cwd, ['add', '-N', '--', ...untracked], { env });
    }
    const o = env ? { env } : {};
    const files = git(cwd, ['diff', '--name-only', '--no-renames', mb], o).split('\n').filter((f) => UI_RE.test(f));
    if (!files.length) return '';
    const diff = git(cwd, ['diff', '--binary', '--no-renames', mb, '--', ...files], o);
    if (!diff) return '';
    const out = execFileSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', cwd, maxBuffer: 256 * 1024 * 1024 }).trim();
    return out ? out.split(/\s+/)[0].slice(0, 20) : '';
  } catch { return ''; } finally { if (tmp) { try { require('fs').rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } } }
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** Pure: does any marker ref name (remote or local) carry this id with a date on/after the TTL cutoff? */
function markerMatches(refLines, id, now = new Date()) {
  if (!id) return false;
  const cutoff = ymd(new Date(now.getTime() - TTL_DAYS * 86400000));
  return String(refLines || '').split('\n').some((l) => {
    const m = l.match(/refs\/(?:heads\/visual-approved|visual-approved-local)\/(\d{8})-(\w+)$/);
    return !!m && m[2] === id && m[1] >= cutoff;
  });
}

/**
 * -> true when this repo (local marker, BRO-8164) or origin holds an unexpired marker for this id. Any error -> false.
 * The local marker lives under refs/visual-approved-local/ (outside refs/heads, so no push ships it) in the shared git
 * dir, so every worktree on this machine sees it, and an approval holds even when the origin push failed or was killed.
 */
function hasDurableApproval(cwd, id, { now = new Date(), run = (a) => git(cwd, a, { timeout: NET_TIMEOUT_MS }) } = {}) {
  if (!id) return false;
  try { if (markerMatches(run(['for-each-ref', '--format=%(refname)', LOCAL_PREFIX]), id, now)) return true; } catch { /* fall to origin */ }
  try { return markerMatches(run(['ls-remote', 'origin', `${PREFIX}*-${id}`]), id, now); } catch { return false; }
}

/** Record HEAD as the marker (local ref, then origin). verdictId must equal the current id, so only the approved diff is minted. -> boolean */
function mintDurableApproval(cwd, ref, verdictId, { now = new Date(), run = (a) => git(cwd, a, { timeout: NET_TIMEOUT_MS }) } = {}) {
  const id = uiPatchId(cwd, ref);
  if (!id || !verdictId || verdictId !== id) return false;
  let ok = false;
  try { run(['update-ref', `${LOCAL_PREFIX}${ymd(now)}-${id}`, ref]); ok = true; } catch { /* origin below */ }
  try { run(['push', '--no-verify', '-q', 'origin', `${ref}:${PREFIX}${ymd(now)}-${id}`]); ok = true; } catch { /* local may still hold */ }
  return ok;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = {};
  for (const a of rest) { const m = a.match(/^--([\w-]+)=(.*)$/); if (m) opt[m[1]] = m[2]; }
  const repo = opt.repo || process.cwd();
  const ref = opt.ref || 'HEAD';
  if (cmd === 'id') { const id = uiPatchId(repo, ref); if (id) console.log(id); return id ? 0 : 1; }
  if (cmd === 'check') return hasDurableApproval(repo, uiPatchId(repo, ref)) ? 0 : 1;
  if (cmd === 'mint' && process.env.VISUAL_GATE_MINT !== '1') { console.error('mint is run by pre-push-visual-gate.sh only'); return 1; }
  if (cmd === 'mint') return mintDurableApproval(repo, ref, opt['verdict-id']) ? 0 : 1;
  console.error('usage: visual-approval-durable.js id|check|mint --repo=R --ref=REF [--verdict-id=ID]');
  return 2;
}
if (require.main === module) require('./exit-flushed').exitFlushed(main(process.argv.slice(2)));
module.exports = { uiPatchId, uiPatchIdWorkingTree, hasDurableApproval, mintDurableApproval, markerMatches, UI_RE, PREFIX, LOCAL_PREFIX, TTL_DAYS };
