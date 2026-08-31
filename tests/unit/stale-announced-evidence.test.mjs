// Guards the review-texts signal in audit-stale-announced-shows.js.
//
// The bug: hasPopulatedReviewTextsDir counted ANY .json in a show's
// review-texts directory as "this show has collected reviews", including files
// already flagged wrongShow/wrongProduction. Those are contamination a rebuild
// drops, so they say nothing about whether the show opened. Measured
// 2026-08-31, that made 19 of 43 stale-announced flags false positives
// (private-lives-2025: 23 review files, all 23 flagged out).
//
// The fix must stay NARROW: only wrongShow/wrongProduction are discounted. A
// truncated, paywalled or otherwise unscoreable review is still a real critic
// writing about this production and must keep counting as evidence, or the
// audit stops catching shows that genuinely opened.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isEvidenceOfOpening, hasEvidenceOfOpening, NOT_EVIDENCE_OF_OPENING } = require(
  '../../scripts/lib/stale-announced-audit.js'
);
const { explainExclusion } = require('../../scripts/lib/review-guards.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a review flagged wrongShow is not evidence the show opened', () => {
  assert.strictEqual(isEvidenceOfOpening({ wrongShow: true }, explainExclusion), false);
});

test('a review flagged wrongProduction is not evidence the show opened', () => {
  assert.strictEqual(isEvidenceOfOpening({ wrongProduction: true }, explainExclusion), false);
});

test('a review excluded for any OTHER reason still counts as evidence', () => {
  // Injected explainer so the case is explicit rather than dependent on which
  // rule real data happens to trip first.
  const excludedSomeOtherWay = () => 'blockedReviewUrl';
  assert.strictEqual(isEvidenceOfOpening({ url: 'x' }, excludedSomeOtherWay), true);
});

test('a fully includable review counts as evidence', () => {
  const includable = () => null;
  assert.strictEqual(isEvidenceOfOpening({ fullText: 'a real review' }, includable), true);
});

test('a null or non-object record counts as evidence rather than weakening the signal', () => {
  const never = () => null;
  assert.strictEqual(isEvidenceOfOpening(null, never), true);
  assert.strictEqual(isEvidenceOfOpening(undefined, never), true);
  assert.strictEqual(isEvidenceOfOpening('nope', never), true);
});

test('the discount list stays narrow — exactly the two wrong-show rule names', () => {
  assert.deepStrictEqual(
    [...NOT_EVIDENCE_OF_OPENING].sort(),
    ['wrongProduction', 'wrongShow'],
    'widening this set silently blinds the audit to shows that really opened'
  );
});

test('the rule names match what review-guards actually returns for those flags', () => {
  // If explainExclusion ever renames these rules, the Set above goes stale and
  // silently stops discounting anything. Pin the contract.
  assert.strictEqual(explainExclusion({ wrongShow: true }), 'wrongShow');
  assert.strictEqual(explainExclusion({ wrongProduction: true }), 'wrongProduction');
});

// The bug that made the first fix a no-op: the acceptance test carried its own
// inline `readdirSync(dir).some(f => f.endsWith(".json"))`, so fixing the
// production script left the test asserting the OLD rule and CI still red.
// Both the script and the acceptance test must route through the lib.
test('neither the audit script nor its acceptance test re-inlines the review-texts rule', () => {
  for (const rel of [
    'scripts/audit-stale-announced-shows.js',
    'scripts/audit-stale-announced-shows.test.mjs',
  ]) {
    // Strip line comments first: both files legitimately DESCRIBE the old rule
    // in prose, and matching that prose would be a false positive.
    const src = readFileSync(path.join(repoRoot, rel), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(
      /hasEvidenceOfOpening\(/.test(src),
      `${rel} must call hasEvidenceOfOpening from scripts/lib/stale-announced-audit.js`
    );
    assert.ok(
      !/readdirSync\([^)]*\)[\s\S]{0,80}endsWith\('\.json'\)/.test(src),
      `${rel} must not re-inline the "any .json counts" rule — that copy is why ` +
        'a production fix stopped reaching the acceptance assertion'
    );
  }
});

test('hasEvidenceOfOpening returns false for a directory that does not exist', () => {
  assert.strictEqual(
    hasEvidenceOfOpening('/nonexistent/review-texts', 'no-such-show', () => null),
    false
  );
});
