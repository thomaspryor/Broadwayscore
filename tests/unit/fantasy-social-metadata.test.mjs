// Every game page must preview as the Marquee card when shared. A page whose
// metadata sets no openGraph inherits the root layout's homepage card, and one
// that sets openGraph but no twitter still shows the homepage on X; the guide
// and leaderboard shipped the first way, draft and create-league the second
// (BRO-5529). src/config/fantasy-social.ts builds both, so each fantasy
// metadata export must spread it and none may hand-write either key. What the
// helper returns is checked in tests/unit/social-preview-metadata.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fantasyDir = path.join(root, 'src/app/fantasy');
// Sets only tab icons and the unlisted robots switch for the whole subtree.
const SUBTREE_LAYOUT = path.join(fantasyDir, 'layout.tsx');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(fantasyDir).filter((f) => /\/(page|layout)\.tsx$/.test(f));
const read = (f) => fs.readFileSync(f, 'utf8');
const hasMetadata = (src) => /export const metadata\b|export (async )?function generateMetadata\b/.test(src);
const rel = (f) => path.relative(root, f);

test('every fantasy metadata export uses fantasySocial and hand-writes no preview keys', () => {
  const exporters = files.filter((f) => f !== SUBTREE_LAYOUT && hasMetadata(read(f)));
  assert.ok(exporters.length >= 6, `expected the six game routes, found ${exporters.length}`);
  for (const f of exporters) {
    const src = read(f);
    assert.match(src, /\.\.\.fantasySocial\(/, `${rel(f)} does not spread fantasySocial(...)`);
    assert.doesNotMatch(src, /\b(openGraph|twitter):/, `${rel(f)} hand-writes openGraph/twitter`);
  }
});

test('every fantasy page is covered by its own metadata or a layout below the subtree root', () => {
  for (const page of files.filter((f) => f.endsWith('/page.tsx'))) {
    let dir = path.dirname(page);
    let covered = hasMetadata(read(page));
    while (!covered && dir !== fantasyDir) {
      const layout = path.join(dir, 'layout.tsx');
      covered = fs.existsSync(layout) && hasMetadata(read(layout));
      dir = path.dirname(dir);
    }
    assert.ok(covered, `${rel(page)} has no metadata, so it previews as the homepage card`);
  }
});
