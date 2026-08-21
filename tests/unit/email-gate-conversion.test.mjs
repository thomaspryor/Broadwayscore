/**
 * Email-gate conversion/friction fixes (task #586, 2026-08-10 audit: 659
 * shown/week, 0.6% conversion, 68% dismiss).
 *
 * What this test CAN verify now (structural, code-level, per acceptance
 * criteria on the card):
 *   - passive-gate trigger timing requires meaningful engagement (30s dwell
 *     or a page-view minimum) before firing
 *   - value-prop copy is explicit/concrete, not generic
 *   - the dismiss CTA is visually subordinate to the submit CTA
 *
 * What it CANNOT verify: the card's numeric outcome thresholds (conversion
 * >3%, dismiss <50%) are only observable after ~2 weeks of live traffic —
 * see CLAUDE.md "A fix whose effect is only observable later may NOT be
 * claimed Done." Read those from `node scripts/analyze-ab-test.js` or the
 * PostHog gate_modal_* events once enough traffic has accumulated; this test
 * intentionally does not fabricate a pass/fail on data that doesn't exist yet.
 *
 * exit_intent's dwell timer was frozen at 5s by the live 'gate-cold-start'
 * experiment (docs/experiments/gate-cold-start.md, locked in
 * tests/unit/gate-logic.test.mjs "EXPERIMENT LOCK") until the experiment
 * cleared its pre-registered 28-day minimum runtime on 2026-08-18; BRO-1959
 * (2026-08-21) then raised it 5 -> 30 (shared across both arms, not the
 * treatment lever) — see the "Amendments" section of the experiment doc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const { getTriggerCopy } = await import('../../src/lib/gate-logic.ts');
const { emailCaptureConfig } = await import('../../src/config/email-capture.ts');

const MODAL_SRC = readFileSync(join(REPO_ROOT, 'src/components/EmailCaptureModal.tsx'), 'utf8');

// ─── Trigger timing: meaningful engagement before a passive gate fires ─────

test('trigger timing: mobile scroll gate requires 30s dwell (or more)', () => {
  assert.ok(emailCaptureConfig.mobileScrollGate.minTimeOnPageSec >= 30,
    `mobile scroll gate must wait >=30s, got ${emailCaptureConfig.mobileScrollGate.minTimeOnPageSec}`);
  assert.ok(emailCaptureConfig.mobileScrollGateVariants.control.minTimeOnPageSec >= 30,
    'control variant must match the 30s floor (it mirrors production behavior)');
});

test('trigger timing: passive gates require a second page view this session (alternate path to "meaningful engagement")', () => {
  // Card #586 acceptance: "30s dwell OR second page view minimum." The
  // page-view minimum already exists as the gate-cold-start treatment arm's
  // mechanism (src/lib/gate-logic.ts hasSeenEnoughPages / coldStartCheckApplies)
  // — locked at 2 by the running experiment, covered by gate-logic.test.mjs.
  assert.ok(emailCaptureConfig.minPageViewsForPassiveGate >= 2,
    'passive gates must require at least a second page view this session');
});

test('trigger timing: exit-intent dwell gate meets the post-gate-cold-start floor (BRO-1959)', () => {
  // Raised 5 -> 30 by BRO-1959 once gate-cold-start cleared its minimum
  // runtime — see file header. Asserted here to fail loudly if something
  // regresses the dwell gate back down.
  assert.ok(emailCaptureConfig.exitIntent.minTimeOnPageSec >= 30,
    'exit intent must keep at least its post-experiment dwell floor');
});

// ─── Copy: explicit, concrete value proposition ────────────────────────────

test('copy: exit_intent and scroll_depth state a concrete deliverable and cadence, not a vague tease', () => {
  for (const trigger of ['exit_intent', 'scroll_depth']) {
    for (const isWE of [false, true]) {
      const { heading, subheading } = getTriggerCopy(trigger, isWE);
      assert.ok(heading.length > 0 && subheading.length > 0, `${trigger} (isWE=${isWE}) must have copy`);
      // Must name the concrete deliverable (CriticScore) and frequency (per
      // opening night / one email) — not the old "Know the score before you
      // book" framing, which named neither.
      assert.match(subheading, /CriticScore/, `${trigger} subheading must name the deliverable`);
      assert.match(subheading, /one email|One email/i, `${trigger} subheading must state the cadence`);
      assert.doesNotMatch(heading, /^Know the score before you book$/,
        `${trigger} must not regress to the pre-#586 vague heading`);
    }
  }
});

test('copy: exit_intent/scroll_depth headings and body are market-aware (Broadway vs West End)', () => {
  const bway = getTriggerCopy('exit_intent', false);
  const we = getTriggerCopy('exit_intent', true);
  assert.match(bway.heading, /Broadway/);
  assert.match(we.heading, /West End/);
});

// ─── Concrete example: task #1205 (gpt-5.4-mini fresh-eyes review flagged the
// value-prop as abstract without a sample of the actual email content) ─────

test('copy: exit_intent/scroll_depth include a concrete email-preview example', () => {
  for (const trigger of ['exit_intent', 'scroll_depth']) {
    for (const isWE of [false, true]) {
      const { example } = getTriggerCopy(trigger, isWE);
      assert.ok(example && example.trim().length > 0, `${trigger} (isWE=${isWE}) must have an example line`);
      // Must show a real show name + a real score, not a placeholder like "X — N".
      assert.match(example, /\d{2}/, `${trigger} example must include a numeric score`);
      // "Sample:" (not "Example:") and no quote marks around the tagline — both
      // caught by ship-check (2026-08-10): "Example:" + quoted text reads as a
      // live score / a real critic's quote rather than an illustrative preview.
      assert.match(example, /^Sample:/, `${trigger} example must be labeled "Sample:" so it doesn't read as live data`);
      assert.doesNotMatch(example, /["“”]/, `${trigger} example must not use quote marks around the tagline (reads as an attributed critic quote)`);
    }
  }
});

test('copy: example score matches Hamilton\'s live canonical CriticScore (catches drift on rescore)', () => {
  // The example is a hardcoded literal for a client-bundled file (gate-logic.ts
  // ships to the browser — it can't do a runtime fs read the way
  // scripts/lib/canonical-critic-scores.ts does). This test is the drift guard:
  // it reads the same source JSON and re-derives the score with the same
  // rounding convention, so a Hamilton rescore fails CI instead of shipping a
  // silently stale example (ship-check 2026-08-10 finding).
  const round = (cs) => Math.round(cs);
  const bwayCs = JSON.parse(readFileSync(join(REPO_ROOT, 'public/data/shows/hamilton-2015.json'), 'utf8')).cs;
  const weCs = JSON.parse(readFileSync(join(REPO_ROOT, 'public/data/shows/hamilton-west-end-2021.json'), 'utf8')).cs;

  const bwayExample = getTriggerCopy('exit_intent', false).example;
  const weExample = getTriggerCopy('exit_intent', true).example;
  assert.match(bwayExample, new RegExp(`— ${round(bwayCs)} `), `Broadway example score is stale — hamilton-2015.json now rounds to ${round(bwayCs)}`);
  assert.match(weExample, new RegExp(`— ${round(weCs)} `), `West End example score is stale — hamilton-west-end-2021.json now rounds to ${round(weCs)}`);
});

test('copy: other triggers do not carry an example line (scope stays limited to exit_intent/scroll_depth)', () => {
  const TRIGGERS = ['csv_download', 'json_download', 'page_view_limit', 'return_visitor', 'recapture'];
  for (const trigger of TRIGGERS) {
    const { example } = getTriggerCopy(trigger, false);
    assert.ok(!example, `${trigger} must not have an example line`);
  }
});

test('copy: EmailCaptureModal renders copy.example when present', () => {
  assert.match(MODAL_SRC, /copy\.example/, 'modal must render the optional example line from getTriggerCopy');
});

test('copy: every trigger still returns non-empty heading/subheading (no accidental blank state)', () => {
  const TRIGGERS = ['csv_download', 'json_download', 'page_view_limit', 'exit_intent', 'scroll_depth', 'return_visitor', 'recapture'];
  for (const trigger of TRIGGERS) {
    const { heading, subheading } = getTriggerCopy(trigger, false);
    assert.ok(heading && heading.trim().length > 0, `${trigger} heading must not be blank`);
    assert.ok(subheading && subheading.trim().length > 0, `${trigger} subheading must not be blank`);
  }
});

// ─── Dismiss CTA subordinate to submit CTA ─────────────────────────────────

test('CTA prominence: submit button uses solid brand fill + bold weight; dismiss link stays small, dim, and unfilled', () => {
  const submitMatch = MODAL_SRC.match(/type="submit"[\s\S]{0,400}?className="([^"]+)"/);
  assert.ok(submitMatch, 'submit button must exist with a className');
  const submitClass = submitMatch[1];
  assert.match(submitClass, /bg-brand\b/, 'submit CTA must have a solid brand fill');
  assert.match(submitClass, /font-(semibold|bold)/, 'submit CTA must be visually weighted');

  const dismissMatch = MODAL_SRC.match(/Maybe later[\s\S]{0,10}/);
  assert.ok(dismissMatch, 'dismiss "Maybe later" control must exist');
  // Find the className attached to the button that renders "Maybe later".
  const dismissBlockMatch = MODAL_SRC.match(/onClick=\{onClose\}[\s\S]{0,300}?>\s*Maybe later/);
  assert.ok(dismissBlockMatch, 'dismiss button must call onClose');
  const dismissBlock = dismissBlockMatch[0];
  assert.doesNotMatch(dismissBlock, /bg-brand|bg-\w+-\d{3}/, 'dismiss control must not carry a filled background');
  assert.match(dismissBlock, /text-(xs|sm)/, 'dismiss control must use a small text size');
  assert.match(dismissBlock, /text-gray-[4-9]00/, 'dismiss control must use a dim/muted color, not full-contrast text');
});
