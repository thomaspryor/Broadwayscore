// BRO-6016: every scripts/prebuild.sh generator that reads data/shows.json must
// go through show-row-guard (partitionShowRows) or be on the allowlist below,
// so one null-title/venue row cannot crash prebuild (BRO-5954 follow-up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { partitionShowRows } = createRequire(import.meta.url)('./show-row-guard.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// script -> reason it may read shows.json without the row guard.
const ALLOWLIST = {
  'scripts/validate-shows-prebuild.js': 'is the validator; partitions rows itself',
  'scripts/build-slug-redirects.js': 'BRO-5954 inline skip of rows it cannot key',
};

function prebuildScripts() {
  const out = new Set();
  for (const m of read('scripts/prebuild.sh').matchAll(/^\s*node\s+(scripts\/[\w./-]+\.js)/gm)) out.add(m[1]);
  return [...out];
}

test('prebuild.sh lists generators (scanner sanity)', () => {
  assert.ok(prebuildScripts().length > 10);
});

// Source of a script plus the local ./lib/*.js modules it requires (one level),
// so wrappers that delegate to a shared lib (e.g. the market-archive generators) are covered.
function sourceWithLibs(s) {
  let src = read(s);
  for (const m of src.matchAll(/require\(\s*['"]\.\/(lib\/[\w.-]+?)(?:\.js)?['"]\s*\)/g)) {
    const lib = path.join('scripts', `${m[1]}.js`);
    if (fs.existsSync(path.join(ROOT, lib))) src += '\n' + read(lib);
  }
  return src;
}

test('every prebuild generator reading shows.json uses show-row-guard or is allowlisted', () => {
  const offenders = prebuildScripts().filter((s) => {
    if (!fs.existsSync(path.join(ROOT, s)) || s in ALLOWLIST) return false;
    const src = sourceWithLibs(s);
    const reads = /['"`]shows\.json['"`]|data\/shows\.json/.test(src);
    // A real call, not just a mention in a comment.
    return reads && !/show-row-guard['"`]\)\.partitionShowRows\(|partitionShowRows\(/.test(src.replace(/\/\/.*$/gm, ''));
  });
  assert.deepEqual(offenders, [], `read data/shows.json without show-row-guard: ${offenders.join(', ')}`);
});

// Fixture run: patched generators must exit 0 and omit the null-title row.
test('patched generators survive a null-title row and omit it', () => {
  const rows = [
    { id: 'good-2026', title: 'Good Show', slug: 'good-show', category: 'broadway', status: 'open', venue: 'Hudson Theatre', openingDate: '2026-01-01' },
    { id: 'bad-2026', title: null, slug: 'bad-show', category: 'broadway', status: 'open', venue: 'Hudson Theatre' },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row-guard-'));
  const showsPath = path.join(tmp, 'shows.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: rows }));
  const outPath = path.join(tmp, 'blog-out.json');
  const r = spawnSync('node', ['scripts/generate-blog-reviews-for-scoring.js'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, BLOG_SHOWS_PATH: showsPath, BLOG_OUTPUT_PATH: outPath },
  });
  assert.equal(r.status, 0, r.stderr);

  // Others have fixed data/ paths; exercise the exact guarded expression instead.
  assert.deepEqual(partitionShowRows(rows).valid.map((s) => s.id), ['good-2026']);
});
