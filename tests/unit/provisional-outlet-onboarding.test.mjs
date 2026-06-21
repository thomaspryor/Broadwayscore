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

  it('uses the publication subdomain for blog platforms (Substack, WordPress, etc.)', () => {
    // The mismap that motivated Substack: "new-york-notebook" fuzzy-resolved to
    // vulture (New York Magazine) and the substack domain check then dropped it.
    assert.strictEqual(provisionalOutletIdFromHost('newyorknotebook.substack.com'), 'newyorknotebook');
    // wordpress.com etc. were producing the junk slug "wordpress" before 2026-06-21.
    assert.strictEqual(provisionalOutletIdFromHost('pagesonstages.wordpress.com'), 'pagesonstages');
    assert.strictEqual(provisionalOutletIdFromHost('someblog.blogspot.com'), 'someblog');
  });

  it('takes the registrable label before a multi-part ccTLD (not "co")', () => {
    // Regression: .co.uk hosts produced the junk slug "co" (girl-interrupted
    // backfill 2026-06-21) — multiple UK shows got an outlet literally named "co".
    assert.strictEqual(provisionalOutletIdFromHost('londontheatre.co.uk'), 'londontheatre');
    assert.strictEqual(provisionalOutletIdFromHost('chorley-guardian.co.uk'), 'chorley-guardian');
    assert.strictEqual(provisionalOutletIdFromHost('example.com.au'), 'example');
  });

  it('takes the SLD label for plain TLDs', () => {
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
