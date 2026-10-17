/**
 * Card #1633: reverify-stale-cv-promoted.js must not clear wrongProduction
 * when its own LLM reasoning names a title mismatch.
 *
 * Incident (2026-08-15 ~04:03 UTC): reverify-stale-cv-promoted.js cleared genuine
 * wrongProduction flags on 2 of 13 touched files where the Gemini verdict's own
 * reasoning field named a DIFFERENT show title than the target show, yet the same
 * call still returned wrongProduction:false — the LLM's boolean is not trustworthy
 * when its own reasoning contradicts it (memory/feedback_llm_wrongprod_false_positives.md,
 * memory/feedback_llm_verifier_hallucinates.md). Fixed in commit e635f03efa5 by
 * assessClearSafety()'s GUARD 2 (scripts/lib/reverify-clear-guards.js), which
 * reverify-stale-cv-promoted.js gates every clear on (main script line ~170).
 *
 * This is the acceptance-criteria fixture named in the card, reproducing both
 * confirmed-bad records verbatim from their contentVerification.previousVerification
 * .reasoning (broadway-review-texts commit 247577522ae): blood-of-my-blood and
 * here-there-are-blueberries. Broader guard coverage (permits, edge cases, the
 * other guards) lives in tests/unit/reverify-clear-guards.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const { assessClearSafety } = require(path.join(repoRoot, 'scripts/lib/reverify-clear-guards.js'));

test('refuses to grant wrongProductionOverride when LLM reasoning names a different show title (Blood of my Blood / Juniper Blood)', () => {
  const reasoning = "The scraped content is a review from TimeOut, but it's for a play called "
    + "'Juniper Blood' at an unspecified venue, not 'Blood of my Blood' at the Royal Court. "
    + 'The content is also truncated.';
  // The verdict itself: high confidence, every boolean clean — this is exactly the
  // shape that reached a live review on 2026-08-15 before the guard existed.
  const result = {
    isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false,
    confidence: 'high', reasoning,
  };

  const { safe, refusals } = assessClearSafety({
    filePath: '/data/review-texts/blood-of-my-blood-west-end-2026/timeout-london--holly-omahony.json',
    data: { url: 'https://timeout.com/london/juniper-blood-review', wrongProduction: true },
    show: { title: 'Blood of my Blood' },
    showTitle: 'Blood of my Blood',
    result,
  });

  assert.equal(safe, false, 'a clean verdict (wrongProduction:false, confidence:high) must NOT be enough to clear when its own reasoning names a different title');
  assert.ok(refusals.some(r => r.code === 'title-mismatch-in-reasoning'),
    'refusal must be attributed to the title-mismatch guard, not just confidence');
});

test('refuses to grant wrongProductionOverride when LLM reasoning names a different show title (Here There Are Blueberries / Here We Are)', () => {
  const reasoning = "The scraped content is a review of 'Here We Are', not 'Here There Are Blueberries'.";
  const result = {
    isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false,
    confidence: 'high', reasoning,
  };

  const { safe, refusals } = assessClearSafety({
    filePath: '/data/review-texts/here-there-are-blueberries-theatre-royal-stratford-east-west-end-2026/timeout-london--andrzej-lukowski.json',
    data: { url: 'https://timeout.com/london/here-we-are-review', wrongProduction: true },
    show: { title: 'Here There Are Blueberries' },
    showTitle: 'Here There Are Blueberries',
    result,
  });

  assert.equal(safe, false, 'a clean verdict must NOT be enough to clear when its own reasoning names a different title');
  assert.ok(refusals.some(r => r.code === 'title-mismatch-in-reasoning'));
});

test('control: a genuinely clean verdict on the show\'s OWN title is still permitted (guard is not overbroad)', () => {
  const result = {
    isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false,
    confidence: 'high', reasoning: 'A clear review of "Blood of my Blood" at the Royal Court Theatre.',
  };

  const { safe, refusals } = assessClearSafety({
    filePath: '/data/review-texts/blood-of-my-blood-west-end-2026/nyt--jesse-green.json',
    data: { url: 'https://nytimes.com/blood-of-my-blood-review', wrongProduction: true },
    show: { title: 'Blood of my Blood' },
    showTitle: 'Blood of my Blood',
    result,
  });

  assert.equal(safe, true, 'a legitimate clear whose reasoning matches the show must not be caught by the title-mismatch guard');
  assert.deepEqual(refusals, []);
});
