// BRO-8107: the shared guards (review-write-guard, review-guards, review-file-writer)
// read shows.json from showsJsonPath(), so SHOWS_JSON_PATH points a
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
const { showsJsonPath, readShowsList, REPO_SHOWS_PATH } = require('./shows-json-path.js');
const { useShowsFixture } = require('./shows-json-fixture.js');

test('showsJsonPath: env first (read at call time), else the repo copy', () => {
  const prev = process.env.SHOWS_JSON_PATH;
  try {
    delete process.env.SHOWS_JSON_PATH;
    assert.equal(showsJsonPath(), REPO_SHOWS_PATH);
    process.env.SHOWS_JSON_PATH = '/tmp/x/shows.json';
    assert.equal(showsJsonPath(), '/tmp/x/shows.json');
    assert.equal(showsJsonPath({ homeFallback: true }), '/tmp/x/shows.json');
    process.env.SHOWS_JSON_PATH = 'fixtures/shows.json';
    assert.equal(showsJsonPath(), path.resolve('fixtures/shows.json'), 'a relative override is made absolute (require() and fs must agree)');
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
    for (const [f, title] of [[A, 'Example Show'], [B, 'Example Show Revised']]) { fs.mkdirSync(path.dirname(f)); fs.writeFileSync(f, JSON.stringify({ shows: [{ id: 'example-show-2026', title, openingDate: '2026-03-01' }] })); }
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
      // Content guards reached from the same write/scoring paths (BRO-8107
      // follow-up: content-quality's title list made pending-triage live).
      const CQ = require(lib + '/content-quality.js');
      const { getMatchableTitles } = require(lib + '/excerpt-validation.js');
      const { curtainupSuffixYear } = require(lib + '/content-filters.js');
      const { resolveShowMeta } = require(lib + '/show-identity.js');
      const { getShowSlugIndex } = require(lib + '/cross-show-url.js');
      const texts = ${JSON.stringify(texts)};
      const review = { showId: 'example-show-2026', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/03/02/theater/example-show-review.html', publishDate: '2026-03-02', fullText: 'Example Show is a review. '.repeat(40) };
      const out = {};
      for (const [tag, file] of [['A', ${JSON.stringify(A)}], ['B', ${JSON.stringify(B)}]]) {
        process.env.SHOWS_JSON_PATH = file;
        // One entry point at a time, so a guard that never reads (or reads a stale
        // path) cannot hide behind another guard's read.
        const entries = {
          isScoreable: () => isScoreable(review, { id: 'example-show-2026', title: 'Example Show' }, texts + '/example-show-2026/nytimes--jesse-green.json'),
          safeWriteReview: () => safeWriteReview(texts + '/example-show-2026/nytimes--jesse-green-' + tag + '.json', review),
          verifyFullTextContent: () => CQ.verifyFullTextContent(review.fullText, { id: 'example-show-2026', title: 'Example Show' }),
          getMatchableTitles: () => getMatchableTitles(),
          curtainupSuffixYear: () => curtainupSuffixYear('https://www.curtainup.com/example' + (tag === 'A' ? '22' : '23') + '.html'),
          resolveShowMeta: () => resolveShowMeta('example-show-2026'),
          getShowSlugIndex: () => getShowSlugIndex(),
          createOrMergeReviewFile: () => createOrMergeReviewFile('example-show-2026', { outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url: 'https://variety.com/2026/legit/reviews/example-show-' + tag + '.html', source: 'test' }, { reviewTextsDir: texts, knownShowIds: ['example-show-2026'] }),
        };
        out[tag] = {};
        for (const [name, fn] of Object.entries(entries)) {
          reads.length = 0;
          let error = null;
          try { fn(); } catch (e) { error = String(e && e.message); }
          out[tag][name] = { reads: [...new Set(reads)], error };
        }
      }
      process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n');
    `;
    // Guard G reads the critic registry; point it at a fixture too, or this
    // test is itself a live-data test.
    const registry = path.join(dir, 'critic-registry.json');
    fs.writeFileSync(registry, JSON.stringify({ critics: {} }));
    const env = { ...process.env, BSC_CRITIC_REGISTRY_PATH: registry };
    delete env.SHOWS_JSON_PATH;
    delete env.NODE_TEST_CONTEXT;
    // BRO-8124: with NODE_TEST_CONTEXT gone the child is not a test run to
    // stage-latency.js, so createOrMergeReviewFile appended a fake
    // review-first-seen row to the TRACKED data/audit/stage-latency.jsonl
    // (it also left every land-floor baseline checkout dirty).
    env.STAGE_LATENCY_LOG = path.join(dir, 'stage-latency.jsonl');
    const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, r.stdout + r.stderr);
    const out = JSON.parse(line.slice(7));
    // require() reports the realpath (/private/tmp on macOS); compare resolved paths.
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    for (const [tag, file] of [['A', real(A)], ['B', real(B)]]) {
      for (const [name, { reads, error }] of Object.entries(out[tag])) {
        assert.equal(error, null, `${name} (fixture ${tag}) threw`);
        const got = [...new Set(reads.map(real))];
        assert.ok(got.includes(file), `${name} read fixture ${tag} (got ${JSON.stringify(got)})`);
        assert.deepEqual(got.filter((p) => p !== file), [], `${name} read only fixture ${tag}, never the repo copy or the previous fixture`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('excerpt-validation reads a bare-array shows fixture too (readShowsList), not an empty map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjp-ev-'));
  const prev = process.env.SHOWS_JSON_PATH;
  try {
    const f = path.join(dir, 'shows.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'example-show-2026', title: 'Example Show Title' }]));
    process.env.SHOWS_JSON_PATH = f;
    const { getMatchableTitles } = require('./excerpt-validation.js');
    assert.deepEqual([...getMatchableTitles().keys()], ['example-show-2026']);
  } finally {
    if (prev === undefined) delete process.env.SHOWS_JSON_PATH; else process.env.SHOWS_JSON_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
