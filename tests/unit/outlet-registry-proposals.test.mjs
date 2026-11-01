import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildProposals } = require('../../scripts/lib/outlet-registry-proposals.js');

const reg = { nyt: { domain: 'nytimes.com', domainAliases: ['nyt.com'] } };
const o = (host, id, n, extra = {}) => ({ host, provisionalOutletId: id, occurrences: n, sampleUrls: [`https://${host}/a`], shows: ['s1'], ...extra });

test('proposes an unregistered outlet seen twice or more', () => {
  const { proposals } = buildProposals({ outlets: [o('therepublic.com', 'therepublic', 5)] }, reg);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, 'therepublic');
  assert.equal(proposals[0].entry.domain, 'therepublic.com');
  assert.equal(proposals[0].entry.displayName, 'Therepublic');
});

test('skips registered, one-off, generic, and non-outlet hosts with a reason', () => {
  const { proposals, skipped } = buildProposals({ outlets: [
    o('www.nytimes.com', 'nytimes', 9), o('tiny.com', 'tiny', 1), o('open.substack.com', 'open', 4),
    o('facebook.com', 'facebook', 8),
  ] }, reg);
  assert.equal(proposals.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason).sort(),
    ['already-registered', 'below-min-occurrences', 'generic-id', 'not-an-outlet'].sort());
});

test('does not collide with an existing registry id or a duplicate proposal', () => {
  const { proposals, skipped } = buildProposals({ outlets: [o('a.com', 'nyt', 3), o('b.com', 'bee', 3), o('c.com', 'bee', 2)] }, reg);
  assert.deepEqual(proposals.map((p) => p.id), ['bee']);
  assert.equal(skipped.filter((s) => s.reason === 'id-collision').length, 2);
});

test('real queue yields only sane, unregistered proposals', () => {
  const audit = require('../../data/audit/unknown-aggregator-outlets.json');
  const registry = require('../../data/outlet-registry.json');
  const { proposals } = buildProposals(audit, registry.outlets || registry);
  const ids = new Set(Object.keys(registry.outlets || registry));
  for (const p of proposals) { assert.ok(!ids.has(p.id)); assert.ok(p.occurrences >= 2); }
});
