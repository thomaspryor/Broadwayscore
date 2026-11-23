/**
 * Guard: theater page stat tiles must not stretch into tall empty boxes.
 *
 * The Past Shows / Avg Score row used hand-rolled `card ... text-center` tiles. On desktop
 * the "sm" ScoreBadge is 68px, the grid stretched the Past Shows tile to match, and the
 * number sat at the top of a tall empty box. Fixed by rendering the row through the shared
 * StatGrid, which pins labels to the top and centers the value block.
 *
 * Fails if any theater detail page (Broadway, Off-Broadway, West End, future markets)
 * goes back to hand-rolled tiles, or if StatGrid loses its centering / badge slot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findTheaterPages(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTheaterPages(p, out);
    else if (e.name === 'page.tsx' && /[\\/]theater[\\/]\[slug\][\\/]page\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const pages = findTheaterPages(path.join(root, 'src', 'app'));

test('finds the theater detail pages', () => {
  assert.ok(pages.length >= 3, `expected >= 3 theater pages, found ${pages.length}`);
});

for (const p of pages) {
  const rel = path.relative(root, p);
  test(`${rel} builds its stats row with StatGrid`, () => {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /<StatGrid\b/);
    assert.doesNotMatch(src, /card p-3 sm:p-4 text-center/);
  });
}

test('StatGrid pins labels on top, centers the value block, supports badge slot and columns', () => {
  const grid = fs.readFileSync(path.join(root, 'src/components/show-cards/StatGrid.tsx'), 'utf8');
  assert.match(grid, /card [^"]*flex flex-col/);
  assert.match(grid, /flex-1 flex flex-col items-center justify-center/);
  assert.match(grid, /node\?: ReactNode/);
  assert.match(grid, /stat\.node/);
  assert.match(grid, /columns/);
});
