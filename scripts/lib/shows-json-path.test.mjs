// BRO-8107: the shared guards (review-write-guard, review-guards, review-file-writer,
// gap-acceptance) read shows.json from showsJsonPath(), so SHOWS_JSON_PATH points a
// test at a fixture instead of the live corpus, and a change of path re-reads.
// Without this seam every test reaching safeWriteReview / isScoreable /
// createOrMergeReviewFile was a live-data test, and land.yml refused 3 worker
// landings in a day at lint-workflows::live-data-lane (BRO-8065/8079/8092).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { showsJsonPath, readShowsList, useShowsFixture, REPO_SHOWS_PATH } = require('./shows-json-path.js');

test('showsJsonPath: env first (read at call time), else the repo copy', () => {
  const prev = process.env.SHOWS_JSON_PATH;
  try {
    delete process.env.SHOWS_JSON_PATH;
    assert.equal(showsJsonPath(), REPO_SHOWS_PATH);
    process.env.SHOWS_JSON_PATH = '/tmp/x/shows.json';
    assert.equal(showsJsonPath(), '/tmp/x/shows.json');
    assert.equal(showsJsonPath({ homeFallback: true }), '/tmp/x/shows.json');
  } finally {
    if (prev === undefined) delete process.env.SHOWS_JSON_PATH; else process.env.SHOWS_JSON_PATH = prev;
  }
});

test('useShowsFixture writes {shows}, sets the env, and restore puts it back', () => {
  const prev = process.env.SHOWS_JSON_PATH;
  const restore = useShowsFixture([{ id: 'a-2026', title: 'A' }]);
  const file = process.env.SHOWS_JSON_PATH;
  assert.notEqual(file, prev);
  assert.deepEqual(readShowsList(file), [{ id: 'a-2026', title: 'A' }]);
  restore();
  assert.equal(process.env.SHOWS_JSON_PATH, prev);
  assert.equal(fs.existsSync(file), false);
});

test('readShowsList accepts a bare array too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjp-'));
  try {
    const f = path.join(dir, 'shows.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'b' }]));
    assert.deepEqual(readShowsList(f), [{ id: 'b' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The class guard: every shared guard entry point, in a fresh process with a
// spy on fs reads of any */shows.json. Fixture A, then B after switching the
// env: each guard must read only the fixture it is pointed at, never the repo
// copy, and must re-read on a path change (a stale per-process cache is how a
// fixture silently falls back to whatever was loaded first).
test('shared guards read shows.json only from SHOWS_JSON_PATH and re-read when it changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjp-guards-'));
  try {
    const A = path.join(dir, 'a', 'shows.json');
    const B = path.join(dir, 'b', 'shows.json');
    for (const f of [A, B]) { fs.mkdirSync(path.dirname(f)); fs.writeFileSync(f, JSON.stringify({ shows: [{ id: 'example-show-2026', title: 'Example Show', openingDate: '2026-03-01' }] })); }
    const texts = path.join(dir, 'texts');
    fs.mkdirSync(path.join(texts, 'example-show-2026'), { recursive: true });
    const child = `
      const fs = require('fs');
      const reads = [];
      for (const k of ['readFileSync', 'statSync']) {
        const o = fs[k];
        fs[k] = function (p, ...a) { if (String(p).endsWith('shows.json')) reads.push(String(p)); return o.call(this, p, ...a); };
      }
      // require() of a .json goes through the loader, not fs.readFileSync: spy there too.
      const Module = require('module');
      const origJson = Module._extensions['.json'];
      Module._extensions['.json'] = function (m, f) { if (f.endsWith('shows.json')) reads.push(f); return origJson(m, f); };
      const lib = ${JSON.stringify(HERE)};
      const { isScoreable } = require(lib + '/is-scoreable.js');
      const { safeWriteReview } = require(lib + '/review-write-guard.js');
      const { createOrMergeReviewFile } = require(lib + '/review-file-writer.js');
      const texts = ${JSON.stringify(texts)};
      const review = { showId: 'example-show-2026', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/03/02/theater/example-show-review.html', publishDate: '2026-03-02', fullText: 'Example Show is a review. '.repeat(40) };
      const out = {};
      for (const [tag, file] of [['A', ${JSON.stringify(A)}], ['B', ${JSON.stringify(B)}]]) {
        process.env.SHOWS_JSON_PATH = file;
        reads.length = 0;
        isScoreable(review, { id: 'example-show-2026', title: 'Example Show' }, texts + '/example-show-2026/nytimes--jesse-green.json');
        try { safeWriteReview(texts + '/example-show-2026/nytimes--jesse-green-' + tag + '.json', review); } catch {}
        try { createOrMergeReviewFile('example-show-2026', { outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url: 'https://variety.com/2026/legit/reviews/example-show-' + tag + '.html', source: 'test' }, { reviewTextsDir: texts, knownShowIds: ['example-show-2026'] }); } catch {}
        out[tag] = [...new Set(reads)];
      }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n');
    `;
    const env = { ...process.env };
    delete env.SHOWS_JSON_PATH;
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, r.stdout + r.stderr);
    const out = JSON.parse(line.slice(7));
    // require() reports the realpath (/private/tmp on macOS); compare resolved paths.
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    for (const tag of Object.keys(out)) out[tag] = [...new Set(out[tag].map(real))];
    for (const [tag, file] of [['A', real(A)], ['B', real(B)]]) {
      assert.ok(out[tag].includes(file), `run ${tag} read its fixture (got ${JSON.stringify(out[tag])})`);
      assert.deepEqual(out[tag].filter((p) => p !== file), [], `run ${tag} read only its fixture, never the repo copy or the previous fixture`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
