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

// Files where type="email" is used for non-capture purposes (lookup, display, own API)
const EXCLUDED_PATHS = [
  'src/app/unsubscribe/',    // email for unsubscribe lookup
  'src/app/unfollow/',       // email for unfollow lookup
  'src/app/fantasy/',        // fantasy draft uses own /api/fantasy/draft endpoint, not Formspree
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

  test('critical Formspree form IDs are set in .env', () => {
    // If these env vars are missing at build time, email capture silently breaks
    // because components use `if (FORMSPREE_FORM_ID)` guards that skip the POST
    let envContent;
    try {
      envContent = readFileSync(join(ROOT, '.env'), 'utf8');
    } catch {
      // .env may not exist in CI (secrets injected via env) — skip
      return;
    }

    const REQUIRED_FORM_IDS = [
      'NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID',
      'NEXT_PUBLIC_FORMSPREE_FOLLOW_FORM_ID',
      'FORMSPREE_SUBSCRIBER_FORM_ID',
      'FORMSPREE_SUBSCRIBER_API_KEY',
      'FORMSPREE_TOKEN',
    ];

    const missing = [];
    for (const key of REQUIRED_FORM_IDS) {
      const regex = new RegExp(`^${key}=.+`, 'm');
      if (!regex.test(envContent)) {
        missing.push(key);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `These Formspree env vars are missing or empty in .env:\n` +
      missing.map(k => `  - ${k}`).join('\n') +
      `\n\nWithout these, email capture silently fails (components skip the POST).`
    );
  });

  test('no hardcoded Formspree form IDs in components (use env vars)', () => {
    // Hardcoded form IDs are fragile — if the form is deleted/rotated on
    // Formspree, submissions silently go to the void. All components should
    // use env vars so form IDs can be rotated in one place.
    const files = findTsxFiles(SRC_DIR);
    const violations = [];

    // Pattern: formspree.io/f/ followed by a literal form ID (not a variable)
    const hardcodedPattern = /formspree\.io\/f\/[a-z]{8,}/;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (file.includes('.test.') || file.includes('.spec.')) continue;

      // Check each line for hardcoded form IDs
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (hardcodedPattern.test(line)) {
          // Allow fallbacks with || (env var with hardcoded default) but flag them
          const relative = file.replace(ROOT + '/', '');
          violations.push(`${relative}:${i + 1}`);
        }
      }
    }

    // These are known `process.env.X || '<literal>'` fallbacks — the literal is
    // a default, not the only source, so the ID stays rotatable via the env var.
    // Tracked rather than banned; if this list grows, centralize the form IDs.
    //
    // src/app/api/feedback/route.ts holds the LAST such literal in the tree
    // (the two page.tsx entries above have since migrated to pure env vars and
    // no longer match this pattern at all). It is deliberately still a fallback:
    // NEXT_PUBLIC_FORMSPREE_ENDPOINT is not set in any environment, so removing
    // the default would silently stop the best-effort forward that
    // process-feedback.yml's AI bug-diagnosis pipeline polls — the exact
    // "submissions go to the void" failure this test exists to prevent.
    // Retiring it properly means provisioning the env var in the Vercel build
    // env first; tracked in Linear (see BRO-2275's session comment).
    const KNOWN_FALLBACKS = [
      'src/app/feedback/page.tsx',
      'src/app/submit-review/page.tsx',
      'src/app/api/feedback/route.ts',
    ];

    const unexpected = violations.filter(v =>
      !KNOWN_FALLBACKS.some(known => v.startsWith(known))
    );

    assert.deepStrictEqual(
      unexpected,
      [],
      `These files have hardcoded Formspree form IDs (should use env vars):\n` +
      unexpected.map(f => `  - ${f}`).join('\n') +
      `\n\nUse process.env.NEXT_PUBLIC_FORMSPREE_*_FORM_ID instead.`
    );
  });
});
