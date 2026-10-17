// Browse cards at 360-414px: a single long word ("Schmigadoon!") is wider
// than the compact title column, and line-clamp's overflow:hidden cut it to
// "Schmigadoo" (BRO-3049). The title must be allowed to break/hyphenate.
// The browse h1 at sm+ used text-4xl's 40px line-height for 36px type, so
// descenders overflowed its box; it carries an explicit leading at both sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('compact ShowListCard title can wrap a word wider than its column', () => {
  const src = read('src/components/show-cards/ShowListCard.tsx');
  const compact = src.slice(src.indexOf('const infoContent = isCompact'));
  const h2 = compact.match(/<h2 className="([^"]+)"/);
  assert.ok(h2, 'compact variant h2 not found');
  const cls = h2[1].split(/\s+/);
  assert.ok(cls.includes('line-clamp-2'), 'title should still clamp to two lines');
  assert.ok(cls.includes('break-words'), `compact title needs break-words: ${h2[1]}`);
  assert.ok(cls.includes('hyphens-auto'), `compact title needs hyphens-auto: ${h2[1]}`);
});

test('browse h1 sets line-height at both breakpoints', () => {
  const src = read('src/app/browse/[slug]/page.tsx');
  const h1 = src.match(/<h1 className="([^"]+)"/);
  assert.ok(h1, 'browse h1 not found');
  const cls = h1[1].split(/\s+/);
  if (cls.includes('sm:text-4xl')) {
    assert.ok(cls.some(c => c.startsWith('sm:leading-')), `sm:text-4xl resets line-height; add sm:leading-*: ${h1[1]}`);
  }
});
