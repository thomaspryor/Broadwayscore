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

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC_DIR = join(ROOT, 'src');

/**
 * Recursively find all .tsx/.ts files in a directory
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

function usesFormspree(content) {
  return (
    /useFormspreeCapture/.test(content) ||
    /formspree\.io/.test(content) ||
    /FORMSPREE.*FORM_ID/.test(content) ||
    /endpoint.*formspree|formspree.*endpoint/i.test(content) ||
    // Components that receive a submission URL as a prop (e.g. FeedbackForm)
    /\(\s*\{\s*endpoint\s*\}/.test(content)
  );
}

// Files where type="email" is used for non-capture purposes (lookup, display)
const EXCLUDED_PATHS = [
  'src/app/unsubscribe/',    // email for unsubscribe lookup
  'src/app/unfollow/',       // email for unfollow lookup
];

describe('Email Capture Integrity', () => {
  test('every component with an email input + submit handler must reference Formspree', () => {
    const files = findTsxFiles(SRC_DIR);
    const violations = [];

    for (const file of files) {
      const relative = file.replace(ROOT + '/', '');
      if (EXCLUDED_PATHS.some(exc => relative.startsWith(exc))) continue;

      const content = readFileSync(file, 'utf8');
      if (file.includes('.test.') || file.includes('.spec.')) continue;

      // Detect: has an email input AND any kind of submit/save handler
      const hasEmailInput = /type=["']email["']/.test(content);
      // Catch both form onSubmit and button onClick handlers for email
      const hasSubmitHandler = /onSubmit|handleSubmit|handleEmail|emailSav|emailSubmit/i.test(content);

      if (!hasEmailInput || !hasSubmitHandler) continue;

      if (!usesFormspree(content)) {
        violations.push(relative);
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      `These components collect emails but never submit to Formspree (emails would be lost!):\n` +
      violations.map(f => `  - ${f}`).join('\n') +
      `\n\nFix: use useFormspreeCapture() or POST to formspree.io/f/FORM_ID.\n` +
      `If the file doesn't capture subscriber emails, add its path to EXCLUDED_PATHS in this test.`
    );
  });

  test('EmailCaptureModal POSTs to Formspree (not just localStorage)', () => {
    // Specific regression guard for the Jan 29 – Mar 12, 2026 bug
    const content = readFileSync(join(SRC_DIR, 'components/EmailCaptureModal.tsx'), 'utf8');

    assert.ok(
      content.includes('formspree.io'),
      'EmailCaptureModal must POST to formspree.io — was localStorage-only for 42 days (Jan 29 – Mar 12, 2026)'
    );

    assert.ok(
      content.includes("method: 'POST'") || content.includes('method: "POST"'),
      'EmailCaptureModal must use POST method to submit to Formspree'
    );
  });

  test('ProGateContext has recapture logic for pre-fix modal submissions', () => {
    const content = readFileSync(join(SRC_DIR, 'contexts/ProGateContext.tsx'), 'utf8');

    assert.ok(
      content.includes('recapture') || content.includes('RECAPTURED_KEY'),
      'ProGateContext must include recapture logic for users who submitted via the broken modal'
    );
  });
});
