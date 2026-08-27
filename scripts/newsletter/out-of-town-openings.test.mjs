// Regression guard: out-of-town (regional/pre-Broadway-tryout) shows were
// entirely invisible in the Weekly Round-up newsletter — PRIMARY only ever
// covers broadway/off-broadway (or west-end/off-west-end for the WE
// edition), so a category:'regional' show never rendered anywhere in
// generate.mjs even after it had been pulled into the pipeline and reviewed.
// Per owner direction: an out-of-town show that gets pulled in and reviewed
// THAT week should also go in the weekly roundup.
//
// This test runs the real generator (never a copy of its logic, per
// CLAUDE.md §15) against the live data checkout for the exact week Elephant
// Shoes (Two River Theater / Deaf West, a regional world premiere) got its
// first scored review (njarts, 2026-06-19, inside the Mon 2026-06-15 -
// Sun 2026-06-21 window) and asserts:
//   1. The Out of Town section fires and renders the show that week.
//   2. It does NOT repeat the following week, once the show has an earlier
//      review on record (the section is a one-time "just reviewed" signal,
//      not a standing regional-shows feed).
//   3. The West End edition never renders it — "out of town" is a Broadway
//      idiom and West End regional houses use their own vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHOW_ID = 'elephant-shoes-regional-2026';
const SHOW_TITLE = 'Elephant Shoes';
const FIRST_REVIEW_WEEK = '2026-06-15';
const FOLLOWING_WEEK = '2026-06-22';

function runGenerator(weekStart, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-of-town-openings-test-'));
  execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, ...extraEnv },
    stdio: 'pipe',
    timeout: 60_000,
  });
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${weekStart}.meta.json`), 'utf8'));
  const html = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
  fs.rmSync(outDir, { recursive: true, force: true });
  return { meta, html };
}

test('broadway edition renders Out of Town section for the week a regional show is first reviewed', () => {
  const { meta, html } = runGenerator(FIRST_REVIEW_WEEK);

  const section = meta.sections.find((s) => s.name === 'out-of-town-openings');
  assert.ok(section, 'expected an out-of-town-openings section entry');
  assert.equal(section.fired, true, `expected out-of-town-openings to fire; skipReason=${section.skipReason}`);

  assert.ok(html.includes('Out of Town'), 'expected the "Out of Town" section heading in the rendered HTML');
  assert.ok(html.includes(SHOW_TITLE), `expected ${SHOW_TITLE} to render in the body`);

  const openingRef = meta.openingShows.find((s) => s.id === SHOW_ID);
  assert.ok(openingRef, `expected ${SHOW_ID} in meta.openingShows (lede/completeness gates read this list)`);
});

test('broadway edition does not repeat an out-of-town show the week after its first review', () => {
  const { meta, html } = runGenerator(FOLLOWING_WEEK);
  assert.ok(!html.includes(SHOW_TITLE), `expected ${SHOW_TITLE} not to render again the following week`);
  const openingRef = meta.openingShows.find((s) => s.id === SHOW_ID);
  assert.ok(!openingRef, `expected ${SHOW_ID} not to reappear in meta.openingShows the following week`);
});

test('west-end edition never renders an Out of Town section', () => {
  const { meta, html } = runGenerator(FIRST_REVIEW_WEEK, { NEWSLETTER_EDITION: 'west-end' });
  assert.ok(!html.includes('Out of Town'), 'expected no "Out of Town" heading in the West End edition');
  const section = meta.sections.find((s) => s.name === 'out-of-town-openings');
  if (section) assert.equal(section.fired, false, 'expected out-of-town-openings to never fire in the West End edition');
});
