// Owner decision 2026-11-09: the show-page top card has no "Badge & embed" link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'src/components/show-page/CiteScoreControl.tsx'), 'utf8');

test('hero cite control has no Badge & embed link', () => {
  assert.ok(!/Badge\s*(&amp;|&)\s*embed/.test(src));
  assert.ok(!src.includes('href="/partners"'));
});
