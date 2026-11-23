'use strict';
/**
 * mac-disk-digest.js (BRO-8178): one morning-digest line showing this Mac's
 * free disk, how many worktrees exist (job-* / total) and the three biggest
 * consumers, so worktree growth is visible days before bsc-runner's disk
 * floor starts refusing dispatches (2026-11-23: 59 job worktrees at ~800MB,
 * disk at 3GB, dispatch refused, nothing in the digest said why).
 * The alarm rows stay in disk-space-digest.js; this line is informational.
 *
 * The email is sent from GitHub Actions with --skip-mac-local, which cannot
 * see this Mac's disk. So the Mac posts the line as a commit status on
 * origin/main (context mac/disk, same channel as mac-applied-heartbeat.js),
 * at most every POST_EVERY_MS, from the end of a real gc-merged-worktrees.sh
 * run, and the digest reads the newest one back (readMacDiskStatus).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function fmtGb(kb) {
  const gb = kb / 1024 / 1024;
  return gb >= 10 ? `${Math.round(gb)}GB` : `${gb.toFixed(1)}GB`;
}

/**
 * Pure.
 * @param {{freeGb:number|null, worktrees:{total:number, job:number}, sizes:{label:string, kb:number}[]|null}} o
 */
function macDiskLine({ freeGb, worktrees, sizes }) {
  const free = Number.isFinite(freeGb) ? `${freeGb}GB free` : 'free space unknown';
  const wt = `${worktrees.total} worktrees (${worktrees.job} job)`;
  let top = 'biggest consumers unavailable';
  if (Array.isArray(sizes) && sizes.length) {
    top = `biggest: ${[...sizes].sort((a, b) => b.kb - a.kb).slice(0, 3).map((s) => `${s.label} ${fmtGb(s.kb)}`).join(', ')}`;
  }
  return `Mac disk: ${free}, ${wt}; ${top}.`;
}

function listWorktrees(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => path.resolve(p) !== path.resolve(repo));
  } catch { return []; }
}

