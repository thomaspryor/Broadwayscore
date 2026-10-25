// BRO-132: end-to-end wiring guard. pre-send-check.mjs injects a red
// "PRE-SEND ISSUES" banner into the draft HTML for SOFT issues so the owner
// sees them in the preview email. create-broadcast-draft.mjs PATCHes that
// same HTML file to Resend as the real subscriber-facing broadcast. This
// spawns BOTH real scripts back to back against synthetic fixtures — proving
// the strip is actually wired at the create-broadcast-draft.mjs call site
// (scripts/lib/pre-send-banner.test.mjs already proves build+strip round-trip
// in isolation; this proves the two scripts are actually connected, which is
// the class of bug the ticket describes: a guard that exists but isn't called).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const require_ = createRequire(import.meta.url);
const { BANNER_MARKER, stripPreSendBanner } = require_('./lib/pre-send-banner.js');

function writeFixture(outDir, weekStart, { extraHtml = '' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const html = `<!DOCTYPE html><html><body>${extraHtml}{{{RESEND_UNSUBSCRIBE_URL}}}<!-- BODY_SECTIONS_START --></body></html>`;
  fs.writeFileSync(path.join(outDir, `A-${weekStart}.html`), html);
  fs.writeFileSync(path.join(outDir, `A-${weekStart}.meta.json`), JSON.stringify({
    subject: 'Test Weekly Round-up',
    edition: 'broadway',
    weekStart,
    weekEnd: weekStart,
    // No openingShows / lede pattern / preheader markers — deliberately
    // triggers several real SOFT issues (not hard) so pre-send-check.mjs
    // injects the banner without stopping the workflow.
    sections: [{ name: 'broadway-openings', fired: true, skipReason: null, htmlLength: 500 }],
  }, null, 2));
}

function runPreSendCheck(outDir, weekStart) {
  return execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/pre-send-check.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_EDITION: undefined, NEWSLETTER_SKIP_IMAGE_FETCH: '1' },
    stdio: 'pipe',
    timeout: 30000,
  }).toString();
}

function runCreateBroadcastDraftDryRun(outDir, weekStart) {
  // No --create: dry run only, never calls the Resend API, but still reads +
  // strips the HTML and prints its byte length — enough to prove what WOULD
  // have been PATCHed. The script logs all of this via console.error, so
  // stdout+stderr must both be captured (execFileSync's return value only
  // exposes stdout).
  const res = spawnSync('node', [path.join(repoRoot, 'scripts/newsletter/create-broadcast-draft.mjs'), weekStart, `--out-dir=${outDir}`], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_EDITION: undefined },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0, `create-broadcast-draft.mjs dry run failed: ${res.stderr}`);
  return `${res.stdout}${res.stderr}`;
}

test('pre-send-check.mjs injects the PRE-SEND ISSUES banner for soft issues', (t) => {
  const weekStart = '2026-08-24';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-banner-guard-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  writeFixture(outDir, weekStart);

  const out = runPreSendCheck(outDir, weekStart);
  assert.match(out, /Pre-send check OK/);
  assert.match(out, /soft issue\(s\) flagged in draft banner/);

  const html = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
  assert.ok(html.includes(BANNER_MARKER), 'expected the soft-issue banner to be injected into the draft HTML');
  assert.ok(html.includes('PRE-SEND ISSUES'), 'expected the banner text in the draft HTML');
});

test('create-broadcast-draft.mjs strips the banner before it would reach the subscriber PATCH', (t) => {
  const weekStart = '2026-08-24';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-banner-guard-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  writeFixture(outDir, weekStart);
  runPreSendCheck(outDir, weekStart); // injects the banner, as proven above

  const bannered = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
  assert.ok(bannered.includes(BANNER_MARKER), 'precondition: banner must be present before create-broadcast-draft.mjs runs');
  const expectedStripped = stripPreSendBanner(bannered);
  assert.equal(expectedStripped.stripped, true);

  const out = runCreateBroadcastDraftDryRun(outDir, weekStart);
  assert.match(
    out,
    /Stripped pre-send soft-issue banner from draft HTML before PATCH/,
    'create-broadcast-draft.mjs did not report stripping the banner — the guard is not wired',
  );
  // The byte count it logs is what would be sent to Resend — assert it matches
  // the already-stripped length, not the raw bannered length, so a future
  // refactor that reads the file but forgets to use the stripped variable
  // (e.g. builds the PATCH payload from `bannered` instead of `html`) fails here.
  assert.match(out, new RegExp(`\\(${expectedStripped.html.length} bytes\\)`));
  const rawLengthPattern = new RegExp(`\\(${bannered.length} bytes\\)`);
  assert.ok(!rawLengthPattern.test(out), 'reported byte count matches the UN-stripped HTML — banner would reach the PATCH payload');
});

test('create-broadcast-draft.mjs is a no-op strip when no banner is present (happy path unaffected)', (t) => {
  const weekStart = '2026-08-24';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-banner-guard-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  writeFixture(outDir, weekStart);
  // No pre-send-check.mjs run here — the HTML never had a banner injected.

  const out = runCreateBroadcastDraftDryRun(outDir, weekStart);
  assert.ok(
    !/Stripped pre-send soft-issue banner/.test(out),
    'strip message printed even though no banner was present in the source HTML',
  );
});
