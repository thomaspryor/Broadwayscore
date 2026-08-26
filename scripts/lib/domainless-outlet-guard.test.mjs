import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOutletEligibleForSerpDiscovery, OUTLET_DOMAINS } from './url-discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Worktrees never have their own data/ — fall back to the canonical repo,
// same idiom as url-discovery.js's buildOutletDomains() (task #983).
const CANONICAL_REPO = '/Users/tompryor/Broadwayscore';
const localRegistryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
const registryPath = fs.existsSync(localRegistryPath) ? localRegistryPath : path.join(CANONICAL_REPO, 'data', 'outlet-registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const outlets = registry.outlets || registry;

// Task #766 evidence: these were the 14 West End SERP outlets with domain:null
// at the time the bug was found. guardian-uk / telegraph-uk are ghost dupes of
// guardian / telegraph, removed as separate entries.
//
// Of the other 12, 9 were backfilled with real, verified, still-LIVE domains
// during the 2026-08-16 re-triage (each cross-checked against an actually-
// fetched review URL in the review-texts archive plus an external source —
// see data/outlet-registry.json diff for the per-outlet justification trail).
//
// 3 were backfilled and then REVERTED to domainless on the same day, after
// /ship-check's adversarial review caught (and curl -I independently
// confirmed) that the "verified" domain no longer serves the outlet's own
// content: chichester-observer and midhurst-and-petworth-observer both
// 301-redirect to the shared, multi-title sussexexpress.co.uk (National
// World consolidated ~16 Sussex titles onto one domain — setting it as
// EITHER outlet's registry domain would let a review from any of the other
// 15 titles pass that outlet's host guard, reintroducing a narrower version
// of the exact vacuousness this task exists to close); the-journal's
// journallive.co.uk now returns HTTP 410 Gone, and its living content sits
// on chroniclelive.co.uk — already registered to the sibling outlet
// evening-chronicle, so assigning it here would collide two distinct
// outletIds onto one host. The registry has no path-scoped domain field to
// disambiguate co-hosted titles, so domain: null (SERP arm skipped, per the
// CI gate below) is the honest state for these 3 until it does.
const EVIDENCE_WE_KEYS = [
  'the-herald', 'chichester-observer', 'daily-echo',
  'midhurst-and-petworth-observer', 'the-bucks-herald', 'click-liverpool',
  'evening-chronicle', 'nottingham-confidential', 'the-journal',
  'western-mail', 'guardian-uk', 'telegraph-uk', 'oxfordshire-guardian',
  'tribune',
];
const STILL_DOMAINLESS_BY_DESIGN = new Set([
  'chichester-observer', 'midhurst-and-petworth-observer', 'the-journal',
]);

test('outlet with domain: null is not eligible for SERP discovery', () => {
  // Picked dynamically (not hardcoded to one of the evidence keys above) so this
  // test survives future domain backfills — it only needs the registry to still
  // contain at least one domainless outlet, which the corpus-wide gate below
  // doesn't require to be zero.
  const anyDomainless = Object.entries(outlets).find(([, v]) => !v.domain);
  assert.ok(anyDomainless, 'expected at least one domainless outlet in the registry to exercise this branch');
  assert.equal(isOutletEligibleForSerpDiscovery(anyDomainless[0]), false);
});

test('a real outlet with a registered domain is eligible for SERP discovery', () => {
  assert.equal(isOutletEligibleForSerpDiscovery('telegraph'), true);
  assert.equal(OUTLET_DOMAINS['telegraph'], 'telegraph.co.uk');
});

test('missing/blank outletId is not eligible', () => {
  assert.equal(isOutletEligibleForSerpDiscovery(''), false);
  assert.equal(isOutletEligibleForSerpDiscovery(undefined), false);
  assert.equal(isOutletEligibleForSerpDiscovery('not-a-real-outlet'), false);
});

test('every evidence key is either a real domained outlet or no longer a separate registry entry', () => {
  for (const key of EVIDENCE_WE_KEYS) {
    const outlet = outlets[key];
    if (!outlet) {
      // guardian-uk / telegraph-uk merged away entirely — nothing left to check.
      continue;
    }
    const eligible = isOutletEligibleForSerpDiscovery(key);
    assert.equal(eligible, !!outlet.domain,
      `${key}: eligibility (${eligible}) must match presence of a real registry domain (${outlet.domain})`);
  }
});

test('guardian-uk and telegraph-uk are resolved: gone, or carry a real distinct domain', () => {
  for (const key of ['guardian-uk', 'telegraph-uk']) {
    const outlet = outlets[key];
    if (!outlet) continue; // removed as a separate entry — resolved
    assert.ok(outlet.domain, `${key} still exists as a separate entry with no domain — the exact vacuous-guard bug`);
  }
});

test('CI gate: no domainless outlet in the registry — present or future — is ever eligible for the SERP candidate set', () => {
  // Corpus-wide invariant, not just the 14 evidence keys: as long as this
  // holds, no new outlet added to outlet-registry.json with domain: null (or
  // any future edit to buildOutletDomains()) can silently re-enable the
  // vacuous host guard, because eligibility is derived purely from whether
  // OUTLET_DOMAINS resolved a real domain for the id.
  const violations = [];
  for (const [key, outlet] of Object.entries(outlets)) {
    if (outlet.domain) continue;
    if (isOutletEligibleForSerpDiscovery(key)) violations.push(key);
  }
  assert.deepEqual(violations, [], `domainless outlets wrongly ruled eligible: ${violations.join(', ')}`);
});

test('the 8 evidence WE outlets with a live domain are backfilled and SERP-eligible', () => {
  // 'the-herald' dropped out of this set (task #1758): merged away entirely
  // into 'herald' (an accidental registry duplicate, same paper/critics, not
  // a distinct domain) rather than backfilled with its own domain — same
  // "gone, or carries a real domain" resolution as guardian-uk/telegraph-uk.
  const backfilled = EVIDENCE_WE_KEYS.filter(
    k => !['guardian-uk', 'telegraph-uk', 'the-herald'].includes(k) && !STILL_DOMAINLESS_BY_DESIGN.has(k)
  );
  for (const key of backfilled) {
    const outlet = outlets[key];
    assert.ok(outlet, `${key} missing from registry entirely`);
    assert.ok(outlet.domain, `${key} is still domainless — task #766 backfill regressed`);
    assert.equal(isOutletEligibleForSerpDiscovery(key), true, `${key} has a domain but was ruled ineligible`);
  }
});

test('the 3 deliberately-still-domainless evidence outlets stay domainless and skip SERP', () => {
  for (const key of STILL_DOMAINLESS_BY_DESIGN) {
    const outlet = outlets[key];
    assert.ok(outlet, `${key} missing from registry entirely`);
    assert.ok(!outlet.domain, `${key} unexpectedly has a domain — re-verify it's still live before assigning one`);
    assert.equal(isOutletEligibleForSerpDiscovery(key), false, `${key} has no domain but was ruled eligible`);
  }
});
