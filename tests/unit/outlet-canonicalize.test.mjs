/**
 * Unit tests for resolveCanonicalOutletId (scripts/lib/outlet-canonicalize.js).
 *
 * Fixtures drawn from the 2026-04-23 Rocky Horror opening + 2021 SIX drift.
 * Those 5 files caused class-C domain-mismatch audits to fail and kept Data
 * Validation red on main for ~16 hours. This test proves the helper catches
 * the drift before it's written.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalOutletId, _buildDomainMap } = require('../../scripts/lib/outlet-canonicalize.js');

describe('resolveCanonicalOutletId — 2026-04-23 Rocky Horror drift fixtures', () => {
  test('davidcote-substack + davidcote1.substack.com → cote-notices (URL wins)', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'davidcote-substack',
      url: 'https://davidcote1.substack.com/p/the-rocky-horror-show-our-lust-is',
    });
    assert.strictEqual(r.outletId, 'cote-notices');
    assert.strictEqual(r.source, 'url');
    assert.ok(r.warning, 'should warn about unregistered input');
  });

  test('nystagereview + nystagereview.com → nysr (alias already resolves; URL confirms)', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'nystagereview',
      url: 'https://nystagereview.com/2026/04/23/the-rocky-horror-show/',
    });
    assert.strictEqual(r.outletId, 'nysr');
    assert.strictEqual(r.source, 'url');
  });

  test('newyorktheatreguide + newyorktheatreguide.com → nytg', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'newyorktheatreguide',
      url: 'https://www.newyorktheatreguide.com/reviews/the-rocky-horror-show-broadway-review-luke-evans',
    });
    assert.strictEqual(r.outletId, 'nytg');
    assert.strictEqual(r.source, 'url');
  });
});

describe('resolveCanonicalOutletId — 2021 SIX drift fixture', () => {
  test('edge-media-network + boston.edgemedianetwork.com → edge-boston (URL beats generic input)', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'edge-media-network',
      url: "https://boston.edgemedianetwork.com/entertainment/theatre///280939/Queens%20Have%20Their%20Say%20in%20Sizzling%20'Six'",
    });
    assert.strictEqual(r.outletId, 'edge-boston');
    assert.strictEqual(r.source, 'url');
    assert.ok(r.warning, 'should warn about input-vs-URL canonical drift');
    assert.match(r.warning, /edge-media-network/);
    assert.match(r.warning, /edge-boston/);
  });
});

describe('resolveCanonicalOutletId — happy paths', () => {
  test('human-readable outlet name + URL → canonical (display-name input)', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'The New York Times',
      url: 'https://www.nytimes.com/2026/04/23/theater/rocky-horror-review.html',
    });
    assert.strictEqual(r.outletId, 'nytimes');
  });

  test('alias input, no URL → alias resolution', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'nystagereview',
      url: null,
    });
    assert.strictEqual(r.outletId, 'nysr');
    assert.strictEqual(r.source, 'alias');
  });
});

describe('resolveCanonicalOutletId — edge cases', () => {
  test('unregistered outlet + no URL → slug fallback with warning', () => {
    const r = resolveCanonicalOutletId({
      outletArg: 'bogus-unregistered-blog-12345',
      url: null,
    });
    assert.strictEqual(r.source, 'slug-fallback');
    assert.ok(r.warning);
    assert.match(r.warning, /not registered/);
  });

  test('missing outletArg throws', () => {
    assert.throws(() => resolveCanonicalOutletId({ outletArg: '', url: null }));
    assert.throws(() => resolveCanonicalOutletId({ url: null }));
  });

  test('ambiguous domain (timeout.com hosts timeout-ny AND timeout-london) falls through to alias', () => {
    // timeout.com is an AMBIGUOUS_DOMAINS fixture — multiple outlets share it.
    // URL can't disambiguate; input string must.
    const r = resolveCanonicalOutletId({
      outletArg: 'timeout',
      url: 'https://www.timeout.com/newyork/theater/rocky-horror-review',
    });
    // Should fall through to alias resolution (timeout → some canonical), not
    // pick one of the shared canonicals from URL.
    assert.notStrictEqual(r.source, 'url');
    assert.ok(r.outletId, 'resolves to some canonical via alias');
  });
});

describe('_buildDomainMap — same-brand-word-across-TLDs class (task #1254 / BRO-247)', () => {
  // silent-exclusion-detectors.js (#1254) and review-normalization.js's
  // buildDomainToOutletIndex (BRO-247, PR #573) both had the same bug: they
  // stripped the TLD to a bare "domainBase" fallback key, so two legitimately
  // distinct outlets sharing a brand word across TLDs (dancemagazine.com vs
  // dancemagazine.co.uk) collided on the bare key and printed a live warning
  // every build. outlet-canonicalize.js's _buildDomainMap() never had that
  // bug — it keys the map by the outlet's FULL registered domain/domainAliases
  // string, no TLD stripping — so dancemagazine.com and dancemagazine.co.uk
  // were never the same key and never collided. These tests lock that in so a
  // future edit can't reintroduce the class a third time by "generalizing"
  // this function to match the other two's old (buggy) bare-base behavior.
  const CROSS_TLD = [
    { a: 'dancemagazine.com', aId: 'dance-magazine', b: 'dancemagazine.co.uk', bId: 'dance-informa-uk' },
    { a: 'independent.com', aId: 'santa-barbara-independent', b: 'independent.co.uk', bId: 'independent' },
    { a: 'boston.com', aId: 'boston-com', b: 'boston.edgemedianetwork.com', bId: 'edge-boston' },
  ];

  test('each full-TLD domain resolves to its own outlet, independently of its cross-TLD sibling', () => {
    const { domainToOutlet, ambiguous } = _buildDomainMap();
    for (const { a, aId, b, bId } of CROSS_TLD) {
      assert.strictEqual(ambiguous.has(a), false, `${a} must not be marked ambiguous`);
      assert.strictEqual(ambiguous.has(b), false, `${b} must not be marked ambiguous`);
      assert.strictEqual(domainToOutlet[a], aId, `${a} should resolve to ${aId}`);
      assert.strictEqual(domainToOutlet[b], bId, `${b} should resolve to ${bId}`);
    }
  });

  test('resolveCanonicalOutletId resolves both sides of a cross-TLD brand pair via URL', () => {
    for (const { a, aId, b, bId } of CROSS_TLD) {
      const ra = resolveCanonicalOutletId({ outletArg: aId, url: `https://${a}/x` });
      const rb = resolveCanonicalOutletId({ outletArg: bId, url: `https://${b}/x` });
      assert.strictEqual(ra.outletId, aId);
      assert.strictEqual(ra.source, 'url');
      assert.strictEqual(rb.outletId, bId);
      assert.strictEqual(rb.source, 'url');
    }
  });
});
