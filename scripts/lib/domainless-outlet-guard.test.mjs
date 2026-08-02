import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOutletEligibleForSerpDiscovery, OUTLET_DOMAINS } from './url-discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const outlets = registry.outlets || registry;

// Task #766 evidence: these were the 14 West End SERP outlets with domain:null
// at the time the bug was found. guardian-uk / telegraph-uk are ghost dupes of
// guardian / telegraph and are expected to be removed as separate entries (or
// carry a real distinct domain) — the other 12 are genuinely domainless.
const EVIDENCE_WE_KEYS = [
  'the-herald', 'chichester-observer', 'daily-echo',
  'midhurst-and-petworth-observer', 'the-bucks-herald', 'click-liverpool',
  'evening-chronicle', 'nottingham-confidential', 'the-journal',
  'western-mail', 'guardian-uk', 'telegraph-uk', 'oxfordshire-guardian',
  'tribune',
];

test('outlet with domain: null is not eligible for SERP discovery', () => {
  assert.equal(isOutletEligibleForSerpDiscovery('daily-echo'), false);
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

test('the 12 genuinely domainless WE outlets all resolve to skip (current registry state)', () => {
  const genuinelyDomainless = EVIDENCE_WE_KEYS.filter(k => !['guardian-uk', 'telegraph-uk'].includes(k));
  for (const key of genuinelyDomainless) {
    const outlet = outlets[key];
    assert.ok(outlet, `${key} missing from registry entirely`);
    if (!outlet.domain) {
      assert.equal(isOutletEligibleForSerpDiscovery(key), false, `${key} has no domain but was ruled eligible`);
    }
  }
});
