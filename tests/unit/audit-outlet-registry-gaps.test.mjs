/**
 * BRO-3909 — main test.yml red: "Audit outlet-registry gaps" (31 consecutive
 * pushes). Root cause: grabyourgroupandgo.com, a Broadway/Off-Broadway GROUP
 * ticket sales business, is not a review outlet. Its "review" of The Cherry
 * Orchard (Park Avenue Armory) is group-rate marketing copy ("Your ticket
 * price includes our favorable group ticket pricing of $178 plus a $32
 * service fee"), ingested via submit-review-form under a domainless outletId
 * derived from the host — same failure class as the BRO-2774 junk domains
 * (tickpick, ents24, studioseaview, ...): nothing had ingested this host
 * before, so it reddened `audit-outlet-registry.js --strict` as a NEW
 * unregistered outlet rather than showing up in the pre-existing baseline.
 *
 * data/audit/outlet-registry-baseline.json is a SNAPSHOT that
 * --update-baseline rewrites wholesale from present state, so baselining this
 * outletId would only mask it until its review file is renamed or deleted —
 * the fix belongs in domain-filters.js (see BRO-2774's own regression test,
 * tests/unit/domain-filters-bro2774.test.mjs, for the same rationale). This
 * pins both the domain block AND the audit-exclusion outcome it feeds so a
 * future refactor of either can't silently reopen this exact gap.
 *
 * A second, independent outletId (theatremonkey.com) surfaced as a NEW gap
 * in the same run while this fix was being verified against the live
 * corpus — a real, long-standing West End seat-guide/review site that had
 * simply never been registered. Registered in data/outlet-registry.json
 * (tier 3) rather than blocked, since it is a genuine outlet. Pinned below
 * so deleting the registry entry (which would silently reopen this gap,
 * per ship-check adversarial review) fails a test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { isBlockedDomain, isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');
const { isExcludedFromOutletRegistryAudit } = require('../../scripts/lib/outlet-registry-audit-exclusions.js');
const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'outlet-registry.json'), 'utf8'));

const JUNK_URL = 'https://grabyourgroupandgo.com/event/the-cherry-orchard-radically-re-imagined-at-the-armory-who-will-go-i-wonder/';

test('BRO-3909: grabyourgroupandgo.com is blocked by domain', () => {
  assert.equal(isBlockedDomain('grabyourgroupandgo.com'), true);
  assert.equal(isBlockedReviewUrl(JUNK_URL), true);
});

test('BRO-3909: a review filed under grabyourgroupandgo.com is excluded from the outlet-registry gap audit', () => {
  const review = {
    showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026',
    outletId: 'grabyourgroupandgo',
    outlet: 'grabyourgroupandgo',
    url: JUNK_URL,
  };
  assert.equal(isExcludedFromOutletRegistryAudit(review), true);
});

test('BRO-3909: an unrelated real-outlet review is NOT excluded (sanity check against over-blocking)', () => {
  const review = {
    showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026',
    outletId: 'new-outlet',
    outlet: 'New Outlet',
    url: 'https://new-outlet.com/reviews/the-cherry-orchard',
    score: 80,
  };
  assert.equal(isExcludedFromOutletRegistryAudit(review), false);
});

test('BRO-3909: theatremonkey is registered (tier 3, theatremonkey.com)', () => {
  const entry = registry.outlets.theatremonkey;
  assert.ok(entry, 'data/outlet-registry.json must have a "theatremonkey" entry');
  assert.equal(entry.tier, 3);
  assert.equal(entry.domain, 'theatremonkey.com');
});
