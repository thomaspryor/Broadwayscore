#!/usr/bin/env node
'use strict';
//
// tsc-stamp.js — job-local "tsc already passed on this exact tree" stamp for
// scripts/hooks/pre-push (BRO-5783).
//
// WHY
//   land.yml's Land job pushes `HEAD:main` while holding the landing mutex.
//   The pre-push hook runs `npx tsc --noEmit` (66-80s) on EVERY push attempt,
//   including the re-push after main moved only across inert paths
//   (scripts/lib/land-branch.js: classifyIntervening === 'inert'). The code
//   tree is byte-identical on that retry, so the second tsc proves nothing.
//
// KEY
//   sha256( computeCodeTreeHash(HEAD) + tracked top-level data/*.json blobs
//   + nested data/**/*.json paths that src/ names ).
//   computeCodeTreeHash drops data/ (inert for verification), but tsc reads
//   data/*.json through resolveJsonModule, so those blobs are added back: a
//   bot commit that reshapes a JSON file changes the key and tsc runs again.
//
// SAFETY (every doubt runs tsc — fail open)
//   - Only inside a CI landing: GITHUB_ACTIONS=true AND LAND_TSC_STAMP_FILE set.
//   - Only when exactly one non-delete spec is pushed, to refs/heads/main, and
//     its oid IS HEAD (tsc type-checks the working tree, so HEAD must be it).
//   - The stamp is written only after tsc exits 0; compared as full 64-hex.
//   - check/record both refuse on a dirty tracked tree: tsc then saw HEAD plus
//     residue (a prebuild regenerates tracked files), not HEAD's own tree.
//   - ASSUMED constant within one job, so not in the key: gitignored core data
//     (data/reviews.json, shows.json, ...), node_modules, .next/types. The
//     stamp file lives in $RUNNER_TEMP, so it never outlives its job.
//
// SEEDING FROM THE checks JOB (BRO-6043)
//   The stamp file is job-local, so the FIRST push under the mutex still paid
//   tsc although the checks job's gauntlet had typechecked that very tree.
//   `seed-export` (checks job) prints "<key>:<dataDigest>" ONLY when the branch
//   gauntlet's meta.json says tsc exited 0 on exactly the rebased sha and the
//   tracked tree is clean; the Land job passes that string to `seed`, which
//   appends the key to its stamp file ONLY when its own gitignored core data
//   hashes to the same digest (the assumption "constant within one job" does
//   not hold across two jobs: each clones core data fresh). `digest-pre` runs
//   before the gauntlet and seed-export refuses unless the digest is unchanged
//   after it. The gauntlet records the tracked files that differed from HEAD
//   when tsc started (tsc-tree-status); anything beyond TSC_INERT_RESIDUE
//   refuses the seed. A Land-job tree
//   that differs in code (main moved substantively) just has a different key
//   and still runs tsc. The gauntlet exit is the raw tsc exit, not the
//   base-delta verdict: a tsc red forgiven because base is red never seeds.
//
// HOOK-TAIL STAMP (BRO-6508)
//   With tsc skipped, a retry push still re-ran the rest of the hook tail
//   (run-push-audits.sh + lint-workflow-guards.sh, ~30s local, ~50s on CI).
//   Bots land on main about once a minute, so that window lost most retry
//   races ("cannot lock ref") and long holds burned the churn budget.
//   `hook-check`/`hook-record` stamp "audits + workflow lints passed" as
//   `hook:<key>` lines in the same file, under the same decide() rules. tsc
//   keeps its own stamp above, so a bot rewrite of a top-level data/*.json
//   re-runs tsc without re-running the audits. hookKey() hashes every tracked
//   path+blob except bot churn (HOOK_TREE_SKIP_RE; no audit or lint reads those
//   contents, bar an advisory-only scan), the pushed file list, and HEAD's
//   message ([skip-cron-audit]/[skip-actionlint]/[skip-demo-flag-check] read
//   `git log -1`). Root .txt allowlists stay in, although the verdict logic
//   calls them inert. ASSUMED constant within one job, as above, plus: the
//   PATH (actionlint) and no GH_TOKEN in the Land step (audit-workflow-hygiene
//   calls the API only with a token). Kill switch: LAND_TSC_STAMP_DISABLED=1
//   blanks the stamp file, which turns off both stamps.
//
// HOOK PRE-WARM (BRO-6519)
//   The FIRST push under the mutex still paid the whole tail. The checks job
//   now runs the real pre-push hook on the rebased tip (outside the mutex),
//   `hook-seed-export` prints "<hookKey>:<dataDigest>" when that run recorded
//   the key, and the Land job's `hook-seed` appends `hook:<key>` when its own
//   core data hashes the same (decideSeed, as for tsc). The pushed file list in
//   the key is the branch diff in both jobs (main..rebased tip), and the tip
//   message survives the rebase. The checks job has actionlint on PATH and the
//   Land step does not, so the pre-warm is the stricter run. The hook stamp's
//   dirty-tree check ignores the paths the key leaves out (hookDirtyLines).
//   Kill switch: the same LAND_TSC_STAMP_DISABLED=1.

