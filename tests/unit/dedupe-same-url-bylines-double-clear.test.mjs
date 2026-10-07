/**
 * Regression test (card #1907): a same-URL cluster where two INDEPENDENT
 * repairs each clear one side of an A<->B duplicateOf cycle leaves BOTH
 * members unsuppressed, so rebuild-all-reviews.js double-counts the article.
 *
 * Live instance (turned main red 2026-08-26, loves-labours-lost-globe-west-
 * end-2026, The Times UK): review-write-guard's cycle-refusal
 * (wouldFormDuplicateCycle) cleared times-uk--the-times.json's duplicateOf to
 * avoid closing a loop; fix-canonical-duplicate-backpointer.js LATER cleared
 * times-uk--clive-davis.json's duplicateTextOf for the same reason. Neither
 * repair re-resolved the cluster, so nothing suppressed either file — both
 * carry a duplicateClearReason breadcrumb naming (or describing) the other.
 *
 * dedupe-same-url-bylines.js's audit()/fix() now treats "an includable
 * same-URL member carries a duplicateClearReason breadcrumb" as proof a prior
 * repair declined to resolve this cluster, and forces it through the normal
 * cohesive-group collapse instead of deferring to rebuildAlreadyCollapses
 * (which assumes the rebuild's own runtime fingerprint dedup already handles
 * it — true in general, but it resolves by file-processing order, not by
 * byline quality, and leaves no persistent duplicateOf pointer).
 *
 * REVIEW_TEXTS_DIR must be set BEFORE dedupe-same-url-bylines.js is required
 * (it reads the env var once, at module load, into a top-level const).
 *
 * Run: node --test tests/unit/dedupe-same-url-bylines-double-clear.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const REVIEW_TEXTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-double-clear-'));
process.env.REVIEW_TEXTS_DIR = REVIEW_TEXTS_DIR;
const {
  audit, fix, hasPlaceholderVsRealSplit, hasContestedCycleClear,
} = require('../../scripts/dedupe-same-url-bylines.js');

const body = (n) => 'x'.repeat(n);

test('hasContestedCycleClear: true only for the two EXACT cycle-clear breadcrumb patterns', () => {
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'auto-cleared at write: refusing duplicateOf cycle with x.json (it already points back at us)' },
    { criticName: 'Real Critic' },
  ]), true, 'review-write-guard cycle-refusal breadcrumb');
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'canonical-backpointer-cleared: duplicateTextOf pointed back into its own byline cluster (canonical-backpointer-repair)' },
    { criticName: 'Real Critic' },
  ]), true, 'fix-canonical-duplicate-backpointer breadcrumb');
  assert.equal(hasContestedCycleClear([{ criticName: 'A' }, { criticName: 'B' }]), false);
  assert.equal(hasContestedCycleClear([{ duplicateClearReason: '' }, { duplicateClearReason: null }]), false);
});

test('hasContestedCycleClear: false for a manual-review operator vouch — must NEVER force-resolve a protected "not a duplicate" designation', () => {
  // scripts/lib/manual-review-fields.js:110 stamps this exact string and adds
  // duplicateOf/duplicateClearReason to the record's own protectedFields so
  // the vouch survives future writes — but fix()'s safeWriteReview(force:true)
  // bypasses protectedFields by design, so a broad match here would silently
  // overwrite an operator's explicit "not a duplicate" call. Second-opinion
  // finding, card #1907.
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'Manual ingest: operator vouched for this review as independent (not a duplicate)' },
    { criticName: 'Real Critic' },
  ]), false);
});

test('hasContestedCycleClear: false for unrelated auto-clear breadcrumbs (self-ref, stale-sibling, URL-mismatch)', () => {
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'auto-cleared at write: self-referential duplicateOf (pointed at own filename)' },
  ]), false);
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'auto-cleared at write: sibling outlet--x.json no longer exists' },
  ]), false);
  assert.equal(hasContestedCycleClear([
    { duplicateClearReason: 'auto-cleared at write: URL https://a no longer matches sibling outlet--x.json URL https://b' },
  ]), false);
});

test('hasPlaceholderVsRealSplit: true only when the group mixes a placeholder and a real byline', () => {
  assert.equal(hasPlaceholderVsRealSplit([
    { criticName: 'The Times', outlet: 'The Times (UK)' },
    { criticName: 'Clive Davis', outlet: 'The Times (UK)' },
  ]), true);
  assert.equal(hasPlaceholderVsRealSplit([
    { criticName: 'Clive Davis', outlet: 'The Times (UK)' },
    { criticName: 'David Jays', outlet: 'The Times (UK)' },
  ]), false, 'both real — no split');
  assert.equal(hasPlaceholderVsRealSplit([
    { criticName: 'Unknown', outlet: 'Variety' },
    { criticName: 'Staff', outlet: 'Variety' },
  ]), false, 'both placeholder — no split');
});

test('double-clear reproduction: A cleared by cycle-refusal + B cleared by backpointer-repair => audit()+fix() leaves exactly one includable', () => {
  const showId = 'loves-labours-lost-globe-west-end-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://www.thetimes.com/culture/theatre-dance/article/loves-labours-lost-review-shakespeare-ruined-by-puerile-knob-gags-wtr9x5xl9';
  const realName = 'times-uk--clive-davis.json';
  const placeholderName = 'times-uk--the-times.json';

  // Real byline, cleared by fix-canonical-duplicate-backpointer.js's repair —
  // its own duplicateOf is null (it never pointed away), only the
  // duplicateTextOf back-pointer was dropped, leaving the breadcrumb below.
  fs.writeFileSync(path.join(showDir, realName), JSON.stringify({
    showId, outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Clive Davis',
    url, fullText: body(3000), contentTier: 'complete', isFullReview: true,
    duplicateOf: null,
    duplicateClearReason: 'canonical-backpointer-cleared: duplicateTextOf pointed back into its own byline cluster (canonical-backpointer-repair)',
  }));
  // Placeholder byline (outlet name), cleared by review-write-guard's
  // cycle-refusal — the exact breadcrumb wouldFormDuplicateCycle stamps.
  fs.writeFileSync(path.join(showDir, placeholderName), JSON.stringify({
    showId, outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'The Times',
    url, fullText: body(3000), contentTier: 'complete', isFullReview: true,
    duplicateOf: null,
    duplicateClearReason: `auto-cleared at write: refusing duplicateOf cycle with ${realName} (it already points back at us)`,
  }));

  const before = audit();
  assert.ok(before.placeholderVsRealCount >= 1, 'contested/placeholder cluster must be detected before fix');

  const r = fix(before.cohesive);
  assert.ok(r.collapsed >= 1, 'the cluster must be collapsed to one canonical');

  const real = JSON.parse(fs.readFileSync(path.join(showDir, realName), 'utf-8'));
  const placeholder = JSON.parse(fs.readFileSync(path.join(showDir, placeholderName), 'utf-8'));

  assert.equal(real.duplicateOf ?? null, null, 'the real byline must remain the includable canonical');
  assert.equal(placeholder.duplicateOf, realName, 'the placeholder byline must now point at the real byline');

  // Re-audit: the cluster is now resolved via a live duplicateOf link, so it
  // must never resurface as a placeholder-vs-real or contested-clear group.
  const after = audit();
  assert.equal(after.placeholderVsRealCount, 0, 'no placeholder-vs-real groups left unsuppressed after fix');
});
