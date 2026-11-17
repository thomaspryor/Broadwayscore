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

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** -> true when origin holds an unexpired marker for this id. Any error -> false. */
function hasDurableApproval(cwd, id, { now = new Date(), run = (a) => git(cwd, a, { timeout: NET_TIMEOUT_MS }) } = {}) {
  if (!id) return false;
  try {
    const cutoff = ymd(new Date(now.getTime() - TTL_DAYS * 86400000));
    return run(['ls-remote', 'origin', `${PREFIX}*-${id}`]).split('\n').some((l) => {
      const m = l.match(/refs\/heads\/visual-approved\/(\d{8})-(\w+)$/);
      return !!m && m[2] === id && m[1] >= cutoff;
    });
  } catch { return false; }
}

/** Push HEAD as the marker. verdictId must equal the current id, so only the approved diff is minted. -> boolean */
function mintDurableApproval(cwd, ref, verdictId, { now = new Date(), run = (a) => git(cwd, a, { timeout: NET_TIMEOUT_MS }) } = {}) {
  const id = uiPatchId(cwd, ref);
  if (!id || !verdictId || verdictId !== id) return false;
  try {
    run(['push', '--no-verify', '-q', 'origin', `${ref}:${PREFIX}${ymd(now)}-${id}`]);
    return true;
  } catch { return false; }
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
module.exports = { uiPatchId, hasDurableApproval, mintDurableApproval, UI_RE, PREFIX, TTL_DAYS };