const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { computeCodeTreeHash } = require('./land-gate-delta');

const SHA40 = /^[0-9a-f]{40}$/;
const HASH64 = /^[0-9a-f]{64}$/;

/** Pure decision. Returns { skip, reason }. */
function decide({ env = {}, headOid, pushedOid, specCount, remoteRef, key, stampLines }) {
  const run = (reason) => ({ skip: false, reason });
  if (env.GITHUB_ACTIONS !== 'true') return run('not a CI landing');
  if (!env.LAND_TSC_STAMP_FILE) return run('no LAND_TSC_STAMP_FILE');
  if (specCount !== 1) return run(`${specCount} push specs (need exactly 1)`);
  if (remoteRef !== 'refs/heads/main') return run(`push target ${remoteRef} is not refs/heads/main`);
  if (!SHA40.test(String(headOid || '')) || /^0+$/.test(headOid) || headOid !== pushedOid) return run('pushed oid is not HEAD');
  if (!HASH64.test(String(key || ''))) return run('no usable tree key');
  if (!(stampLines || []).includes(key)) return run('no matching stamp (tree not yet typechecked)');
  return { skip: true, reason: `tsc already passed on this code tree (${key.slice(0, 12)})` };
}

const HOOK_TREE_SKIP_RE = /^(data\/|public\/(data|images)\/)/;

/** Pure: key for "the pre-push audits + workflow lints passed". lsTree = `git ls-tree -r HEAD` output. */
function hookKey({ lsTree, changedFiles, tipMessage }) {
  const tree = String(lsTree || '').split('\n').filter((l) => {
    const path = l.split('\t')[1];
    return path && !HOOK_TREE_SKIP_RE.test(path);
  });
  if (!tree.length) return '';
  const files = [...new Set(String(changedFiles || '').split('\n').map((f) => f.trim()).filter(Boolean))].sort();
  return crypto.createHash('sha256')
    .update(['pre-push-tail', '--tree', ...tree, '--files', ...files, '--tip', String(tipMessage || '')].join('\n'))
    .digest('hex');
}

/** Pure: the tsc decide() rules applied to `hook:` stamp lines. */
function decideHook({ stampLines, ...rest }) {
  const lines = (stampLines || []).filter((l) => l.startsWith('hook:')).map((l) => l.slice(5));
  const d = decide({ ...rest, stampLines: lines });
  if (d.skip) return { skip: true, reason: `audits + workflow lints already passed on this tree (${rest.key.slice(0, 12)})` };
  return d.reason.startsWith('no matching stamp') ? { skip: false, reason: 'no matching hook stamp (tail not yet run on this tree)' } : d;
}

/**
 * Pure: the `git status --porcelain` lines that make a tree too dirty for the
 * hook stamp. Paths the hook key leaves out (HOOK_TREE_SKIP_RE: no audit or
 * lint reads them) do not count, so the checks job's gold-lists prep residue
 * (data/gold-lists-computed.json) does not block the pre-warm (BRO-6519).
 */
function hookDirtyLines(porcelain) {
  return String(porcelain || '').split('\n').filter((l) => {
    if (!l.trim()) return false;
    // A rename counts when either name is outside the skipped paths.
    return l.slice(3).split(' -> ').some((p) => !HOOK_TREE_SKIP_RE.test(p.replace(/^"|"$/g, '')));
  });
}

