// Owner decisions 2026-11-09 / 2026-11-10: the Get Tickets CTA leads the show
// hero's action cluster at EVERY width (phone, tablet, desktop) and is a big
// bar from sm up. Desktop had drifted to a small button placed last (BRO-7258).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hero = readFileSync(path.join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');
const listBtn = readFileSync(path.join(ROOT, 'src/components/user/ShowPageAddToListButton.tsx'), 'utf8');

const classOf = (testid) => {
  const m = hero.match(new RegExp(`<div className="([^"]*)" data-testid="${testid}">`));
  assert.ok(m, `${testid} wrapper missing`);
  return m[1];
};

test('ticket CTA slot is ordered first at every width', () => {
  const slot = classOf('hero-ticket-cta-slot');
  assert.match(slot, /(^|\s)order-first(\s|$)/);
  assert.doesNotMatch(slot, /\b[a-z]+:order-(none|last|\d+)\b/, 'a breakpoint override would push tickets back down');
  assert.match(slot, /(^|\s)flex(\s|$)/);
});

test('action cluster is a flex column at every width so order applies', () => {
  const cluster = classOf('hero-action-cluster');
  assert.match(cluster, /(^|\s)flex(\s|$)/);
  assert.match(cluster, /(^|\s)flex-col(\s|$)/);
  assert.doesNotMatch(cluster, /max-lg:|\blg:space-y/, 'space-y breaks when visual order differs from DOM order');
});

test('ticket CTA is rendered inside the slot', () => {
  const slotAt = hero.indexOf('data-testid="hero-ticket-cta-slot"');
  const ctaAt = hero.indexOf('<ShowPageTicketCTA');
  assert.ok(slotAt > -1 && ctaAt > slotAt);
});

test('primary ticket button is 56px tall from sm up and grows to fill the row at lg', () => {
  const m = hero.match(/primaryButtonClassName="([^"]*)"/);
  assert.ok(m, 'primaryButtonClassName missing');
  assert.match(m[1], /\bsm:h-14\b/);
  assert.match(m[1], /\blg:flex-1\b/);
  assert.doesNotMatch(m[1], /\blg:w-auto\b/, 'a shrink-to-fit button is the old small desktop CTA');
});

test('lottery pill matches the ticket bar height beside it at lg', () => {
  assert.match(hero, /lotteryPill\('hidden lg:inline-flex lg:h-14'\)/);
});

test('rate / want-to-see / list buttons share one 48px height from sm up', () => {
  const sm12 = hero.match(/h-10 sm:h-12 px-2 rounded-lg border/g) || [];
  assert.equal(sm12.length, 2, 'Want to See and Rate it');
  assert.match(listBtn, /hero: '[^']*\bsm:h-12\b/);
});

// Phone action card (owner decisions 2026-11-10: separate boxes, one label style, stars grouped "3b").
test('every phone label uses ONE style: 14px semibold, no text-xs on the hero buttons', () => {
  const cluster = hero.match(/data-testid="hero-action-cluster"[\s\S]*?Your plans/);
  assert.ok(cluster, 'action cluster block not found');
  assert.doesNotMatch(cluster[0], /text-xs sm:text-sm/, 'Want to See / Rate it must not shrink to 12px on phones');
  assert.doesNotMatch(listBtn.match(/hero: '[^']*'/)[0], /text-xs/);
  assert.match(listBtn, /<span className="text-sm font-semibold">/);
});

test('"Tap to rate" matches the button labels: sentence case, white, centered, not 11px muted caps', () => {
  const row = hero.match(/\{userFeaturesEnabled && showMobileStars && \([\s\S]*?\n      \)\}/);
  assert.ok(row, 'star row block not found');
  assert.match(row[0], /<p className="text-sm font-semibold text-white[^"]*">Tap to rate<\/p>/);
  assert.match(row[0], /text-center/);
  assert.doesNotMatch(row[0], /uppercase|text-\[11px\]|text-fg-muted/);
  assert.match(row[0], /mx-auto w-full max-w-\[\d+px\]/, 'stars are grouped in the middle, not spread edge to edge');
});

test('list button reads "Add to list" on phones and wraps instead of squeezing a third phone column', () => {
  // Reviewer catch 2026-11-10: a rated, signed-in viewer has THREE buttons; at 14px "Log another viewing"
  // overflows a 1/3 column on a 360-390px phone. Phones must never get an auto-width column.
  const grid = hero.match(/<div className=\{`grid gap-2 \$\{showRateButton[\s\S]*?\}`\}>/);
  assert.ok(grid, 'button grid not found');
  const unprefixed = grid[0].match(/(?<![:\w-])grid-cols-\[[^\]]*\]/g) || [];
  assert.deepEqual(unprefixed, [], 'phone grid must be plain grid-cols-1/2, no bracketed (auto) columns below sm');
  assert.match(grid[0], /'grid-cols-2 sm:grid-cols-\[1fr_1fr_auto\]'/);
  // "Log another viewing" is ~150px of text: it cannot share a phone row (158px column at 390). It spans the row.
  assert.match(hero, /\$\{hasRating \? 'col-span-2 order-last sm:col-span-1 sm:order-none' : ''\}/, 'rated Rate button takes its own phone row');
  assert.match(hero, /!isAuthenticated && showRateButton && hasRating \? 'col-span-2 sm:col-span-1'/, 'signed-out rated: Want to See spans too, no empty half');
  assert.match(listBtn, /<span className="sm:hidden">Add to list<\/span>/);
  assert.doesNotMatch(listBtn, /labelOnPhone|' w-10'/, 'no icon-only phone variant any more');
});

test('Get Tickets label is near-black on the gold (white on gold is 2.2-2.8:1, near-black 6.7+)', () => {
  const m = hero.match(/primaryButtonClassName="([^"]*)"/);
  assert.match(m[1], /text-\[#1a1208\]/);
  assert.doesNotMatch(m[1], /\btext-white\b/);
});
