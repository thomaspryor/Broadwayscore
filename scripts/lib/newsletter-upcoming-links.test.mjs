import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { UPCOMING_PAGES, upcomingLinks } = createRequire(import.meta.url)('./newsletter-upcoming-links.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const browsePages = fs.readFileSync(path.join(here, '../../src/config/browse-pages.ts'), 'utf8');
const S = 'https://broadwayscorecard.com';

test('every mapped upcoming page exists on the site', () => {
  for (const [cat, { slug }] of Object.entries(UPCOMING_PAGES)) {
    assert.ok(browsePages.includes(`slug: '${slug}'`), `${cat} -> ${slug} missing from browse-pages.ts`);
  }
});

test('West End edition slate links to London pages, never off-Broadway (Oct 26 bug)', () => {
  const links = upcomingLinks(['off-west-end', 'off-west-end', 'west-end'], S);
  assert.deepEqual(links.map(l => l.href), [`${S}/browse/upcoming-west-end-shows`, `${S}/browse/upcoming-off-west-end-shows`]);
  assert.ok(links.every(l => !l.href.includes('off-broadway')));
  assert.deepEqual(upcomingLinks(['off-west-end'], S).map(l => l.href), [`${S}/browse/upcoming-off-west-end-shows`]);
});

test('NYC slates keep their pages', () => {
  assert.deepEqual(upcomingLinks(['off-broadway'], S).map(l => l.href), [`${S}/browse/upcoming-off-broadway-shows`]);
  assert.deepEqual(upcomingLinks(['off-broadway', 'broadway'], S).map(l => l.label), ['Broadway', 'Off-Broadway']);
  assert.deepEqual(upcomingLinks(['regional'], S), []);
});
