// BRO-3604 (owner decision 2026-10-11): browse-page show cards show the
// Tickets CTA on phones too, as a small .btn-primary button; sm+ keeps the
// inline text link. Source-level, like ticket-click-tracking.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/components/show-cards/ShowListCard.tsx'), 'utf8');

test('a phone-only Tickets button exists and uses the shared primary button class', () => {
  const m = src.match(/data-testid="ticket-cta-mobile"\s*\n\s*className="([^"]+)"/);
  assert.ok(m, 'ticket-cta-mobile element missing');
  const cls = m[1].split(/\s+/);
  assert.ok(cls.includes('sm:hidden'), 'mobile button must hide at sm+');
  assert.ok(cls.includes('btn-primary'), 'must use .btn-primary (design-system button hierarchy)');
  assert.ok(!cls.includes('hidden'), 'must be visible below sm');
});

test('the phone button is rendered in the compact (browse) card and shares the tracked click handler', () => {
  assert.match(src, /\{ticketCta\}\s*\n\s*<\/div>\s*\n\s*\{ticketCtaMobile\}/);
  const handlerUses = src.match(/\{\.\.\.ticketHandlers\}/g) || [];
  assert.equal(handlerUses.length, 2, 'desktop and mobile CTAs must share one tracked handler');
});

test('desktop inline CTA is unchanged (hidden below sm)', () => {
  assert.match(src, /className="hidden sm:inline-flex items-center gap-1 text-amber-400\/80/);
});
