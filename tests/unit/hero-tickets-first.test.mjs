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
