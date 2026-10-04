// BRO-4525 launch hardening: source-shape pins for the fixes that live in React/Next files
// which cannot be require()d from node:test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('My Shows shows a retryable error, not "empty", when loading fails', () => {
  const s = read('src/app/my-shows/MyShowsClient.tsx');
  assert.match(s, /error: reviewsError/);
  assert.match(s, /error: watchlistError/);
  assert.equal((s.match(/<LoadError /g) || []).length, 2, 'both tabs must render LoadError');
});

test('signOut clears the pending rating draft', () => {
  const s = read('src/contexts/AuthContext.tsx');
  const body = s.slice(s.indexOf('const signOut'), s.indexOf('const deleteAccount'));
  assert.match(body, /clearPendingAction\(\)/);
});

test('public list metadata reads bypass the Next data cache', () => {
  const s = read('src/app/list/[slug]/page.tsx');
  assert.match(s, /getServerSupabaseClient\(\{ fetch: noStoreFetch \}\)/);
});
