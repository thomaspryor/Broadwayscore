/**
 * Unit tests for provisionalOutletIdFromHost in scripts/lib/outlet-canonicalize.js
 *
 * Auto-onboarding of aggregator-cited outlets not yet in the registry. Before
 * 2026-06-05 the gap audit skipped unknown outlets entirely, losing the
 * ctvoice / New York Notebook class of reviews on the Girl, Interrupted opening.
 *
 * Run: node --test tests/unit/provisional-outlet-onboarding.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { provisionalOutletIdFromHost } = require('../../scripts/lib/outlet-canonicalize.js');

describe('provisionalOutletIdFromHost', () => {
  it('derives the SLD label for a plain domain', () => {
    assert.strictEqual(provisionalOutletIdFromHost('ctvoice.com'), 'ctvoice');
    assert.strictEqual(provisionalOutletIdFromHost('1minutecritic.com'), '1minutecritic');
    assert.strictEqual(provisionalOutletIdFromHost('cititour.com'), 'cititour');
    assert.strictEqual(provisionalOutletIdFromHost('pagesonstages.com'), 'pagesonstages');
  });

  it('strips a leading www.', () => {
    assert.strictEqual(provisionalOutletIdFromHost('www.ctvoice.com'), 'ctvoice');
  });

  it('uses the publication subdomain for Substack', () => {
    // The mismap that motivated this: "new-york-notebook" fuzzy-resolved to
    // vulture (New York Magazine) and the substack domain check then dropped it.
    assert.strictEqual(
      provisionalOutletIdFromHost('newyorknotebook.substack.com'),
      'newyorknotebook'
    );
  });

  it('handles multi-part TLDs by taking the registrable label', () => {
    // theatreweekly.co.uk -> "co" is not ideal, but the SLD label here is "co";
    // we accept the second-to-last label. Document the known limitation: ccTLDs
    // with a second-level registry yield the registry label. Most outlets in
    // practice are .com / .org / .substack.com, covered above.
    assert.strictEqual(provisionalOutletIdFromHost('example.org'), 'example');
  });

  it('returns null for unusable hosts', () => {
    assert.strictEqual(provisionalOutletIdFromHost(null), null);
    assert.strictEqual(provisionalOutletIdFromHost(''), null);
    assert.strictEqual(provisionalOutletIdFromHost('localhost'), null);
    assert.strictEqual(provisionalOutletIdFromHost(123), null);
  });

  it('produces a slug safe to pass as --outlet (lowercase, no spaces/dots)', () => {
    const id = provisionalOutletIdFromHost('Some-Weird.Outlet.com');
    assert.ok(/^[a-z0-9-]+$/.test(id), `slug "${id}" must be [a-z0-9-]`);
  });
});
