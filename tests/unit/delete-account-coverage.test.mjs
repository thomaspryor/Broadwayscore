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
