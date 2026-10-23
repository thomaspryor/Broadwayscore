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
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    if (dirty) { console.error('tsc-stamp: run tsc (dirty tracked tree)'); return cmd === 'check' ? 1 : 0; }
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
    return cmd === 'check' ? 1 : 0;
  }
  console.error('usage: tsc-stamp.js check|record [--pushed-oid=X --spec-count=N --remote-ref=R]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { decide, computeKey, readStamp };
