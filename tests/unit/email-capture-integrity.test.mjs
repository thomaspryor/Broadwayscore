/**
 * Email Capture Integrity Test
 *
 * Ensures every component that collects email addresses actually submits
 * them to Formspree. Catches the class of bug where a form saves to
 * localStorage but never POSTs to the backend.
 *
 * Added after discovering EmailCaptureModal was localStorage-only from
 * Jan 29 – Mar 12, 2026, losing all modal-captured subscribers.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(import.meta.dirname, '..', '..', 'src');

/**
 * Recursively find all .tsx files in a directory
 */
function findTsxFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTsxFiles(full));
    } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

test('every component with an email input must reference Formspree', () => {
  const files = findTsxFiles(SRC_DIR);
  const violations = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');

    // Skip test files, types, configs
    if (file.includes('.test.') || file.includes('.spec.')) continue;

    // Detect: has an email input AND a form submit handler
    const hasEmailInput = /type=["']email["']/.test(content);
    const hasFormSubmit = /onSubmit|handleSubmit/.test(content);

    if (!hasEmailInput || !hasFormSubmit) continue;

    // This file collects emails via a form. It MUST either:
    // 1. Use useFormspreeCapture hook, OR
    // 2. POST to formspree.io directly, OR
    // 3. Reference a FORMSPREE form ID constant
    const usesFormspree =
      /useFormspreeCapture/.test(content) ||
      /formspree\.io/.test(content) ||
      /FORMSPREE.*FORM_ID/.test(content) ||
      /endpoint.*formspree|formspree.*endpoint/i.test(content) ||
      // Components that receive a submission URL as a prop (e.g. FeedbackForm)
      /\(\s*\{\s*endpoint\s*\}/.test(content);

    if (!usesFormspree) {
      const relative = file.replace(SRC_DIR, 'src');
      violations.push(relative);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `These components collect emails but never submit to Formspree (emails would be lost!):\n` +
    violations.map(f => `  - ${f}`).join('\n') +
    `\n\nFix: use useFormspreeCapture() or POST to formspree.io/f/FORM_ID`
  );
});
