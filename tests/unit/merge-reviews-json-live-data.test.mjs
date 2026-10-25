// TESTS-VS-DERIVED-DATA-EXEMPT: structural: keyOf uniqueness and no Unknown-byline fossils over the corpus; pins no show fact
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/merge-reviews-json.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/reviews.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/merge-reviews-json.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReviewsJson, keyOf, urlKeyOf, tierRank, isUnknownByline, isMergeFossilAnchor } from '../../scripts/lib/merge-reviews-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Corpus sanity check: the key must actually be unique across the real,
// live reviews.json — this is the exact invariant the module comment claims
// ("verified collision-free across the full production corpus"). Skips
// quietly if the file isn't present (e.g. a minimal CI checkout without core
// data).
test('keyOf: unique across the real data/reviews.json corpus (no accidental key collisions)', (t) => {
  // An absent corpus must read as SKIPPED, not as a pass. A bare `return` here
  // is reported by node:test as a PASSING test, so this assertion went green in
  // every checkout without core data — an isolated worktree, for one, where
  // data/reviews.json is not present at all (crown rule 8).
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath)) return t.skip('data/reviews.json not present in this checkout');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (reviews.length === 0) return t.skip('data/reviews.json carries no reviews');
  const keys = new Map();
  const collisions = [];
  for (const r of reviews) {
    const k = keyOf(r);
    if (!k) continue;
    if (keys.has(k)) collisions.push(k);
    keys.set(k, true);
  }
  assert.deepEqual(collisions, [], `keyOf collisions found in real corpus: ${collisions.slice(0, 5).join(', ')}`);
});

// Corpus invariant: after this pass, no showId+URL may carry a sentinel row
// alongside a bylined one. A missing/empty corpus SKIPS (visibly) rather than
// passing as a silent no-op — note that means the invariant genuinely does not
// run on checkouts without core data, e.g. a fork or Dependabot run where
// checkout-core-data cannot execute. It asserts its own setup when it does run.
test('no Unknown-byline fossil survives in the real data/reviews.json corpus', (t) => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath)) return t.skip('data/reviews.json not present in this checkout');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (reviews.length === 0) return t.skip('data/reviews.json carries no reviews');
  // Count the fossil shape in the RAW corpus FIRST. Without this the test only
  // ran the cleanup and then inspected its own output, which cannot distinguish
  // "there were none" from "the pass ate something it should not have"
  // (adversarial-review finding, Codex).
  // This predicate must mirror the PASS's conditions, not a looser "any
  // sentinel row coexisting with any named row on one canonical URL" — the pass
  // deliberately preserves cross-outlet pairs, different-raw-path pairs, pairs
  // anchored only by a placeholder byline, and pairs where the sentinel row is
  // the richer one. A wider invariant would fail CI on rows the implementation
  // is correct to keep (adversarial-review finding, Codex).
  const rawPath = (u) => { try { const x = new URL(String(u)); return `${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`; } catch { return null; } };
  const outletOf = (r) => String(r.outlet || '').toLowerCase().trim();
  const anchors = new Map();
  for (const r of reviews) {
    if (!isMergeFossilAnchor(r)) continue; // the REAL predicate, not a copy (CLAUDE.md rule 15)
    const k = urlKeyOf(r);
    if (!k) continue;
    if (!anchors.has(k)) anchors.set(k, []);
    anchors.get(k).push(r);
  }
  const rawFossils = reviews.filter(r => isUnknownByline(r.criticName) && r.manualEntry !== true).filter((r) => {
    const k = urlKeyOf(r);
    if (!k || !anchors.has(k)) return false;
    const myPath = rawPath(r.url);
    return Boolean(myPath && anchors.get(k).some(c => rawPath(c.url) === myPath && outletOf(c) === outletOf(r) && tierRank(c) >= tierRank(r)));
  });

  const { merged, stats } = mergeReviewsJson({ _meta: data._meta, reviews }, { _meta: data._meta, reviews: [] });
  assert.ok(merged.reviews.length > 1000, `setup check: expected a real corpus, got ${merged.reviews.length} reviews`);
  // Every row removed must be accounted for, and nothing else may vanish.
  assert.equal(
    reviews.length - merged.reviews.length,
    stats.unknownBylineFossilsDropped,
    'rows disappeared that the fossil pass did not account for',
  );
  assert.ok(
    stats.unknownBylineFossilsDropped <= rawFossils.length,
    `dropped ${stats.unknownBylineFossilsDropped} but only ${rawFossils.length} rows had the fossil shape in the raw corpus`,
  );
  assert.equal(stats.unknownBylineFossilsDroppedKeys.length, stats.unknownBylineFossilsDropped, 'every drop must be recorded with provenance');
  const postAnchors = new Map();
  for (const r of merged.reviews) {
    if (!isMergeFossilAnchor(r)) continue; // the REAL predicate, not a copy (CLAUDE.md rule 15)
    const k = urlKeyOf(r);
    if (!k) continue;
    if (!postAnchors.has(k)) postAnchors.set(k, []);
    postAnchors.get(k).push(r);
  }
  const survivors = merged.reviews.filter(r => isUnknownByline(r.criticName) && r.manualEntry !== true).filter((r) => {
    const k = urlKeyOf(r);
    if (!k || !postAnchors.has(k)) return false;
    const myPath = rawPath(r.url);
    return Boolean(myPath && postAnchors.get(k).some(c => rawPath(c.url) === myPath && outletOf(c) === outletOf(r) && tierRank(c) >= tierRank(r)));
  }).map(r => `${r.showId}|${r.outlet}|${r.url}`);
  assert.deepEqual(survivors, [], `Unknown-byline fossils survived the merge: ${survivors.slice(0, 3).join(', ')}`);
});
