// BRO-8152: the owner read "Commercial figures are waiting for a manual check" and asked why
// nobody had asked them to check anything. The row was an automatic queue. Owner-facing digest
// lines must never describe automated work as manual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { plainHealthLine } = require('../../scripts/lib/autonomous-email-render.js');

test('no plain-English digest row says manual or by hand', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/autonomous-email-render.js', import.meta.url), 'utf8');
  const table = src.slice(src.indexOf('const PLAIN_HEALTH = ['), src.indexOf('];', src.indexOf('const PLAIN_HEALTH = [')));
  // Every string literal in the table: single, double or template quotes (templates keep their ${...}).
  const lines = [...table.matchAll(/=>\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
  assert.ok(lines.length > 50, `parsed ${lines.length} rows`);
  const bad = lines.filter((l) => /\bmanual|\bby hand\b/i.test(l));
  assert.deepEqual(bad, []);
});

test('the commercial queue rows read as automatic', () => {
  assert.match(plainHealthLine('Commercial pending-review queue'), /automatic/);
  assert.doesNotMatch(plainHealthLine('Commercial: rows held for a person'), /manual/i);
});
