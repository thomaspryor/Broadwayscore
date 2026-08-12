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
const { resolveOutletFromUrl, clearDomainCache } = require('../../scripts/lib/review-normalization.js');

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

describe('same-brand-word-across-TLDs base collisions (task #1254 class, BRO-247)', () => {
  // buildDomainToOutletIndex used to register every outlet under a bare
  // domainBase (TLD stripped) AND warn on every build when two legitimately
  // distinct outlets shared a brand word across TLDs — the exact
  // "Domain collision on \"dancemagazine\": keeping dance-magazine, ignoring
  // dance-informa-uk" noise. Such a bare base is genuinely ambiguous: each
  // outlet already resolves by its own full host. The fix leaves the base
  // unmapped and silent, while genuine same-full-host edition splits
  // (telegraph.co.uk) keep the eponymous rule.

  // Cross-TLD pairs: distinct outlets sharing a brand word but differing in host.
  const CROSS_TLD = [
    { base: 'dancemagazine', a: ['https://dancemagazine.com/x', 'dance-magazine'], b: ['https://dancemagazine.co.uk/x', 'dance-informa-uk'] },
    { base: 'independent', a: ['https://independent.com/x', 'santa-barbara-independent'], b: ['https://www.independent.co.uk/x', 'independent'] },
    { base: 'boston', a: ['https://boston.com/x', 'boston-com'], b: ['https://boston.edgemedianetwork.com/x', 'edge-boston'] },
  ];

  test('the bare brand base resolves to NO outlet (genuinely ambiguous)', () => {
    for (const { base } of CROSS_TLD) {
      const result = resolveOutletFromUrl(`https://${base}/x`);
      assert.strictEqual(result, null, `bare base "${base}" must not resolve to an arbitrary outlet`);
    }
  });

  test('each outlet still resolves via its own full host (unchanged)', () => {
    for (const { a, b } of CROSS_TLD) {
      assert.strictEqual(resolveOutletFromUrl(a[0])?.outletId, a[1], `${a[0]} should resolve to ${a[1]}`);
      assert.strictEqual(resolveOutletFromUrl(b[0])?.outletId, b[1], `${b[0]} should resolve to ${b[1]}`);
    }
  });

  test('building the index emits NO collision warning for the cross-TLD class', () => {
    clearDomainCache();
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      resolveOutletFromUrl('https://nytimes.com/x'); // forces a fresh index build
    } finally {
      console.warn = orig;
    }
    for (const { base } of CROSS_TLD) {
      const noisy = warnings.filter((w) => w.includes('Domain collision') && w.includes(`"${base}"`));
      assert.deepStrictEqual(noisy, [], `no collision warning expected for cross-TLD base "${base}", got: ${JSON.stringify(noisy)}`);
    }
  });

  test('genuine same-full-host edition split keeps its bare base (telegraph → telegraph)', () => {
    // telegraph.co.uk is shared by telegraph AND sunday-telegraph (one host),
    // so the eponymous rule still applies and the base stays mapped.
    assert.strictEqual(resolveOutletFromUrl('https://telegraph/x')?.outletId, 'telegraph');
    assert.strictEqual(resolveOutletFromUrl('https://www.telegraph.co.uk/x')?.outletId, 'telegraph');
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
