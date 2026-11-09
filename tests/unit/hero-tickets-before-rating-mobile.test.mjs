// Owner decision 2026-11-09: on mobile web the Get Tickets CTA sits above the
// rating / want-to-see / list buttons in the show hero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hero = readFileSync(path.join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');

test('ticket CTA slot is ordered first below lg', () => {
  const slot = hero.match(/<div className="([^"]*)" data-testid="hero-ticket-cta-slot">/);
  assert.ok(slot, 'hero-ticket-cta-slot wrapper missing');
  assert.match(slot[1], /\border-first\b/);
  assert.match(slot[1], /\blg:order-none\b/);
});

test('action cluster is a flex column below lg so order applies', () => {
  const cluster = hero.match(/<div className="([^"]*)" data-testid="hero-action-cluster">/);
  assert.ok(cluster, 'hero-action-cluster wrapper missing');
  assert.match(cluster[1], /max-lg:flex/);
  assert.match(cluster[1], /max-lg:flex-col/);
});

test('ticket CTA is rendered inside the slot', () => {
  const slotAt = hero.indexOf('data-testid="hero-ticket-cta-slot"');
  const ctaAt = hero.indexOf('<ShowPageTicketCTA');
  assert.ok(slotAt > -1 && ctaAt > slotAt);
});