/**
 * checks-job side of the hook pre-warm (BRO-6519). Pure: { seed, reason }.
 * The pre-warm ran the real pre-push hook on the rebased tip with a fresh
 * stamp file; export "<hookKey>:<dataDigest>" only when that run recorded the
 * key recomputed here, on exactly the rebased sha, with core data unchanged
 * since before it ran (the audits may read it; the Land job's decideSeed then
 * requires its own core data to hash the same).
 */
function decideHookSeedExport({ rebased, headOid, key, stampLines, digest, preDigest }) {
  const no = (reason) => ({ seed: '', reason });
  if (!SHA40.test(String(rebased || '')) || headOid !== rebased) return no('HEAD is not the rebased sha');
  if (!HASH64.test(String(key || ''))) return no('no usable hook key');
  if (!(stampLines || []).includes(`hook:${key}`)) return no('the pre-warm did not record this tree (hook red or skipped)');
  if (!HASH64.test(String(digest || '')) || !HASH64.test(String(preDigest || ''))) return no('no usable core-data digest');
  if (preDigest !== digest) return no('core data changed during the pre-warm');
  return { seed: `${key}:${digest}`, reason: `hook tail passed on rebased ${rebased.slice(0, 10)}` };
}

/** Nested data JSON paths named anywhere under src/ (a superset of what tsc imports). */
function srcReferencedDataJson(sha, cwd) {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-hoE', 'data/[A-Za-z0-9_./-]+\\.json', sha, '--', 'src'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match
  }
  return [...new Set(out.split('\n').map((l) => l.replace(/^[0-9a-f]{40}:/, '').trim()).filter((l) => l.startsWith('data/') && l.indexOf('/', 5) !== -1))].sort();
}

