// Owner decision 2026-11-09: the show-page top card has no "Cite this score" /
// "Badge & embed" row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hero = readFileSync(path.join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');

test('hero does not render the cite/badge row', () => {
  assert.ok(!hero.includes('CiteScoreControl'));
  assert.ok(!existsSync(path.join(ROOT, 'src/components/show-page/CiteScoreControl.tsx')));
});
