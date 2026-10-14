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

test('no anon/authenticated reader of user_show_stubs touches created_by or *', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  } };
  walk('src'); walk('supabase/functions');
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    if (!t.includes('user_show_stubs') || f.endsWith('supabase-rest.ts')) continue;
    const reads = t.split('\n').filter((l) => /user_show_stubs\?|select=/.test(l));
    for (const l of reads) assert.ok(!/created_by|select=\*/.test(l), `${f}: ${l.trim()}`);
  }
});
