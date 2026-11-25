// BRO-8000 class guard: Internet Archive CDX auth refusal classification, and no
// script grows a private CDX caller that misreads it as "error"/"no capture".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AC = require('./archive-cdx.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('classifier: CDX 403 body and availability upstream_error are archive_auth_required; other failures are not', () => {
  assert.equal(AC.classifyArchiveResponse(403, '<p>This type of CDX query requires authorization.</p>'), 'archive_auth_required');
  assert.equal(AC.classifyArchiveResponse(200, '{"error":{"code":"upstream_error","message":"query failed with status_code=403"}}'), 'archive_auth_required');
  assert.equal(AC.classifyArchiveResponse(503, 'busy'), null);
  assert.equal(AC.classifyArchiveResponse(403, '<title>403 Forbidden</title> cloudflare'), null);
  assert.equal(AC.classifyArchiveResponse(200, 'https://x.com/a 2020 200'), null);
});

test('fetchArchiveIndex returns a typed result, not an error or empty text', async () => {
  const mk = (status, body) => async () => new Response(body, { status });
  const a = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(403, 'This type of CDX query requires authorization.') });
  assert.deepEqual([a.ok, a.kind], [false, 'archive_auth_required']);
  const b = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(503, 'x') });
  assert.equal(b.kind, 'http_error');
  const c = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(200, 'rows') });
  assert.deepEqual([c.ok, c.text], [true, 'rows']);
  await assert.rejects(AC.fetchArchiveIndexText('u', { fetchImpl: mk(403, 'requires authorization') }), (e) => e.kind === 'archive_auth_required');
});

test('fetchArchiveIndexJson: parsed rows, null for an empty body, typed throw for the auth refusal (BRO-8099)', async () => {
  const mk = (status, body) => async () => new Response(body, { status });
  assert.deepEqual(await AC.fetchArchiveIndexJson('u', { fetchImpl: mk(200, '[["timestamp"],["20200101000000"]]') }), [['timestamp'], ['20200101000000']]);
  assert.equal(await AC.fetchArchiveIndexJson('u', { fetchImpl: mk(200, '  ') }), null);
  await assert.rejects(AC.fetchArchiveIndexJson('u', { fetchImpl: mk(403, 'This type of CDX query requires authorization.') }), (e) => AC.isArchiveAuthError(e));
  await assert.rejects(AC.fetchArchiveIndexJson('u', { fetchImpl: mk(503, 'busy') }), (e) => !AC.isArchiveAuthError(e) && /HTTP 503/.test(e.message));
  assert.equal(AC.isArchiveAuthError(new Error('x')), false);
});

// A migrated caller with its real default fetch path: the IA refusal must come out typed.
test('migrated callers type the refusal through their default fetch (fallback-publish-date, commercial-source-verify)', async () => {
  const orig = globalThis.fetch;
  const origWarn = console.warn;
  const warned = [];
  globalThis.fetch = async () => new Response('This type of CDX query requires authorization.', { status: 403 });
  console.warn = (m) => warned.push(String(m));
  try {
    const fb = require('./fallback-publish-date.js');
    assert.equal(await fb.archiveFirstCaptureDate('https://www.nytimes.com/x'), null);
    assert.ok(warned.some((w) => w.includes('archive_auth_required')), 'the refusal is named, not a silent "no capture"');
    const csv = require('./commercial-source-verify.js');
    await assert.rejects(csv.waybackSnapshotUrl('https://www.nytimes.com/x'), (e) => AC.isArchiveAuthError(e));
  } finally { globalThis.fetch = orig; console.warn = origWarn; }
});

// Every file that calls the CDX/availability API must require archive-cdx.js
// (BRO-8000 left 16 untyped; BRO-8099 routed them all). ALLOWED_UNTYPED is for a
// caller that truly cannot use it, each with its reason; it is empty today.
const ALLOWED_UNTYPED = new Map([
  // ['path/relative/to/scripts.js', 'why it cannot route through archive-cdx.js'],
]);
const USES_LIB_RE = /require\(\s*['"][^'"]*archive-cdx(?:\.js)?['"]\s*\)/;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'llm-scoring'].includes(e.name)) walk(p, out); } else if (/\.(js|mjs|cjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

test('every CDX/availability caller requires archive-cdx.js (no allowlist entries without a reason)', () => {
  const users = walk(root).filter((p) => /cdx\/search|wayback\/available/.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(root, p)).filter((p) => p !== 'lib/archive-cdx.js');
  assert.ok(users.length >= 15, `scan found only ${users.length} callers: the walk is broken`);
  const untyped = users.filter((p) => !ALLOWED_UNTYPED.has(p) && !USES_LIB_RE.test(fs.readFileSync(path.join(root, p), 'utf8')));
  assert.deepEqual(untyped, [], `untyped Internet Archive index caller(s): route through scripts/lib/archive-cdx.js (${untyped.join(', ')})`);
  for (const [p, why] of ALLOWED_UNTYPED) assert.ok(String(why).length > 20, `${p}: allowlist entry needs a reason`);
});

test('guard catches a caller that only mentions archive-cdx (a tier id string is not routing)', () => {
  assert.equal(USES_LIB_RE.test("id: 'archive-cdx',"), false);
  assert.equal(USES_LIB_RE.test("require('./lib/archive-cdx')"), true);
  assert.equal(USES_LIB_RE.test("require('../lib/archive-cdx.js')"), true);
});
