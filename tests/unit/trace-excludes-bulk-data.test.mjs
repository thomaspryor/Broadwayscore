// BRO-8147: server routes that load scripts/lib (admin ingest -> review-normalization
// -> ... -> rebuild-all-reviews.js) reach modules with a static
// path.join(__dirname, '..', 'data'), so Next's file tracing (NFT) copies ALL of
// data/ into those functions. api/admin/ingest-review/detect reached 341MB, over
// Vercel's 250MB limit, and every production deploy failed from 2026-11-23 07:17Z.
//
// Class guard: every tracked data/ subdirectory over 1MB is either excluded from
// function tracing in next.config.js or listed below as read at runtime. A new
// bulk pipeline directory then fails here instead of breaking prod deploys.
// Sizes come from `git ls-tree` (tracked blobs), so this test never reads data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { topLevelDataOffenders } = createRequire(import.meta.url)('../../scripts/lib/trace-exclude-rules.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read the excludes from next.config.js source: require()-ing it runs
// writeSiteImageVersions(), which reads untracked data and makes this a live-data test.
function tracingExcludes() {
  const src = fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8');
  const start = src.indexOf('outputFileTracingExcludes');
  assert.ok(start >= 0, 'outputFileTracingExcludes missing from next.config.js');
  const block = src.slice(start, src.indexOf('],', start));
  return [...block.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
}

const LIMIT_BYTES = 1_000_000;
// data/ subdirectories a server function genuinely reads at runtime (keep them traced).
const RUNTIME_READ_DIRS = new Set([]);

// BRO-8165: top-level data/<file> over 10MB must be excluded too (data/*.json was
// skipped above), or be a file a server route reads at runtime.
const TOP_LEVEL_LIMIT_BYTES = 10_000_000;
// Read by server functions at runtime (pending-intake.js etc.); must stay traceable.
const RUNTIME_READ_FILES = new Set(['data/shows.json', 'data/reviews.json']);

// Tracked top-level blobs, plus whatever is on disk (private core data such as
// reviews.json / mezzanine-productions-raw.json is gitignored, so git ls-tree cannot see it).
function topLevelDataFiles() {
  const out = execFileSync('git', ['ls-tree', '-l', 'HEAD', '--', 'data/'], { cwd: ROOT, encoding: 'utf8' });
  const files = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/);
    if (m) files.push({ path: m[2], bytes: Number(m[1]) });
  }
  const dir = path.join(ROOT, 'data');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
      if (st && st.isFile()) files.push({ path: `data/${name}`, bytes: st.size });
    }
  }
  return files;
}

function trackedDataDirSizes() {
  const out = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD', '--', 'data'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const sizes = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/);
    if (!m) continue;
    const parts = m[2].split('/');
    if (parts.length < 3) continue; // top-level data/*.json files: see the top-level rule below
    sizes.set(parts[1], (sizes.get(parts[1]) || 0) + Number(m[1]));
  }
  return sizes;
}

function isExcluded(dir, excludes) {
  return excludes.includes(`data/${dir}/**`);
}

test('every tracked data/ dir over 1MB is excluded from function tracing or a declared runtime read', () => {
  const excludes = tracingExcludes();
  const sizes = trackedDataDirSizes();
  assert.ok(sizes.size > 0, 'git ls-tree returned no data/ dirs');
  const offenders = [...sizes]
    .filter(([dir, bytes]) => bytes > LIMIT_BYTES && !isExcluded(dir, excludes) && !RUNTIME_READ_DIRS.has(dir))
    .map(([dir, bytes]) => `data/${dir}/ (${(bytes / 1e6).toFixed(1)}MB)`);
  assert.deepEqual(offenders, [], `add 'data/<dir>/**' to outputFileTracingExcludes in next.config.js (or RUNTIME_READ_DIRS if a server route reads it): ${offenders.join(', ')}`);
});

test('the BRO-8147 bulk dirs stay excluded', () => {
  const excludes = tracingExcludes();
  for (const d of ['video-reviews-transcripts', 'pending-fixes', 'archive', 'aggregator-archive']) {
    assert.ok(isExcluded(d, excludes), `data/${d}/** missing from outputFileTracingExcludes`);
  }
});

test('no src file names an excluded bulk dir in a runtime fs read', () => {
  let hits = '';
  try {
    hits = execFileSync('git', ['grep', '-lE', '(readFile|readdir|existsSync|statSync).*(video-reviews-transcripts|pending-fixes|aggregator-archive|llm-scores|opening-night-monitor)', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status !== 1) throw e; // git grep exits 1 on no match
  }
  assert.equal(hits, '');
});

test('every top-level data/ file over 10MB is excluded from function tracing or a declared runtime read', () => {
  const offenders = topLevelDataOffenders(topLevelDataFiles(), tracingExcludes(), RUNTIME_READ_FILES, TOP_LEVEL_LIMIT_BYTES);
  assert.deepEqual(offenders, [], `add the file to outputFileTracingExcludes in next.config.js (or RUNTIME_READ_FILES if a server route reads it): ${offenders.join(', ')}`);
});

test('top-level rule: red on an unexcluded big file, green once excluded or declared (synthetic)', () => {
  const big = [{ path: 'data/new-bulk-dump.json', bytes: 60_000_000 }, { path: 'data/small.json', bytes: 1_000_000 }, { path: 'data/sub/deep.json', bytes: 90_000_000 }];
  assert.deepEqual(topLevelDataOffenders(big, ['data/archive/**'], RUNTIME_READ_FILES, TOP_LEVEL_LIMIT_BYTES), ['data/new-bulk-dump.json (60.0MB)']);
  assert.deepEqual(topLevelDataOffenders(big, ['data/new-bulk-dump.json'], [], TOP_LEVEL_LIMIT_BYTES), []);
  assert.deepEqual(topLevelDataOffenders(big, [], ['data/new-bulk-dump.json'], TOP_LEVEL_LIMIT_BYTES), []);
  // glob excludes used in next.config.js
  assert.deepEqual(topLevelDataOffenders([{ path: 'data/reviews.json.pre-symlink-backup', bytes: 13_500_000 }], ['data/*.pre-symlink-backup'], [], TOP_LEVEL_LIMIT_BYTES), []);
  // recursive globs match zero directories too (BRO-8165 review)
  assert.deepEqual(topLevelDataOffenders([{ path: 'data/large.json', bytes: 20_000_000 }], ['data/**/*.json'], [], TOP_LEVEL_LIMIT_BYTES), []);
  // exactly at the limit passes
  assert.deepEqual(topLevelDataOffenders([{ path: 'data/x.json', bytes: TOP_LEVEL_LIMIT_BYTES }], [], [], TOP_LEVEL_LIMIT_BYTES), []);
});
