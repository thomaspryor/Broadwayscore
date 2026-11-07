// BRO-4303: P2 trio from the BRO-4294 ship-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIsoDateOnly } from '../../src/lib/iso-date-only.ts';

test('isIsoDateOnly accepts only real YYYY-MM-DD dates', () => {
  assert.equal(isIsoDateOnly('2026-06-24'), true);
  for (const bad of ['', 'Jun 24', '2026-6-24', '2026-02-31', '2026-06-24T00:00:00Z', null, undefined, 20260624]) {
    assert.equal(isIsoDateOnly(bad), false, String(bad));
  }
});

test('RatingEditor guards suggestedDateSeen with isIsoDateOnly', () => {
  const src = readFileSync('src/components/user/RatingEditor.tsx', 'utf8');
  assert.match(src, /isIsoDateOnly\(suggestedDateSeen\)/);
  assert.doesNotMatch(src, /\|\| suggestedDateSeen \|\|/);
});

test('every header/menu avatar goes through AvatarImage (onError fallback)', () => {
  for (const f of ['src/components/HamburgerMenu.tsx', 'src/components/HeaderUserIcon.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /<AvatarImage/, f);
    assert.doesNotMatch(src, /<img\b/, `${f} has a bare <img>`);
  }
  assert.match(readFileSync('src/components/AvatarImage.tsx', 'utf8'), /onError=/);
});

test('ShowSearchDropdown mobile min-width is bounded by its container', () => {
  const src = readFileSync('src/components/show-cards/ShowSearchDropdown.tsx', 'utf8');
  assert.match(src, /min-w-\[min\(100%,calc\(100vw-2rem\)\)\]/);
  assert.doesNotMatch(src, /min-w-\[calc\(100vw-2rem\)\]/);
});
