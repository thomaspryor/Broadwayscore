// LIVE-DATA-LANE: reads data/outlet-registry.json + data/reviews.json. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7391 CLASS-GUARD for "cross-outlet attribution drift" (cards BRO-6860, BRO-6976, BRO-7038).
// A registry defaultCritic the outlet has never published under is what makes
// audit-cross-outlet-attributions.js mint false suspects (BRO-7038: Mark Kennedy at
// news-tribune). Adding a NEW one must fail here, at registry-edit time, not as a
// daily digest warning weeks later. The 6 below pre-date the guard (checked
// 2026-11-11, each already carries a multiAuthorNote or sole-source rationale);
// shrink this list, never grow it. To add one deliberately, prove the critic
// writes for that outlet and put the evidence in the registry row's note.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findHomelessDefaultCritics } = createRequire(import.meta.url)('./default-critic-home.js');
const registry = JSON.parse(readFileSync(path.join(root, 'data', 'outlet-registry.json'), 'utf8'));
const { reviews } = JSON.parse(readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8'));

const KNOWN_HOMELESS = new Set([
  'boston-herald|Marilyn Stasio',
  'cbsnews|Shania Russell',
  'journaltimes|Michael Sommers',
  'lets-go-to-the-theater|Karen Nowosad',
  'sfgate|Lily Janiak',
  'the-sun|Dominic Maxwell',
]);

test('no new registry defaultCritic that the outlet has never published under', () => {
  const fresh = findHomelessDefaultCritics(registry, reviews)
    .filter((h) => !KNOWN_HOMELESS.has(`${h.outletId}|${h.critic}`))
    .map((h) => `${h.outletId}|${h.critic} (publishes at ${h.elsewhere.slice(0, 3).map((e) => `${e.outletId}:${e.n}`).join(', ')})`);
  assert.deepStrictEqual(fresh, []);
});
