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

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = path.join(root, 'supabase/migrations');
const fnSource = fs.readFileSync(path.join(root, 'supabase/functions/delete-account/index.ts'), 'utf8');

// Tables delete-account deliberately leaves alone, and why.
const EXEMPT = {
  user_show_stubs: 'shared catalog rows other users can point at; no personal content',
  plan_shares: 'ON DELETE CASCADE from profiles, which delete-account removes',
};

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

test('migrations declare the per-user tables this guard is meant to see', () => {
  const owned = userOwnedTables();
  for (const t of ['unmatched_imports', 'import_fetch_log', 'mezzanine_search_log', 'user_show_stubs', 'plan_shares']) {
    assert.ok(owned.has(t), `parser no longer finds ${t}; fix the regex before trusting the next test`);
  }
});

test('delete-account removes or explicitly exempts every per-user table', () => {
  const missing = [...userOwnedTables()].filter((t) => !EXEMPT[t] && !fnSource.includes(`'${t}'`));
  assert.deepEqual(missing, [], `delete-account/index.ts does not delete rows from: ${missing.join(', ')}`);
});

test('exemptions are not also deleted (stale exemption)', () => {
  for (const t of Object.keys(EXEMPT)) {
    assert.ok(!fnSource.includes(`deleteRows(base, auth, '${t}'`), `${t} is exempt but delete-account deletes it`);
  }
});

// A retry after a deletion whose response was lost finds the auth user
// already gone. The Admin API answers 404, and treating that as a failure
// left the user unable to ever finish deleting (BRO-4525).
test('a 404 from the admin user delete counts as already deleted', () => {
  const at = fnSource.indexOf('/auth/v1/admin/users/');
  assert.ok(at > 0, 'admin user delete not found');
  const tail = fnSource.slice(at, at + 600);
  assert.match(tail, /status !== 404/, 'admin user delete must tolerate 404 so retries can finish');
});

// PostgREST returns at most 1000 rows per request, so a single photo lookup
// left files behind in storage for anyone past 1000 photos (BRO-4525).
test('the review photo lookup pages past the 1000-row response cap', () => {
  const at = fnSource.indexOf('/rest/v1/user_review_photos');
  assert.ok(at > 0, 'photo lookup not found');
  const call = fnSource.slice(at, at + 200);
  assert.match(call, /limit=1000&offset=\$\{offset\}/, 'photo lookup must page with limit+offset');
  assert.match(call, /order=/, 'offset paging needs a stable order');
});
