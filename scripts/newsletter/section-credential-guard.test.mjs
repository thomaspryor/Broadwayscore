// Card #1158: a section whose data source needs a credential (most-read-pages'
// GA4 fetch) must never be reported as 'no-data' when the real cause is a
// missing env var, and the PATCH-to-Resend path must refuse to ship a draft
// that has one. Per CLAUDE.md §15 these exercise the real functions —
// pre-send-check.mjs's HARD gate calls hasNoAccessSection/noAccessSections
// straight from section-credential-guard.mjs, no reimplementation here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  SECTION_CREDENTIALS,
  isCredentialBacked,
  missingCredential,
  classifyEntry,
  classifyEntries,
  noAccessSections,
  hasNoAccessSection,
} from './section-credential-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

// ── (a) classification: missing credential → 'no-access', never 'no-data' ────

test('missingCredential reports the unmet var for a credential-backed section', () => {
  assert.equal(missingCredential('most-read-pages', {}), 'GA4_PROPERTY_ID');
  assert.equal(
    missingCredential('most-read-pages', { GA4_PROPERTY_ID: '123' }),
    'GA_KEY_FILE or GA_SERVICE_ACCOUNT_KEY',
  );
  assert.equal(
    missingCredential('most-read-pages', { GA4_PROPERTY_ID: '123', GA_SERVICE_ACCOUNT_KEY: 'xyz' }),
    null,
  );
  assert.equal(
    missingCredential('most-read-pages', { GA4_PROPERTY_ID: '123', GA_KEY_FILE: '/path' }),
    null,
  );
});

test('missingCredential is null for a section with no entry in the table', () => {
  assert.equal(missingCredential('casting-updates', {}), null);
  assert.equal(isCredentialBacked('casting-updates'), false);
  assert.equal(isCredentialBacked('most-read-pages'), true);
});

test('classifyEntry relabels a credential-backed skip as no-access, not no-data', () => {
  const raw = { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 };
  const classified = classifyEntry(raw, {});
  assert.equal(classified.skipReason, 'no-access: GA4_PROPERTY_ID missing');
  assert.notEqual(classified.skipReason, 'no-data');
});

test('classifyEntry leaves a genuinely-empty non-credential section as no-data', () => {
  const raw = { name: 'casting-updates', fired: false, skipReason: 'no-data', htmlLength: 0 };
  const classified = classifyEntry(raw, {});
  assert.equal(classified.skipReason, 'no-data');
});

test('classifyEntry leaves a fired section untouched even if credential-backed', () => {
  const raw = { name: 'most-read-pages', fired: true, skipReason: null, htmlLength: 800 };
  const classified = classifyEntry(raw, {});
  assert.deepEqual(classified, raw);
});

test('classifyEntry does not misfire when the credential IS present', () => {
  const raw = { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 };
  const env = { GA4_PROPERTY_ID: '123', GA_SERVICE_ACCOUNT_KEY: 'xyz' };
  const classified = classifyEntry(raw, env);
  assert.equal(classified.skipReason, 'no-data'); // genuinely empty this week, creds were fine
});

test('classifyEntries reclassifies only the credential-backed entries in a full section report', () => {
  const entries = [
    { name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 },
    { name: 'casting-updates', fired: false, skipReason: 'no-data', htmlLength: 0 },
    { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 },
  ];
  const out = classifyEntries(entries, {});
  assert.equal(out[0].skipReason, null);
  assert.equal(out[1].skipReason, 'no-data');
  assert.equal(out[2].skipReason, 'no-access: GA4_PROPERTY_ID missing');
});

// ── (b) PATCH-refusal decision: hasNoAccessSection is the exact function
// pre-send-check.mjs's HARD gate calls before allowing create-broadcast-
// draft.mjs to PATCH the Resend draft ────────────────────────────────────────

test('hasNoAccessSection is true when a no-access section survives classification', () => {
  const entries = classifyEntries([
    { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 },
  ], {});
  assert.equal(hasNoAccessSection(entries, {}), true);
  assert.equal(noAccessSections(entries).length, 1);
});

test('noAccessSections keys off the noAccess boolean, not a skipReason string prefix', () => {
  // Guards against the class of bug where a future skipReason rewording
  // silently stops the gate from firing — the decision must not depend on
  // string-matching human-readable text.
  const lookalike = { name: 'some-other-section', fired: false, skipReason: 'no-access to the venue this week', htmlLength: 0 };
  assert.equal(noAccessSections([lookalike]).length, 0);
  const real = classifyEntry({ name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 }, {});
  assert.equal(noAccessSections([real]).length, 1);
});

