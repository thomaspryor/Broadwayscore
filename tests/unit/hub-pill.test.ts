/**
 * Header market pill on city-hub pages (BRO-6930). Calls the real hubForPath export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hubForPath, HUB_CITIES } from '../../src/lib/city-hub';

test('every launched hub resolves to itself with a short pill label', () => {
  for (const [slug, hub] of Object.entries(HUB_CITIES)) {
    assert.equal(hubForPath(`/tours/${slug}`)?.slug, slug);
    assert.equal(hubForPath(`/tours/${slug}/archive`)?.slug, slug);
    assert.ok(hub.cardLabel && hub.cardLabel.length <= 10, `${slug} cardLabel fits the pill`);
  }
});

test('non-hub paths return null (Broadway, West End, staged cities, near-miss slugs)', () => {
  for (const p of ['/', '/west-end', '/tours', '/tours/san-diego-ca', '/tours/chicago', '/tours/chicago-ilx', '/show/wicked']) {
    assert.equal(hubForPath(p), null, p);
  }
});
