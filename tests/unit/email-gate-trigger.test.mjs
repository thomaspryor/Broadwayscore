/**
 * BRO-120 acceptance test — "Email gate 0.6% conversion — 68% dismiss rate
 * signals friction" (659 shown/week, 0.6% conversion, 4 captures, 68% dismiss).
 *
 * This is the SAME audit finding, same numbers, as task #586 (2026-08-10),
 * which already shipped this exact fix (PR #586, merged 98354635978):
 * engagement-gated trigger timing, rewritten value-prop copy, and a
 * de-emphasized dismiss CTA. See tests/unit/email-gate-conversion.test.mjs
 * for the full assertion set (30 tests, all passing as of this card).
 *
 * This file exists because BRO-120's acceptance criteria names
 * `tests/unit/email-gate-trigger.test.mjs` specifically as the proof
 * artifact — it re-asserts the three criteria the card lists (engagement-gated
 * timing, updated copy, de-emphasized dismiss CTA) against the real
 * functions/config, not a re-derived copy of the logic. It does not
 * introduce new behavior; the underlying fix already shipped under #586.
 *
 * The card's numeric outcome (conversion >X%, dismiss <Y%) is NOT verifiable
 * here — it needs live PostHog traffic days after ship (owner-judgment,
 * out of scope per the card's own acceptance criteria).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const { emailCaptureConfig } = await import('../../src/config/email-capture.ts');
const { getTriggerCopy } = await import('../../src/lib/gate-logic.ts');

const MODAL_SRC = readFileSync(join(REPO_ROOT, 'src/components/EmailCaptureModal.tsx'), 'utf8');

test('modal no longer fires on the old immediate/aggressive trigger: passive gates require meaningful engagement', () => {
  // Old behavior (pre-#586): exit intent could fire near-instantly and the
  // mobile scroll gate fired at 10s dwell. Both now require real dwell time,
  // and every passive trigger additionally requires a second page view.
  assert.ok(emailCaptureConfig.exitIntent.minTimeOnPageSec >= 5,
    'exit intent must not fire immediately on page load');
  assert.ok(emailCaptureConfig.mobileScrollGate.minTimeOnPageSec >= 30,
    'mobile scroll gate must wait for meaningful dwell time, not the old 10s');
  assert.ok(emailCaptureConfig.minPageViewsForPassiveGate >= 2,
    'passive gates must require more than a first-page-load visitor');
});

test('updated copy: exit_intent/scroll_depth state a concrete deliverable, not a vague tease', () => {
  for (const trigger of ['exit_intent', 'scroll_depth']) {
    const { heading, subheading } = getTriggerCopy(trigger, false);
    assert.doesNotMatch(heading, /^Know the score before you book$/,
      `${trigger} must not regress to the pre-#586 vague heading`);
    assert.match(subheading, /CriticScore/, `${trigger} subheading must name the concrete deliverable`);
  }
});

test('dismiss CTA is de-emphasized relative to the submit CTA', () => {
  const submitMatch = MODAL_SRC.match(/type="submit"[\s\S]{0,400}?className="([^"]+)"/);
  assert.ok(submitMatch, 'submit button must exist with a className');
  assert.match(submitMatch[1], /bg-brand\b/, 'submit CTA must carry a solid brand fill');

  const dismissBlockMatch = MODAL_SRC.match(/onClick=\{onClose\}[\s\S]{0,300}?>\s*Maybe later/);
  assert.ok(dismissBlockMatch, 'dismiss "Maybe later" control must exist and call onClose');
  assert.doesNotMatch(dismissBlockMatch[0], /bg-brand|bg-\w+-\d{3}/,
    'dismiss control must not carry a filled background (must read as subordinate)');
});
