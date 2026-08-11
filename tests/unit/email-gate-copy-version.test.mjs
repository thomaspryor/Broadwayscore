/**
 * copyVersion stamping on email-gate analytics events (task #1206).
 *
 * Task #586 rewrote exit_intent/scroll_depth modal copy on 2026-08-10 with a
 * RECHECK-AFTER 2026-08-24 to see if conversion/dismiss moved. Without a
 * version dimension on the emitted events, that recheck can't isolate "did
 * THIS copy change move the needle" from ordinary week-to-week trend
 * (Codex's adversarial review of #586: "No versioning means the result
 * cannot be interpreted or safely rolled back.").
 *
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * gate-logic.test.mjs precedent. Source-greps the two 'use client' files
 * (EmailCaptureModal.tsx, ProGateContext.tsx) rather than rendering React,
 * same pattern as email-gate-conversion.test.mjs's MODAL_SRC checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const { COPY_VERSION } = await import('../../src/lib/gate-logic.ts');

const MODAL_SRC = readFileSync(join(REPO_ROOT, 'src/components/EmailCaptureModal.tsx'), 'utf8');
const CONTEXT_SRC = readFileSync(join(REPO_ROOT, 'src/contexts/ProGateContext.tsx'), 'utf8');
const ANALYZER_SRC = readFileSync(join(REPO_ROOT, 'scripts/analyze-email-gate-funnel.js'), 'utf8');

test('COPY_VERSION is a non-empty dated version string', () => {
  assert.equal(typeof COPY_VERSION, 'string');
  assert.match(COPY_VERSION, /^v\d+-\d{4}-\d{2}-\d{2}$/,
    'COPY_VERSION should read as "v<n>-<YYYY-MM-DD>" so byCopyVersion breakdowns sort/segment cleanly');
});

test('gate_modal_shown (track + captureEvent) is stamped with copyVersion', () => {
  const trackCall = MODAL_SRC.match(/track\('gate_modal_shown',\s*\{[^}]*\}\)/);
  const captureCall = MODAL_SRC.match(/captureEvent\('gate_modal_shown',\s*\{[^}]*\}\)/);
  assert.ok(trackCall, 'gate_modal_shown track() call must exist');
  assert.ok(captureCall, 'gate_modal_shown captureEvent() call must exist');
  assert.match(trackCall[0], /copyVersion:\s*COPY_VERSION/, 'track(gate_modal_shown) must carry copyVersion');
  assert.match(captureCall[0], /copyVersion:\s*COPY_VERSION/, 'captureEvent(gate_modal_shown) must carry copyVersion');
});

test('email_captured props object is stamped with copyVersion', () => {
  const propsMatch = MODAL_SRC.match(/const captureProps = \{[\s\S]*?\};/);
  assert.ok(propsMatch, 'email_captured captureProps object must exist');
  assert.match(propsMatch[0], /copyVersion:\s*COPY_VERSION/, 'captureProps must carry copyVersion');
  assert.match(MODAL_SRC, /track\('email_captured',\s*captureProps\)/, 'track() must emit email_captured with captureProps');
  assert.match(MODAL_SRC, /captureEvent\('email_captured',\s*captureProps\)/, 'captureEvent() must emit email_captured with captureProps');
});

test('gate_modal_dismissed (track + captureEvent) is stamped with copyVersion', () => {
  const trackCall = CONTEXT_SRC.match(/track\('gate_modal_dismissed',\s*\{[^}]*\}\)/);
  const captureCall = CONTEXT_SRC.match(/captureEvent\('gate_modal_dismissed',\s*\{[^}]*\}\)/);
  assert.ok(trackCall, 'gate_modal_dismissed track() call must exist');
  assert.ok(captureCall, 'gate_modal_dismissed captureEvent() call must exist');
  assert.match(trackCall[0], /copyVersion:\s*COPY_VERSION/, 'track(gate_modal_dismissed) must carry copyVersion');
  assert.match(captureCall[0], /copyVersion:\s*COPY_VERSION/, 'captureEvent(gate_modal_dismissed) must carry copyVersion');
});

test('both modal/context files import COPY_VERSION from gate-logic (not a re-declared local copy)', () => {
  assert.match(MODAL_SRC, /import\s*\{[^}]*COPY_VERSION[^}]*\}\s*from\s*'@\/lib\/gate-logic'/,
    'EmailCaptureModal.tsx must import COPY_VERSION from gate-logic.ts');
  assert.match(CONTEXT_SRC, /import\s*\{[^}]*COPY_VERSION[^}]*\}\s*from\s*'@\/lib\/gate-logic'/,
    'ProGateContext.tsx must import COPY_VERSION from gate-logic.ts');
});

test('analyzer breaks out byCopyVersion alongside byTrigger', () => {
  assert.match(ANALYZER_SRC, /byCopyVersion/, 'analyze-email-gate-funnel.js must compute a byCopyVersion breakdown');
  assert.match(ANALYZER_SRC, /copyVersion/, 'analyzer must extract the copyVersion property from PostHog events');
});
