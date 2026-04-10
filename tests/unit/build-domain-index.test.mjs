/**
 * Unit tests for buildDomainToOutletIndex precedence (review-normalization.js)
 *
 * The DoaS Apr 9-10 postmortem found that observer.domainAliases contained
 * "theguardian.com" — so URL→outlet resolution sometimes mapped Guardian
 * URLs to observer (depending on Object.entries iteration order). Similar
 * issue with wolf-entertainment-guide claiming newyorktheatreguide.com.
 *
 * The fix is two-fold:
 *   1. Data fix: remove the bad aliases from outlet-registry.json (S3-T2/T3)
 *   2. Code fix: make buildDomainToOutletIndex two-pass — primary domains
 *      always win over domainAliases, regardless of iteration order.
 *
 * This test exercises the live registry (post-data-fix) AND the precedence
 * rule via direct registry inspection.
 *
 * Refs: memory/project_doas_opening_night_issues.md issues #7, #8
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');

describe('Domain-to-outlet resolution precedence', () => {
  test('theguardian.com → guardian (not observer)', () => {
    const result = resolveOutletFromUrl('https://www.theguardian.com/stage/2026/apr/10/death-of-a-salesman-broadway-review');
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.outletId, 'guardian');
  });

  test('observer.co.uk → observer (alias still works for legitimate Observer URLs)', () => {
    const result = resolveOutletFromUrl('https://www.observer.co.uk/some-review');
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.outletId, 'observer');
  });

  test('newyorktheatreguide.com → nytg (not wolf-entertainment-guide)', () => {
    const result = resolveOutletFromUrl('https://www.newyorktheatreguide.com/reviews/death-of-a-salesman-review');
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.outletId, 'nytg');
  });

  test('nytimes.com → nytimes (sanity check, unaffected)', () => {
    const result = resolveOutletFromUrl('https://www.nytimes.com/2026/04/10/theater/death-of-a-salesman-review.html');
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.outletId, 'nytimes');
  });

  test('variety.com → variety (sanity check, unaffected)', () => {
    const result = resolveOutletFromUrl('https://variety.com/2026/legit/news/death-of-a-salesman-review-1236711360/');
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.outletId, 'variety');
  });
});

describe('outlet-registry.json data integrity', () => {
  // Read the registry directly to confirm the data fixes landed
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const registryPath = path.join(__dirname, '../../data/outlet-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  test('observer.domainAliases does NOT contain theguardian.com', () => {
    const aliases = registry.outlets.observer?.domainAliases || [];
    assert.ok(
      !aliases.includes('theguardian.com'),
      `observer.domainAliases should not contain theguardian.com (found: ${JSON.stringify(aliases)})`
    );
  });

  test('observer.domainAliases still contains observer.co.uk (not all aliases removed)', () => {
    const aliases = registry.outlets.observer?.domainAliases || [];
    assert.ok(
      aliases.includes('observer.co.uk'),
      `observer.domainAliases should still contain observer.co.uk for legitimate Observer URLs (found: ${JSON.stringify(aliases)})`
    );
  });

  test('wolf-entertainment-guide.domainAliases does NOT contain newyorktheatreguide.com', () => {
    const aliases = registry.outlets['wolf-entertainment-guide']?.domainAliases || [];
    assert.ok(
      !aliases.includes('newyorktheatreguide.com'),
      `wolf-entertainment-guide.domainAliases should not poison newyorktheatreguide.com (found: ${JSON.stringify(aliases)})`
    );
  });

  test('guardian.domain is theguardian.com (the primary)', () => {
    assert.strictEqual(registry.outlets.guardian?.domain, 'theguardian.com');
  });

  test('nytg.domain is newyorktheatreguide.com (the primary)', () => {
    // The defunct outlet wolf-entertainment-guide should NOT own this domain
    assert.strictEqual(registry.outlets.nytg?.domain, 'newyorktheatreguide.com');
  });
});
