import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// BRO-5565: unmatched_imports has an INSERT-only RLS policy. PostgREST's default
// return=representation reads the row back, which RLS refuses with 42501.
test('unmatched_imports inserts use returning: minimal', () => {
  const src = fs.readFileSync(new URL('../../src/app/my-shows/ImportShows.tsx', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/supabaseRestInsert\(\s*'unmatched_imports'[\s\S]*?\.catch\(/g)];
  assert.ok(calls.length >= 1, 'expected an unmatched_imports insert');
  for (const c of calls) assert.match(c[0], /returning:\s*'minimal'/);
  const mig = fs.readFileSync(new URL('../../supabase/migrations/20260714_unmatched_imports.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(mig, /FOR SELECT/i, 'if a SELECT policy is added this guard can be relaxed');
});
