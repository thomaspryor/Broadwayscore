// BRO-7934 class guard: every code path that runs scripts/ingest-review-from-url.js names its
// caller (INGEST_CALLER or --caller), so no review file is written with no pipeline recorded.
// ingest-review-from-url.js itself exits 2 without a caller; this test fails earlier, in CI, for
// a NEW spawner that forgets, naming the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPAWN_RE = /ingest-review-from-url\.js['"`]?\s*[,\])]|node\s+scripts\/ingest-review-from-url\.js/;
const CALLER_RE = /INGEST_CALLER|--caller/;

// Emit a run-script plan or a command hint; execute-approved-fix.js (sets INGEST_CALLER) runs them.
// Each entry must name its driver, and the driver must set the caller (checked below).
const DRIVEN_BY = {
  'scripts/uk-regional-census-productions.js': 'scripts/execute-approved-fix.js',
  'scripts/uk-regional-census-match.js': 'scripts/execute-approved-fix.js',
  'scripts/lib/drain-unknown-outlets.js': 'scripts/drain-unknown-outlets.js',
  'scripts/lib/html-handoff.js': 'scripts/execute-approved-fix.js',
  'scripts/lib/run-script-allowlist.js': 'scripts/execute-approved-fix.js',
};

// Name the script in a string only; they never run it.
const MENTION_ONLY = new Set(['scripts/lib/ingest-outcome.js', 'scripts/outlet-registry-census-reconciler.js']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else out.push(p);
  }
  return out;
}
const live = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|#|\/\*)/.test(l)).join('\n');

const files = [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, '.github', 'workflows'))]
  .filter((f) => /\.(js|mjs|sh|yml)$/.test(f) && !/\.test\.mjs$/.test(f) && !f.endsWith(path.join('scripts', 'ingest-review-from-url.js')));

test('every spawner of ingest-review-from-url.js sets a caller (or is driven by one that does)', () => {
  const spawners = files.filter((f) => SPAWN_RE.test(live(fs.readFileSync(f, 'utf8'))));
  assert.ok(spawners.length >= 8, `expected to find the known spawners, found ${spawners.length}`);
  const offenders = spawners
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !MENTION_ONLY.has(rel))
    .filter((rel) => !CALLER_RE.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')) && !DRIVEN_BY[rel]);
  assert.deepEqual(offenders, [], `these run ingest-review-from-url.js with no INGEST_CALLER/--caller: ${offenders.join(', ')}. Add process.env.INGEST_CALLER = process.env.INGEST_CALLER || '<slug>' at the top (or --caller=<slug>).`);
});

test('every DRIVEN_BY driver really sets a caller', () => {
  for (const driver of new Set(Object.values(DRIVEN_BY))) {
    assert.match(fs.readFileSync(path.join(ROOT, driver), 'utf8'), CALLER_RE, `${driver} must set INGEST_CALLER`);
  }
});

test('DRIVEN_BY has no stale entries (each file still exists and still spawns the ingest)', () => {
  for (const rel of Object.keys(DRIVEN_BY)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is gone: drop it from DRIVEN_BY`);
    assert.ok(SPAWN_RE.test(live(fs.readFileSync(path.join(ROOT, rel), 'utf8'))), `${rel} no longer spawns the ingest: drop it from DRIVEN_BY`);
  }
});
