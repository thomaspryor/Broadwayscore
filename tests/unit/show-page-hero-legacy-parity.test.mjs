// The redesigned hero must keep everything the legacy header carried that is
// not a deliberate design decision. The rollout (2026-10-02) silently dropped
// the Add to list button, the Limited Run badge, the Critics' Take fallbacks,
// the "N more for a CriticScore" progress line, the lottery pill for shows with
// no ticket links, and the market in the poster alt text. This guard fails if
// any of them stops being wired into ShowHeroRedesign again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('src/app/show/[slug]/page.tsx');
const HERO = read('src/components/show-page/ShowHeroRedesign.tsx');

test('hero renders the Add to list button for signed-in users only', () => {
  assert.match(HERO, /\{isAuthenticated && <ShowPageAddToListButton showId=\{show\.id\} variant="hero" \/>\}/);
  assert.match(HERO, /isAuthenticated \? 'grid-cols-\[1fr_1fr_auto\]' : 'grid-cols-2'/);
});

test('hero renders the shared Limited Run badge for limitedRun shows', () => {
  assert.match(HERO, /show\.limitedRun && <LimitedRunBadge \/>/);
  assert.ok(!/function LimitedRunBadge/.test(PAGE), 'page.tsx must import the shared LimitedRunBadge, not redefine it');
});

test('hero shows both Critics\' Take fallbacks when there is no consensus', () => {
  assert.match(HERO, /criticsTakeMode === 'coming-soon'/);
  assert.match(HERO, /criticsTakeMode === 'synopsis'/);
  assert.match(PAGE, /criticsTakeMode=\{criticsTakeMode\}/);
});

test('awaiting card says how many more reviews unlock a CriticScore', () => {
  assert.match(HERO, /more for a CriticScore/);
  assert.match(PAGE, /reviewsRemaining=\{reviewsRemaining\}/);
});

test('lottery pill is rendered even when TicketButtonsAB does not mount', () => {
  // One call feeds TicketButtonsAB.secondaryAfter, a second is the standalone fallback.
  const calls = HERO.match(/lotteryPill\(/g) ?? [];
  assert.equal(calls.length, 2, 'expected the secondaryAfter and standalone call sites');
  assert.match(HERO, /!\(sortedTicketLinks\.length > 0 \|\| Boolean\(show\.officialUrl\)\) && lotteryPill\(/);
});

test('poster alt text names the market and format', () => {
  assert.match(HERO, /alt=\{`\$\{show\.title\} \$\{posterMarketLabel\} \$\{show\.type\} poster`\}/);
});
