// BRO-2459: a critic known for a T1 outlet who publishes on substack must be
// attributed by URL domain, never by critic/outlet name (paranormal-activity-2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveCanonicalOutletId } = require('./outlet-canonicalize.js');

test('explicit vulture outlet on a newyorknotebook.substack.com URL is not attributed to vulture', () => {
  const r = resolveCanonicalOutletId({ outletArg: 'vulture', url: 'https://newyorknotebook.substack.com/p/paranormal-activity' });
  assert.notEqual(r.outletId, 'vulture');
  assert.match(r.outletId, /notebook|substack/);
});

test('generic substack host falls back to a host-derived provisional outlet', () => {
  const r = resolveCanonicalOutletId({ outletArg: 'Vulture', url: 'https://substack.com/p/x' });
  assert.notEqual(r.outletId, 'vulture');
  assert.equal(r.source, 'slug-fallback');
});
