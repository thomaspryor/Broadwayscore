// LIVE-DATA-LANE: reads data/outlet-registry.json + data/reviews.json. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7391 CLASS-GUARD for "cross-outlet attribution drift" (cards BRO-6860, BRO-6976, BRO-7038).
// Since BRO-8038 the audit itself ignores homeless defaults (buildEvidencedDefaultHomes,
// unit-guarded in cross-outlet-triage.test.mjs), so this lane is registry hygiene:
// a homeless default still mis-fills blank bylines via critic-fill-rules.js.
// A registry defaultCritic the outlet has never published under is what makes
// audit-cross-outlet-attributions.js mint false suspects (BRO-7038: Mark Kennedy at
// news-tribune). Adding a NEW one fails this test in check-corpus-drift.yml (daily
// + after every rebuild; non-blocking live-data lane, the corpus is not in test.yml),
// instead of surfacing as a digest warning on individual rows weeks later. The entries below pre-date the guard (checked
// 2026-11-11, each already carries a multiAuthorNote or sole-source rationale);
// shrink this list; grow it only for a documented exception (see BRO-7571). To add one deliberately, prove the critic
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
  // BRO-7571 (documented exception to shrink-only): BRO-7208 (2026-11-15) marked the outlet multiAuthor, so critic-fill-rules.js stopped filling blank bylines with this default; reviews.json now has 0 Rocamora rows here (1 of 4 named bylines per the registry multiAuthorNote). Kept for audit-multiauthor-attributions.js.
  'broadstreetreview|Carol Rocamora',
  'cbsnews|Shania Russell',
  'journaltimes|Michael Sommers',
  'lets-go-to-the-theater|Karen Nowosad',
]);

test('no new registry defaultCritic that the outlet has never published under', () => {
  const fresh = findHomelessDefaultCritics(registry, reviews)
    .filter((h) => !KNOWN_HOMELESS.has(`${h.outletId}|${h.critic}`))
    .map((h) => `${h.outletId}|${h.critic} (publishes at ${h.elsewhere.slice(0, 3).map((e) => `${e.outletId}:${e.n}`).join(', ')})`);
  assert.deepStrictEqual(fresh, []);
});

test('allowlist has no stale entries (a fixed default must be removed from KNOWN_HOMELESS)', () => {
  const live = new Set(findHomelessDefaultCritics(registry, reviews).map((h) => `${h.outletId}|${h.critic}`));
  assert.deepStrictEqual([...KNOWN_HOMELESS].filter((k) => !live.has(k)), []);
});
