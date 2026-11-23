// BRO-8155: the reviews.json trace exclude must hit every route except the
// ones that fs-read it, under Next's own matcher options (substring match,
// `^`/`$` literal). Requires the real helper and Next's real picomatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const picomatch = require('next/dist/compiled/picomatch');
const {
  NEXT_MATCH_OPTS, READER_MAX_DURATION, REVIEWS_JSON_FS_READERS, listAppRoutes, redundantInlinedJsonExcludes, escapeGlob,
} = require('../../scripts/lib/trace-route-excludes.js');
const { READS_FILE } = require('../../scripts/lib/check-trace-runtime-reads.js');

const appDir = join(ROOT, 'src', 'app');
const excludes = redundantInlinedJsonExcludes({ appDir });
const matchers = Object.keys(excludes).map((k) => picomatch(k, NEXT_MATCH_OPTS));
const excluded = (route) => matchers.some((m) => m(route));
const routes = listAppRoutes(appDir);

test('no fs-reader route is excluded', () => {
  for (const r of REVIEWS_JSON_FS_READERS) {
    assert.ok(routes.includes(r), `reader ${r} is not an app route any more: update REVIEWS_JSON_FS_READERS`);
    assert.equal(excluded(r), false, `${r} reads reviews.json with fs and must keep it`);
  }
});

test('the heavy data routes are excluded', () => {
  for (const r of ['/show/[slug]', '/opera/[slug]', '/biz', '/api/admin/account-stats', '/admin/accounts', '/ads.txt']) {
    assert.ok(routes.includes(r), `${r} missing from listAppRoutes`);
    assert.equal(excluded(r), true, `${r} should drop the redundant reviews.json copy`);
  }
});

test('only substring-of-a-reader routes keep the file (explicit, small)', () => {
  const kept = routes.filter((r) => !REVIEWS_JSON_FS_READERS.includes(r) && !excluded(r));
  assert.deepEqual(kept.sort(), ['/', '/admin', '/admin/ingest']);
});

test('escapeGlob escapes dynamic segments', () => {
  assert.equal(escapeGlob('/show/[slug]'), '/show/\\[slug\\]');
  assert.ok(picomatch(escapeGlob('/show/[slug]'), NEXT_MATCH_OPTS)('/show/[slug]'));
  assert.equal(picomatch(escapeGlob('/show/[slug]'), NEXT_MATCH_OPTS)('/show/s'), false);
});

test('the post-build reader regex matches compiled path.join forms', () => {
  assert.ok(READS_FILE.test('e.join(__dirname,"..","..","data","reviews.json")'));
  assert.ok(READS_FILE.test("path.join(process.cwd(),'data','reviews.json')"));
  assert.ok(READS_FILE.test("path.join(process.cwd(), 'data/reviews.json')"));
  assert.ok(READS_FILE.test("process.cwd() + '/data/reviews.json'"));
  assert.ok(READS_FILE.test("path.join(dataDir, 'reviews.json')"));
  assert.equal(READS_FILE.test('url:`/show/${a.slug}/reviews.json`'), false);
});

test('reader routes alone declare the isolating maxDuration', () => {
  const re = /export const maxDuration = (\d+)/;
  for (const r of REVIEWS_JSON_FS_READERS) {
    const m = readFileSync(join(appDir, r, 'route.ts'), 'utf8').match(re);
    assert.ok(m && Number(m[1]) === READER_MAX_DURATION, `${r} must export maxDuration = ${READER_MAX_DURATION}`);
  }
  const readers = new Set(REVIEWS_JSON_FS_READERS);
  for (const r of routes) {
    if (readers.has(r)) continue;
    const dir = join(appDir, r);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue; // metadata routes are files
    for (const f of readdirSync(dir).filter((n) => /^(route|page)\.(ts|tsx)$/.test(n))) {
      const m = readFileSync(join(appDir, r, f), 'utf8').match(re);
      assert.ok(!m || Number(m[1]) !== READER_MAX_DURATION, `${r} shares the reader maxDuration ${READER_MAX_DURATION}: it would be packed with the reviews.json readers`);
    }
  }
});

test('a tree without src/app yields no routes instead of throwing (next.config.js loads in scratch trees)', () => {
  assert.deepEqual(listAppRoutes(join(ROOT, 'no-such-dir', 'app')), []);
  assert.deepEqual(redundantInlinedJsonExcludes({ appDir: join(ROOT, 'no-such-dir', 'app') }), {});
});