/** Stamp key for the commit `sha`. Throws on any git failure (callers fail open). */
function computeKey(sha, { cwd = process.cwd(), lsTreeData = null } = {}) {
  const { hash } = computeCodeTreeHash(sha, { cwd });
  const gitLs = (args) => execFileSync('git', ['ls-tree', sha, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const top = lsTreeData ? lsTreeData(sha) : gitLs(['data/']);
  const nested = lsTreeData ? [] : srcReferencedDataJson(sha, cwd);
  const nestedListing = nested.length ? gitLs(['--', ...nested]) : '';
  const h = crypto.createHash('sha256');
  h.update(hash);
  for (const line of `${top}\n${nestedListing}`.split('\n')) {
    if (/\tdata\/.+\.json$/.test(line) && (/\tdata\/[^/]+\.json$/.test(line) || nested.some((n) => line.endsWith(`\t${n}`)))) { h.update(line); h.update('\n'); }
  }
  return h.digest('hex');
}

/**
 * Digest of the gitignored core data on disk (data/**.json that git ignores,
 * minus the review-texts corpus). tsc reads these through resolveJsonModule and
 * two jobs clone them at different moments, so differing digests => no seeding.
 * Working-tree only (no blob fetch), so it is cheap in a blob:none checkout.
 */
function dataDigest({ cwd = process.cwd() } = {}) {
  const out = execFileSync('git', ['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', 'data'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = out.split('\0').filter((f) => f.endsWith('.json') && !f.startsWith('data/review-texts/') && fs.existsSync(`${cwd}/${f}`)).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f); h.update('\0');
    h.update(crypto.createHash('sha256').update(fs.readFileSync(`${cwd}/${f}`)).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex');
}

/** checks-job side. Pure: returns { seed, reason } from the gauntlet meta + tree facts. */
// Tracked files the gauntlet's prep regenerates before tsc (land-gauntlet.sh
// gold-lists prep) that tsc cannot be sensitive to: their ONLY src importer
// casts through `unknown` (guarded by tsc-stamp.test.mjs), so regenerated
// content cannot change a type-check result.
const TSC_INERT_RESIDUE = new Set(['data/gold-lists-computed.json']);

function decideSeedExport({ meta, rebased, headOid, residue, key, digest, preDigest }) {
  const no = (reason) => ({ seed: '', reason });
  if (!meta || typeof meta !== 'object') return no('no gauntlet meta.json');
  if (!SHA40.test(String(rebased || '')) || meta.sha !== rebased) return no('gauntlet did not measure the rebased sha');
  if (headOid !== rebased) return no('HEAD is not the rebased sha');
  if (!meta.exits || meta.exits.tsc !== 0) return no('tsc did not exit 0 in the gauntlet');
  // residue = tracked paths differing from HEAD when tsc STARTED (null = unknown).
  if (!Array.isArray(residue)) return no('no tsc-time tree status');
  const bad = residue.filter((f) => !TSC_INERT_RESIDUE.has(f));
  if (bad.length) return no(`tsc saw tracked residue: ${bad.slice(0, 3).join(', ')}`);
  if (!HASH64.test(String(key || '')) || !HASH64.test(String(digest || ''))) return no('no usable key/digest');
  // Taken BEFORE the gauntlet (digest-pre): proves the data tsc read is the
  // data we certify.
  if (!HASH64.test(String(preDigest || ''))) return no('no pre-gauntlet digest');
  if (preDigest !== digest) return no('core data changed during the gauntlet');
  return { seed: `${key}:${digest}`, reason: `tsc exit 0 on rebased ${rebased.slice(0, 10)}` };
}

/** Land-job side. Pure: returns { key, reason } (key '' = do not seed). */
function decideSeed({ env = {}, seed, digest }) {
  const no = (reason) => ({ key: '', reason });
  if (env.GITHUB_ACTIONS !== 'true') return no('not a CI landing');
  if (!env.LAND_TSC_STAMP_FILE) return no('no LAND_TSC_STAMP_FILE');
  const m = /^([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(seed || ''));
  if (!m) return no('no seed from the checks job');
  if (!HASH64.test(String(digest || '')) || m[2] !== digest) return no('core data differs from the checks job');
  return { key: m[1], reason: `seeded ${m[1].slice(0, 12)} from the checks job` };
}

function readStamp(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const a = {};
  for (const t of rest) { const m = /^--([^=]+)=(.*)$/.exec(t); if (m) a[m[1]] = m[2]; }
  const env = process.env;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const file = env.LAND_TSC_STAMP_FILE || '';
    const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    // TSC_INERT_RESIDUE (gold-lists prep) is not dirt for tsc either: the same
    // rule seed-export already applies (BRO-6519: the checks-job pre-warm runs
    // the hook after the gauntlet left it dirty, and must not re-run tsc).
    const dirty = porcelain.split('\n').filter((l) => l.trim() && !TSC_INERT_RESIDUE.has(l.slice(3))).join('\n');
    if (dirty && ['check', 'record'].includes(cmd)) { console.error('tsc-stamp: run checks (dirty tracked tree)'); return cmd === 'check' ? 1 : 0; }
    const hookDirty = hookDirtyLines(porcelain).length > 0; // untrimmed: each line's 3-char status prefix
    if (hookDirty && ['hook-check', 'hook-record', 'hook-seed-export'].includes(cmd)) { console.error('tsc-stamp: run hook checks (dirty tracked tree)'); return cmd === 'hook-check' ? 1 : 0; }
    const liveHookKey = () => hookKey({
      lsTree: execFileSync('git', ['ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
      changedFiles: fs.readFileSync(0, 'utf8'),
      tipMessage: execFileSync('git', ['log', '-1', '--format=%B', 'HEAD'], { encoding: 'utf8' }),
    });
    if (cmd === 'hook-check') {
      const args = { env, headOid: head, pushedOid: a['pushed-oid'], specCount: Number(a['spec-count']), remoteRef: a['remote-ref'] };
      const pre = decide({ ...args, key: 'a'.repeat(64), stampLines: ['a'.repeat(64)] });
      if (!pre.skip) { console.error(`tsc-stamp: run hook checks (${pre.reason})`); return 1; }
      const d = decideHook({ ...args, key: liveHookKey(), stampLines: readStamp(file) });
      console.error(`tsc-stamp: ${d.skip ? 'SKIP hook checks' : 'run hook checks'} (${d.reason})`);
      return d.skip ? 0 : 1;
    }
    if (cmd === 'hook-record') {
      if (env.GITHUB_ACTIONS !== 'true' || !file) return 0;
      const key = liveHookKey();
      if (key) fs.appendFileSync(file, `hook:${key}\n`);
      return 0;
    }
    if (cmd === 'hook-seed-export') {
      let preD = '';
      try { preD = fs.readFileSync(a.pre || '', 'utf8').trim(); } catch { /* decide reports it */ }
      const d = decideHookSeedExport({ rebased: a.rebased, headOid: head, key: liveHookKey(), stampLines: readStamp(file), digest: dataDigest(), preDigest: preD });
      console.error(`tsc-stamp: hook ${d.seed ? 'seed exported' : 'no seed'} (${d.reason})`);
      if (d.seed) console.log(d.seed);
      return 0;
    }
    if (cmd === 'hook-seed') {
      if (!a.seed) { console.error('tsc-stamp: hook not seeded (checks job exported none)'); return 0; }
      const d = decideSeed({ env, seed: a.seed, digest: dataDigest() });
      console.error(`tsc-stamp: hook ${d.key ? 'seeded' : 'not seeded'} (${d.reason})`);
      if (d.key) fs.appendFileSync(file, `hook:${d.key}\n`);
      return 0;
    }
    if (cmd === 'digest-pre') {
      if (a.out) fs.writeFileSync(a.out, `${dataDigest()}\n`);
      return 0;
    }
    if (cmd === 'seed-export') {
      let preD = '';
      try { preD = fs.readFileSync(a.pre || '', 'utf8').trim(); } catch { /* decide() reports it */ }
      let residue = null;
      try { residue = fs.readFileSync(a['tree-status'] || '', 'utf8').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '')); } catch { /* decide() reports it */ }
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(a.meta || '', 'utf8')); } catch { /* decide() reports it */ }
      const pre = decideSeedExport({ meta, rebased: a.rebased, headOid: head, residue, key: 'a'.repeat(64), digest: 'b'.repeat(64), preDigest: 'b'.repeat(64) });
      if (!pre.seed) { console.error(`tsc-stamp: no seed (${pre.reason})`); return 0; }
      const d = decideSeedExport({ meta, rebased: a.rebased, headOid: head, residue, key: computeKey(head), digest: dataDigest(), preDigest: preD });
      console.error(`tsc-stamp: ${d.seed ? 'seed exported' : 'no seed'} (${d.reason})`);
      if (d.seed) console.log(d.seed);
      return 0;
    }
    if (cmd === 'seed') {
      if (!a.seed) { console.error('tsc-stamp: no seed (checks job exported none)'); return 0; }
      const d = decideSeed({ env, seed: a.seed, digest: dataDigest() });
      console.error(`tsc-stamp: ${d.key ? 'seeded' : 'not seeded'} (${d.reason})`);
      if (d.key) fs.appendFileSync(file, `${d.key}\n`);
      return 0;
    }
    if (cmd === 'check') {
      const pre = decide({ env, headOid: head, pushedOid: a['pushed-oid'], specCount: Number(a['spec-count']), remoteRef: a['remote-ref'], key: 'a'.repeat(64), stampLines: ['a'.repeat(64)] });
      if (!pre.skip) { console.error(`tsc-stamp: run tsc (${pre.reason})`); return 1; }
      const key = computeKey(head);
      const d = decide({ env, headOid: head, pushedOid: a['pushed-oid'], specCount: Number(a['spec-count']), remoteRef: a['remote-ref'], key, stampLines: readStamp(file) });
      console.error(`tsc-stamp: ${d.skip ? 'SKIP tsc' : 'run tsc'} (${d.reason})`);
      return d.skip ? 0 : 1;
    }
    if (cmd === 'record') {
      if (env.GITHUB_ACTIONS !== 'true' || !file) return 0;
      fs.appendFileSync(file, `${computeKey(head)}\n`);
      return 0;
    }
  } catch (e) {
    console.error(`tsc-stamp: run tsc (fail-open: ${e.message})`);
    return cmd === 'check' || cmd === 'hook-check' ? 1 : 0;
  }
  console.error('usage: tsc-stamp.js check|record|hook-check|hook-record|hook-seed-export|hook-seed|digest-pre|seed-export|seed [--pushed-oid=X --spec-count=N --remote-ref=R]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { TSC_INERT_RESIDUE, HOOK_TREE_SKIP_RE, decide, decideHook, hookKey, hookDirtyLines, decideHookSeedExport, computeKey, readStamp, dataDigest, decideSeedExport, decideSeed };
