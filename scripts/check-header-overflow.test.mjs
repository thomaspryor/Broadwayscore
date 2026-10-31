// BRO-4575: the header's right group (src/app/layout.tsx) can't shrink, so at
// tablet widths it overflowed the viewport (946px of content at 768, 1092 at
// 1024) and pushed Sign in and the hamburger off-screen. The fix is a set of
// breakpoint choices; this pins them so a revert fails CI instead of prod.
// Measured guard (needs a browser + server): scripts/check-header-overflow.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Subscribe button only shows from xl (no room for it below 1280)', () => {
  const src = read('src/app/layout.tsx');
  assert.match(src, /<div className="hidden xl:block(?: empty:hidden)?">\s*<HeaderSubscribeButton \/>/);
});

test('HeaderSearch: inline input from lg, icon + overlay below lg', () => {
  const src = read('src/components/HeaderSearch.tsx');
  assert.match(src, /className="hidden lg:block relative"/, 'desktop input wrapper must be lg+');
  assert.match(src, /className="lg:hidden p-1\.5/, 'search icon button must show below lg');
  assert.match(src, /fixed inset-0 z-\[100\] bg-surface lg:hidden/, 'overlay must cover the icon range');
  assert.doesNotMatch(src, /hidden sm:block relative/, 'inline input at sm overflowed 640-1023px');
});

test('Sign in / My Shows label hides below md, control keeps its aria-label', () => {
  const src = read('src/components/HeaderUserIcon.tsx');
  assert.match(src, /<span className="hidden md:inline">Sign in<\/span>/);
  assert.match(src, /<span className="hidden md:inline">My Shows<\/span>/);
  assert.match(src, /aria-label="Sign in"/);
  assert.match(src, /aria-label="My Shows"/);
});

test('the measured overflow probe exists', () => {
  assert.ok(existsSync(new URL('./check-header-overflow.mjs', import.meta.url)));
});
