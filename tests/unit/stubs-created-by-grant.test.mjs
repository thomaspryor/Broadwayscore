import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'supabase/migrations/';
const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(dir + f, 'utf8')).join('\n');

test('anon/authenticated cannot select user_show_stubs.created_by', () => {
  assert.match(all, /REVOKE SELECT ON user_show_stubs FROM anon, authenticated/);
  const m = all.match(/GRANT SELECT \(([^)]*)\)\s+ON user_show_stubs TO anon, authenticated/);
  assert.ok(m, 'column-level grant present');
  assert.ok(!/created_by/.test(m[1]), 'created_by not granted');
  for (const c of ['id', 'title', 'category', 'mezz_prod_id']) assert.match(m[1], new RegExp(`\\b${c}\\b`));
});

test('every stub insert uses return=minimal (RETURNING created_by is refused)', () => {
  for (const f of ['src/app/my-shows/MyShowsClient.tsx', 'src/app/my-shows/ImportShows.tsx']) {
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes("supabaseRestInsert('user_show_stubs'"));
    assert.ok(lines.length > 0);
    for (const l of lines) assert.match(l, /returning: 'minimal'/, f);
  }
});

test('web client selects never read created_by or *', () => {
  const s = readFileSync('src/lib/show-stubs.ts', 'utf8');
  assert.ok(!/created_by|select=\*/.test(s));
});
