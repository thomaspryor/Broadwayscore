/**
 * Regression test for Fallen Angels (2026-04-18) — Cote Notices was
 * registered with `domain: null`, which caused opening-night-poller.js:1044
 * (`if (!outlet.domain) continue;`) to silently skip SERP discovery.
 * The review ultimately landed as manual-entry.
 *
 * Run: node --test tests/unit/cote-notices-registry.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(__dirname, '../../data/outlet-registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

describe('Cote Notices outlet registry entry', () => {
  const entry = registry.outlets['cote-notices'];

  it('exists', () => {
    assert.ok(entry, 'cote-notices must be registered');
  });

  it('has a non-null domain (so SERP discovery is not skipped)', () => {
    assert.ok(entry.domain, 'cote-notices.domain must be truthy');
    assert.strictEqual(typeof entry.domain, 'string');
    assert.ok(
      entry.domain.length > 0,
      'cote-notices.domain must be a non-empty string',
    );
  });

  it('points at davidcote1.substack.com', () => {
    assert.strictEqual(entry.domain, 'davidcote1.substack.com');
  });

  it('is tier 3', () => {
    assert.strictEqual(entry.tier, 3);
  });
});
