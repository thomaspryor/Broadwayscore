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
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cfg = require('../../next.config.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const LIMIT_BYTES = 1_000_000;
// data/ subdirectories a server function genuinely reads at runtime (keep them traced).
const RUNTIME_READ_DIRS = new Set([]);

function trackedDataDirSizes() {
  const out = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD', '--', 'data'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const sizes = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/);
    if (!m) continue;
    const parts = m[2].split('/');
    if (parts.length < 3) continue; // top-level data/*.json files: not a bulk dir
    sizes.set(parts[1], (sizes.get(parts[1]) || 0) + Number(m[1]));
  }
  return sizes;
}

function isExcluded(dir, excludes) {
  return excludes.includes(`data/${dir}/**`);
}

test('every tracked data/ dir over 1MB is excluded from function tracing or a declared runtime read', () => {
  const excludes = cfg.outputFileTracingExcludes['**/*'];
  const sizes = trackedDataDirSizes();
  assert.ok(sizes.size > 0, 'git ls-tree returned no data/ dirs');
  const offenders = [...sizes]
    .filter(([dir, bytes]) => bytes > LIMIT_BYTES && !isExcluded(dir, excludes) && !RUNTIME_READ_DIRS.has(dir))
    .map(([dir, bytes]) => `data/${dir}/ (${(bytes / 1e6).toFixed(1)}MB)`);
  assert.deepEqual(offenders, [], `add 'data/<dir>/**' to outputFileTracingExcludes in next.config.js (or RUNTIME_READ_DIRS if a server route reads it): ${offenders.join(', ')}`);
});

test('the BRO-8147 bulk dirs stay excluded', () => {
  const excludes = cfg.outputFileTracingExcludes['**/*'];
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
