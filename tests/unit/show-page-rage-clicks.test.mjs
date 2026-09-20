// Regression test for task #90 ("Rage clicks on Rocky Horror & Who's Tommy
// show pages").
//
// Investigation: /show/the-rocky-horror-show-2026 and
// /show/the-whos-tommy-2024 each recorded 2 rage clicks in a week. Ruled out
// the known ReviewsList key-collision bug (task #64 / card "Rage clicks on
// /show/proof") — Rocky Horror does have a same-day multi-critic collision
// (nysr, 2026-04-23) but getReviewKey already disambiguates it correctly, and
// Who's Tommy has no such collision at all.
//
// Root cause for Who's Tommy: it's a closed show with ZERO ticketLinks ever
// recorded. TicketButtonsAB renders nothing at all for closed shows
// (src/components/TicketButtonsAB.tsx), so the "This show has closed" note
// (added by commit 73da61c0605 for card #228) is the only thing standing
// between the ticket-CTA area and a silent gap. That commit gated the note on
// `(show.ticketLinks?.length ?? 0) > 0` — meant to widen coverage to shows
// whose only link was a HIDDEN_PLATFORMS entry, but it also excluded shows
// with genuinely zero ticketLinks, reproducing the exact silent-gap bug the
// commit was fixing. Fix: src/lib/ticket-cta-note.js's getTicketCtaNote
// checks status alone for the 'closed' case; both
// src/app/show/[slug]/page.tsx and src/components/show-page/
// ShowHeroRedesign.tsx now share this one function instead of each hardcoding
// their own (already-drifted) copy of the condition.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getTicketCtaNote } = require('../../src/lib/ticket-cta-note.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('getTicketCtaNote', () => {
  test('closed show with zero ticketLinks still gets the closed note (task #90 / the-whos-tommy-2024)', () => {
    assert.equal(getTicketCtaNote('closed', [], []), 'closed');
    assert.equal(getTicketCtaNote('closed', undefined, []), 'closed');
    assert.equal(getTicketCtaNote('closed', null, []), 'closed');
  });

  test('closed show with ticketLinks still gets the closed note (pre-existing case)', () => {
    assert.equal(getTicketCtaNote('closed', [{ priceFrom: 99 }], []), 'closed');
  });

  test('open show gets no note', () => {
    assert.equal(getTicketCtaNote('open', [{ priceFrom: 99 }], [{ priceFrom: 99 }]), null);
    assert.equal(getTicketCtaNote('open', [], []), null);
  });

  test('announced show with unpriced links gets the not-yet-on-sale note', () => {
    assert.equal(
      getTicketCtaNote('announced', [{ priceFrom: null }], [{ priceFrom: null }]),
      'announced-not-on-sale'
    );
  });

  test('announced show with zero ticketLinks gets no note (nothing to explain yet)', () => {
    assert.equal(getTicketCtaNote('announced', [], []), null);
  });

  test('announced show with a priced link gets no note', () => {
    assert.equal(
      getTicketCtaNote('announced', [{ priceFrom: 50 }], [{ priceFrom: 50 }]),
      null
    );
  });
});

describe('show page + ShowHeroRedesign both consume the shared helper', () => {
  test('src/app/show/[slug]/page.tsx imports getTicketCtaNote from ticket-cta-note, not a local re-implementation', () => {
    const src = readFileSync(join(ROOT, 'src/app/show/[slug]/page.tsx'), 'utf8');
    assert.match(src, /from ['"]@\/lib\/ticket-cta-note['"]/);
    // Guards against re-introducing the ticketLinks.length > 0 gate on the
    // closed-note branch specifically (a plain status check is fine, e.g.
    // inside getTicketCtaNote itself or the isClosed helper var).
    assert.doesNotMatch(
      src,
      /show\.status === 'closed' && \(show\.ticketLinks\?\.length \?\? 0\) > 0/
    );
  });

  test('ShowHeroRedesign.tsx imports getTicketCtaNote from ticket-cta-note, not a local re-implementation', () => {
    const src = readFileSync(join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');
    assert.match(src, /from ['"]@\/lib\/ticket-cta-note['"]/);
    assert.doesNotMatch(
      src,
      /isClosed && \(show\.ticketLinks\?\.length \?\? 0\) > 0/
    );
  });
});
