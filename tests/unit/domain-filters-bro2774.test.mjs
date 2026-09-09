/**
 * BRO-2774 — junk-outlet exclusion must live in domain-filters, not in the
 * outlet-registry baseline.
 *
 * data/audit/outlet-registry-baseline.json is a SNAPSHOT of the outletIds that
 * happen to be missing from the registry right now, and `--update-baseline`
 * rewrites the whole list from present state. So a junk entry silently drops
 * out of it the moment its review file is removed or renamed, and reds the
 * outlet-registry gate all over again the next time any file from that domain
 * is ingested. Two of the four domains adjudicated by earlier crown cycles
 * (tickpick, studioseaview) had already vanished from the baseline by
 * 2026-09-04, and anthearepresents reddened the gate a second time on the very
 * file a previous cycle had adjudicated.
 *
 * These assertions are the durable half of that fix: the baseline may decay,
 * but a domain removed from the block-list fails here.
 *
 * Each domain below was read at the file level in data/review-texts/ before
 * being blocked — see the citations in scripts/lib/domain-filters.js. None was
 * pattern-matched from its name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBlockedDomain, isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');

/** Junk domains, with the URL shape actually seen in the corpus. */
const BLOCKED = [
  ['anthearepresents.com', 'https://anthearepresents.com/credit/a-month-in-the-country'],
  ['ents24.com', 'https://www.ents24.com/london-events/donmar-warehouse/a-month-in-the-country/7458547'],
  ['tickpick.com', 'https://www.tickpick.com/buy-the-family-album-tickets-sheila-hughes-potiker-theatre-at-mandell-weiss-center-8-7-26-7pm/7860272/'],
  ['studioseaview.com', 'https://studioseaview.com/show/well-ill-let-you-go/'],
];

/**
 * Real review outlets that must keep flowing. london-theatreland.co.uk is here
 * deliberately: it is a listing site that ALSO publishes original editorial
 * reviews at /reviews/our/<show>, so it is the nearest neighbour to the ticket
 * platforms added above and the likeliest thing to be over-blocked by a
 * careless widening of TICKET_DOMAINS.
 */
const ALLOWED = [
  'nytimes.com',
  'vulture.com',
  'variety.com',
  'theatermania.com',
  'whatsonstage.com',
  'thestage.co.uk',
  'london-theatreland.co.uk',
];

test('BRO-2774 junk domains are blocked by domain, not by a decaying baseline', async (t) => {
  for (const [domain, url] of BLOCKED) {
    await t.test(`${domain} is blocked`, () => {
      assert.equal(isBlockedDomain(domain), true, `${domain} must be in a domain-filters block set`);
      assert.equal(isBlockedReviewUrl(url), true, `the corpus URL for ${domain} must be blocked`);
    });
  }
});

test('BRO-2774 widening did not catch real review outlets', async (t) => {
  for (const domain of ALLOWED) {
    await t.test(`${domain} still passes`, () => {
      assert.equal(isBlockedDomain(domain), false, `${domain} is a real review outlet and must not be blocked`);
    });
  }
});
