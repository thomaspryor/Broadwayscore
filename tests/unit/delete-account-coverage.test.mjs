// Every table a web migration creates with a per-user column must either be
// cleaned up by the delete-account edge function or carry a reason here.
// Three import/search log tables were missed when they were added
// (BRO-4525), so a deleted account left its pasted titles and queries behind
// while the privacy policy said deletion removes import records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { selectAll } from '../../supabase/functions/delete-account/handler.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = path.join(root, 'supabase/migrations');
// handler.mjs holds the deletion logic; index.ts is only the Deno entry point.
const fnSource = fs.readFileSync(path.join(root, 'supabase/functions/delete-account/handler.mjs'), 'utf8');

// Tables delete-account deliberately leaves alone, and why. Shared with the
// live-catalog check in scripts/verify-supabase-schema.js (BRO-4534).
const require = createRequire(import.meta.url);
const EXEMPT = require('../../scripts/lib/delete-account-exempt.js');

function userOwnedTables() {
  const owned = new Set();
  for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8').replace(/--[^\n]*/g, '');
    const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi;
    for (const m of sql.matchAll(re)) {
      if (/\b(user_id|created_by)\s+uuid\b/i.test(m[2])) owned.add(m[1].toLowerCase());
    }
  }
  return owned;
}

// The live-catalog check reads the function source by path too. When the
// handler moved out of index.ts it kept reading the now-empty entry file and
// would have flagged every table (BRO-6290); both readers must see the deletes.
test('verify-supabase-schema reads the file that holds the deletes', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/verify-supabase-schema.js'), 'utf8');
  const m = script.match(/DELETE_ACCOUNT_FN = path\.join\(__dirname, '\.\.', ((?:'[^']+',?\s*)+)\)/);
  assert.ok(m, 'DELETE_ACCOUNT_FN not found in verify-supabase-schema.js');
  const rel = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const src = fs.readFileSync(path.join(root, ...rel), 'utf8');
  assert.match(src, /deleteRows\(fetch, base, auth, 'profiles'/, `${rel.join('/')} no longer holds the deletes`);
});

test('migrations declare the per-user tables this guard is meant to see', () => {
  const owned = userOwnedTables();
  for (const t of ['unmatched_imports', 'import_fetch_log', 'mezzanine_search_log', 'theatr_screenshot_log', 'user_show_stubs', 'plan_shares', 'diary_shares']) {
    assert.ok(owned.has(t), `parser no longer finds ${t}; fix the regex before trusting the next test`);
  }
});

test('delete-account removes or explicitly exempts every per-user table', () => {
  const missing = [...userOwnedTables()].filter((t) => !EXEMPT[t] && !fnSource.includes(`'${t}'`));
  assert.deepEqual(missing, [], `delete-account/handler.mjs does not delete rows from: ${missing.join(', ')}`);
});

test('exemptions are not also deleted (stale exemption)', () => {
  for (const t of Object.keys(EXEMPT)) {
    assert.ok(!fnSource.includes(`deleteRows(fetch, base, auth, '${t}'`), `${t} is exempt but delete-account deletes it`);
  }
});

// A retry after a deletion whose response was lost finds the auth user
// already gone. The Admin API answers 404, and treating that as a failure
// left the user unable to ever finish deleting (BRO-4525).
test('a 404 from the admin user delete counts as already deleted', () => {
  const at = fnSource.indexOf('const deleteUserRes');
  assert.ok(at > 0, 'admin user delete not found');
  const tail = fnSource.slice(at, at + 600);
  assert.match(tail, /status !== 404/, 'admin user delete must tolerate 404 so retries can finish');
});

// PostgREST returns at most max-rows per request (1000 by default), so a
// single lookup left photo files in storage for anyone past 1000 photos
// (BRO-4525). Run the edge function's real selectAll against a fake PostgREST.
function loadSelectAll(fetchImpl) {
  return (...args) => selectAll(fetchImpl, ...args);
}
function fakePostgrest(total, maxRows, status = 200) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const q = new URL(url).searchParams;
    const offset = Number(q.get('offset'));
    const n = Math.max(0, Math.min(Number(q.get('limit')), maxRows, total - offset));
    return { ok: true, status: 200, json: async () => Array.from({ length: n }, (_, i) => ({ id: offset + i })) };
  };
  return { fetchImpl, urls };
}

test('selectAll reads every row past the response cap', async () => {
  const { fetchImpl, urls } = fakePostgrest(2500, 1000);
  const rows = await loadSelectAll(fetchImpl)('https://x', {}, 'user_review_photos', 'user_id=eq.u&select=storage_path', 'storage_path');
  assert.equal(rows.length, 2500);
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 2500 }, (_, i) => i));
  assert.ok(urls.every((u) => u.includes('order=storage_path')), 'offset paging needs a stable order');
});

test('selectAll does not stop early when the server cap is below 1000', async () => {
  const { fetchImpl } = fakePostgrest(1200, 500);
  const rows = await loadSelectAll(fetchImpl)('https://x', {}, 'lists', 'user_id=eq.u&select=id', 'id');
  assert.equal(rows.length, 1200);
});

test('selectAll returns null for a missing table and throws on other errors', async () => {
  assert.equal(await loadSelectAll(fakePostgrest(0, 1000, 404).fetchImpl)('https://x', {}, 't', 'q', 'id'), null);
  await assert.rejects(loadSelectAll(fakePostgrest(0, 1000, 500).fetchImpl)('https://x', {}, 't', 'q', 'id'), /fetch t failed: 500/);
});

test('delete-account reads lists and photos through selectAll', () => {
  assert.match(fnSource, /selectAll\(fetch, base, auth, 'lists'/);
  assert.match(fnSource, /selectAll\(fetch, base, auth, 'user_review_photos'/);
  assert.doesNotMatch(fnSource, /fetch\(`\$\{base\}\/rest\/v1\/(lists|user_review_photos)\?/, 'unpaged lookup is back');
});
