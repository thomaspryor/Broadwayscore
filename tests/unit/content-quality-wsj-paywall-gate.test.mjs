/**
 * Regression test: WSJ paywall CTA position-gated truncation detection.
 *
 * Bug class: WSJ's "Continue reading your article with a WSJ membership/subscription"
 * appears at two positions:
 *   - ≥90%: footer chrome on a complete review (cleanText() strips it; correct = 'complete')
 *   - <90%: article cut off at subscription wall (correct = 'truncated')
 *
 * The 60% trailing-junk threshold in _isPatternInTrailingJunk allowed an 80% position
 * stub to pass through isGarbageContent(), resulting in a 'complete' classification.
 * Observed: 1776-2022/wsj--charles-isherwood (2026-06-06 audit).
 *
 * Fix: detectTruncationSignals position-gates the WSJ CTA: pushes 'wsj_paywall_cta'
 * only when match.index < text.length * 0.9. classifyContentTier then returns 'truncated'.
 * Reviews with the CTA at ≥90% remain 'complete'.
 *
 * Per CLAUDE.md §15: require() the real function; never duplicate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyContentTier, detectTruncationSignals } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

// ── Real-file tests (most reliable) ──────────────────────────────────────────

const REVIEW_TEXTS_BASE = '/Users/tompryor/broadway-review-texts';

function loadReview(showId, filename) {
  try {
    return JSON.parse(readFileSync(`${REVIEW_TEXTS_BASE}/${showId}/${filename}`, 'utf8'));
  } catch {
    return null;
  }
}

// Synthetic truncation case (was a live-fixture test on 1776-2022/wsj--charles-isherwood,
// but that review was later re-collected to a COMPLETE version — the live fixture no longer
// contains the paywall stub, so the assertion became stale and failed wherever the private
// review-texts checkout exists. A synthetic payload tests the position-gate deterministically,
// immune to corpus re-collection. See memory/feedback_ci_red_stale_state_and_brittle_assertions.)
test('WSJ paywall CTA at <90% → classifyContentTier returns truncated', () => {
  const prose = 'The Broadway revival arrives with ambition and a strong ensemble cast. '.repeat(50);
  const cta = ' Continue reading your article with a WSJ membership. ';
  const tail = 'Concluding commentary about the staging and design choices here. '.repeat(10);
  const text = prose + cta + tail; // CTA lands at ~80%
  const ctaPct = text.indexOf('Continue reading') / text.length;
  assert.ok(ctaPct < 0.9, `Expected CTA before 90%, got ${Math.round(ctaPct * 100)}%`);

  const result = classifyContentTier({
    outlet: 'The Wall Street Journal', outletId: 'wsj',
    fullText: text, url: 'https://www.wsj.com/articles/test-review',
  });
  assert.equal(result.contentTier, 'truncated',
    `Expected truncated, got ${result.contentTier} (reason: ${result.tierReason})`);
  assert.ok(result.truncationSignals.includes('wsj_paywall_cta'),
    `Expected wsj_paywall_cta, got: ${JSON.stringify(result.truncationSignals)}`);
});

test('ohio-state-murders-2022 WSJ (CTA at 99%) → classifyContentTier stays complete', () => {
  const d = loadReview('ohio-state-murders-2022', 'wsj--charles-isherwood.json');
  if (!d) return;
  const result = classifyContentTier(d);
  assert.notEqual(result.contentTier, 'truncated',
    `Expected non-truncated for footer chrome at ≥90%, got ${result.contentTier}`);
});

test('a-beautiful-noise-2022 WSJ (CTA at 99%) → classifyContentTier stays complete', () => {
  const d = loadReview('a-beautiful-noise-the-neil-diamond-musical-2022', 'wsj--charles-isherwood.json');
  if (!d) return;
  const result = classifyContentTier(d);
  assert.notEqual(result.contentTier, 'truncated',
    `Expected non-truncated for footer chrome at ≥90%, got ${result.contentTier}`);
});

// ── Structural tests ──────────────────────────────────────────────────────────

// Long review prose (~7000 chars) — places footer CTA at ~99%
const LONG_PROSE = ('The revival opens on Broadway with considerable ambition. ' +
  'The director brings fresh perspective to a classic text. ' +
  'The cast of two dozen gives committed performances throughout. ' +
  'The choreography is inventive and the lighting design is spectacular. ').repeat(25);

test('WSJ CTA at ≥90% → no wsj_paywall_cta signal', () => {
  const text = LONG_PROSE + '\n\nContinue reading your article witha WSJ membership';
  const ctaIdx = text.indexOf('Continue reading');
  const pct = ctaIdx / text.length;
  assert.ok(pct >= 0.9, `Expected CTA at ≥90%, got ${Math.round(pct * 100)}%`);

  const signals = detectTruncationSignals(text);
  assert.ok(!signals.signals.includes('wsj_paywall_cta'),
    `wsj_paywall_cta should NOT fire at ${Math.round(pct * 100)}%`);
});

test('WSJ membership mention in review body does not trigger wsj_paywall_cta', () => {
  // A review that happens to mention "WSJ membership" in passing — not a paywall CTA
  const text = LONG_PROSE + ' Subscribers with a WSJ membership can read more on the site.';
  // This should not match because "reading your article with" is absent
  const signals = detectTruncationSignals(text);
  assert.ok(!signals.signals.includes('wsj_paywall_cta'),
    'Incidental WSJ membership mention should not trigger wsj_paywall_cta');
});