/** I/O. `repos` = main checkouts whose worktrees count. Never throws. */
function collectMacDisk({ repos = [], home = os.homedir(), duTimeoutMs = 120000 } = {}) {
  let freeGb = null;
  if (!repos.length) return { freeGb, worktrees: { total: 0, job: 0 }, sizes: null };
  try {
    const df = execFileSync('df', ['-Pk', repos[0]], { encoding: 'utf8', timeout: 10000 });
    const avail = Number(df.trim().split('\n')[1].split(/\s+/)[3]);
    if (Number.isFinite(avail)) freeGb = Math.floor(avail / 1024 / 1024);
  } catch { /* unknown */ }
  const wts = repos.flatMap(listWorktrees).filter((p) => fs.existsSync(p));
  const worktrees = { total: wts.length, job: wts.filter((p) => path.basename(p).startsWith('job-')).length };
  const extras = [
    ['DerivedData', path.join(home, 'Library/Developer/Xcode/DerivedData')],
    ['Caches', path.join(home, 'Library/Caches')],
  ].filter(([, p]) => fs.existsSync(p));
  let sizes = null;
  // Short labels: the line must fit a 140-char commit-status description.
  const label = (p) => path.basename(p).replace(/^job-linear-(BRO-\d+)-.*$/, 'job $1');
  const targets = [...wts.map((p) => [label(p), p]), ...extras];
  if (targets.length) {
    let out = '';
    try {
      out = execFileSync('du', ['-sk', ...targets.map(([, p]) => p)], { encoding: 'utf8', timeout: duTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      out = err && typeof err.stdout === 'string' ? err.stdout : ''; // du exits 1 on an unreadable file but still prints totals
    }
    const byPath = new Map(targets.map(([label, p]) => [p, label]));
    sizes = out.split('\n').map((l) => /^(\d+)\t(.+)$/.exec(l)).filter(Boolean)
      .map((m) => ({ label: byPath.get(m[2]) || path.basename(m[2]), kb: Number(m[1]) }));
    if (!sizes.length) sizes = null;
  }
  return { freeGb, worktrees, sizes };
}

const DISK_STATUS_CONTEXT = 'mac/disk';
const POST_EVERY_MS = 6 * 3600e3;
const READ_PAGES = 12; // x100 commits on main, ~17h at ~70 commits/h

/** Pure: GitHub caps a status description at 140 characters. */
function statusDescription(line) {
  const t = String(line || '').replace(/\s+/g, ' ').trim();
  return t.length <= 140 ? t : `${t.slice(0, 139)}…`;
}

const READ_QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){ref(qualifiedName:"refs/heads/main"){target{... on Commit{history(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{status{context(name:"${DISK_STATUS_CONTEXT}"){description createdAt}}}}}}}}}`;

/** Newest mac/disk status on main: {line, at} or null. Never throws. */
async function readMacDiskStatus({ token, repo = 'thomaspryor/Broadwayscore', graphql } = {}) {
  try {
    const gq = graphql || require('./mac-applied-heartbeat.js').githubGraphql(token);
    const [owner, name] = String(repo).split('/');
    let after = null;
    for (let page = 0; page < READ_PAGES; page++) {
      const data = await gq(READ_QUERY, { owner, name, after });
      const history = data && data.repository && data.repository.ref && data.repository.ref.target && data.repository.ref.target.history;
      if (!history || !Array.isArray(history.nodes)) return null;
      for (const node of history.nodes) {
        const ctx = node && node.status && node.status.context;
        if (ctx && ctx.description) return { line: ctx.description, at: ctx.createdAt };
      }
      if (!history.pageInfo || !history.pageInfo.hasNextPage) return null;
      after = history.pageInfo.endCursor;
    }
    return null;
  } catch { return null; }
}

/** Pure: the digest's line from a status read (null = nothing recent). */
function digestLineFromStatus(st, now = new Date()) {
  if (!st) return 'Mac disk: no report from the Mac in the last ~17h (its worktree GC has not run, or it is off).';
  const ageH = Math.round((now.getTime() - Date.parse(st.at)) / 3600e3);
  return Number.isFinite(ageH) ? `${st.line} (measured ${ageH}h ago)` : st.line;
}

// CLI (Mac): node scripts/lib/mac-disk-digest.js --post [--dry-run] [--repo=<main checkout>]
function postCli(argv) {
  const repoArg = argv.find((a) => a.startsWith('--repo='));
  const main = repoArg ? repoArg.slice(7) : path.resolve(__dirname, '../..');
  const dry = argv.includes('--dry-run');
  const git = (...a) => execFileSync('git', ['-C', main, ...a], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commonDir = git('rev-parse', '--git-common-dir');
  if (!path.isAbsolute(commonDir)) commonDir = path.join(main, commonDir);
  const stateFile = path.join(commonDir, 'mac-disk-status.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const now = Date.now();
  if (last && now - Date.parse(last.at) < POST_EVERY_MS) { console.log('mac/disk: posted recently, skipping'); return 0; }
  const repos = require('./worktree-gc-repos.js').getGcRepos().map((r) => r.path).filter((p) => fs.existsSync(p));
  const line = macDiskLine(collectMacDisk({ repos: repos.length ? repos : [main] }));
  const sha = git('rev-parse', 'origin/main');
  const desc = statusDescription(line);
  if (dry) { console.log(`mac/disk (dry-run) would post on ${sha.slice(0, 10)}: ${desc}`); return 0; }
  execFileSync('gh', ['api', '-X', 'POST', 'repos/thomaspryor/Broadwayscore/statuses/' + sha,
    '-f', 'state=success', '-f', `context=${DISK_STATUS_CONTEXT}`, '-f', `description=${desc}`], { stdio: 'pipe', timeout: 20000 });
  fs.writeFileSync(stateFile, `${JSON.stringify({ sha, at: new Date(now).toISOString(), line })}\n`);
  console.log(`mac/disk posted on ${sha.slice(0, 10)}: ${desc}`);
  return 0;
}

if (require.main === module) {
  try { process.exit(process.argv.includes('--post') ? postCli(process.argv.slice(2)) : 2); } catch (err) {
    console.error(`mac/disk post failed: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { macDiskLine, collectMacDisk, statusDescription, readMacDiskStatus, digestLineFromStatus, DISK_STATUS_CONTEXT };