test('hasNoAccessSection is false for an all-local-data draft with real empty sections', () => {
  const entries = classifyEntries([
    { name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 },
    { name: 'casting-updates', fired: false, skipReason: 'no-data', htmlLength: 0 },
  ], {});
  assert.equal(hasNoAccessSection(entries, {}), false);
});

test('hasNoAccessSection is false once the missing credential is supplied', () => {
  const env = { GA4_PROPERTY_ID: '123', GA_SERVICE_ACCOUNT_KEY: 'xyz' };
  const entries = classifyEntries([
    { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 },
  ], env);
  assert.equal(hasNoAccessSection(entries, env), false);
});

test('NEWSLETTER_ALLOW_NO_ACCESS=1 is the explicit override — default stays refuse', () => {
  const entries = classifyEntries([
    { name: 'most-read-pages', fired: false, skipReason: 'no-data', htmlLength: 0 },
  ], {});
  assert.equal(hasNoAccessSection(entries, {}), true);
  assert.equal(hasNoAccessSection(entries, { NEWSLETTER_ALLOW_NO_ACCESS: '1' }), false);
});

test('SECTION_CREDENTIALS only lists sections that actually fetch a live external API', () => {
  // Guard against silent scope creep: this table exists specifically for
  // generate.mjs sections backed by a network fetch, not local repo JSON.
  assert.deepEqual(Object.keys(SECTION_CREDENTIALS), ['most-read-pages']);
});

// ── End-to-end: pre-send-check.mjs actually refuses to clear a draft with a
// no-access section, and clears one without it. Spawns the real script
// against synthetic fixtures — proves the gate is wired, not just the pure
// decision function in isolation.

function writeFixture(outDir, weekStart, { sections, htmlExtra = '' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const html = `<!DOCTYPE html><html><body>${htmlExtra}{{{RESEND_UNSUBSCRIBE_URL}}}<!-- BODY_SECTIONS_START --></body></html>`;
  fs.writeFileSync(path.join(outDir, `A-${weekStart}.html`), html);
  fs.writeFileSync(path.join(outDir, `A-${weekStart}.meta.json`), JSON.stringify({
    subject: 'Test Weekly Round-up',
    edition: 'broadway',
    weekStart,
    weekEnd: weekStart,
    sections,
  }, null, 2));
}

test('pre-send-check.mjs exits non-zero and names the no-access section when one is present', () => {
  const weekStart = '2026-08-03';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-no-access-'));
  writeFixture(outDir, weekStart, {
    sections: [
      { name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 },
      { name: 'most-read-pages', fired: false, skipReason: 'no-access: GA4_PROPERTY_ID missing', htmlLength: 0, noAccess: true },
    ],
  });
  assert.throws(() => {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/pre-send-check.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_EDITION: undefined },
      stdio: 'pipe',
    });
  }, (err) => {
    assert.equal(err.status, 1);
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    assert.match(out, /no-access: GA4_PROPERTY_ID missing/);
    assert.match(out, /HARD FAILURE/);
    return true;
  });
});

test('pre-send-check.mjs clears a draft whose skips are all genuine no-data', () => {
  const weekStart = '2026-08-03';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-no-access-'));
  writeFixture(outDir, weekStart, {
    sections: [
      { name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 },
      { name: 'casting-updates', fired: false, skipReason: 'no-data', htmlLength: 0 },
    ],
  });
  const out = execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/pre-send-check.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_EDITION: undefined },
    stdio: 'pipe',
  }).toString();
  assert.match(out, /Pre-send check OK/);
});

test('pre-send-check.mjs clears a no-access section when NEWSLETTER_ALLOW_NO_ACCESS=1 overrides it', () => {
  const weekStart = '2026-08-03';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-no-access-'));
  writeFixture(outDir, weekStart, {
    sections: [
      { name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 },
      { name: 'most-read-pages', fired: false, skipReason: 'no-access: GA4_PROPERTY_ID missing', htmlLength: 0, noAccess: true },
    ],
  });
  const out = execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/pre-send-check.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_EDITION: undefined, NEWSLETTER_ALLOW_NO_ACCESS: '1' },
    stdio: 'pipe',
  }).toString();
  assert.match(out, /Pre-send check OK/);
});
