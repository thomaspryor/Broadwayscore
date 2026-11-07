// Regression guard for BRO-2590: the West End weekly had no equivalent of
// the Broadway edition's "London Openings" section — WE subscribers got
// nothing about what opened on Broadway that week. weBroadwaySection()
// mirrors londonSection() but is Broadway-category ONLY (never
// Off-Broadway, an explicit asymmetry from londonSection which includes
// both West End AND Off West End — owner request 2026-08-31).
//
// Week 2026-08-24 (Mon) - 2026-08-30 (Sun) has both a Broadway opening
// (Paranormal Activity, opened 2026-08-25, 33 scored reviews) and an
// Off-Broadway opening the SAME week (The Real Ivanov, opened 2026-08-25,
// 14 scored reviews — the show at the center of the 2026-08-30 BRO-2573
// fix). This test runs the real generator (never a copy of its logic, per
// CLAUDE.md §15) against the live data checkout and asserts:
//   1. The West End edition renders a "Opened on Broadway" section
//      containing Paranormal Activity.
//   2. The Real Ivanov (Off-Broadway) does NOT appear anywhere in the WE
//      edition's output — proving the category filter is Broadway-only.
//   3. The Broadway edition's own output is unaffected (weBroadwaySection
//      self-gates on IS_WE and never fires there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Redirect the generator's cross-issue state file into a per-file temp copy
// (BRO-2606). Every test here drives the real generate.mjs, which reads AND
// REWRITES data/newsletter-state.json; `node --test` runs test FILES
// concurrently, so sharing that one tracked path made these files race each
// other, and a local run left the checkout dirty. One copy per file (not per
// run) keeps the cross-run sharing these tests already had.
const STATE_SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-state-sandbox-'));
const STATE_SANDBOX = path.join(STATE_SANDBOX_DIR, 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE_SANDBOX);
// Module scope, so an `after()` hook would not run if the file aborts before
// the test runner takes over. 'exit' fires on a normal end AND on an early
// throw, which is what leaves these behind on a CI runner otherwise.
process.on('exit', () => { try { fs.rmSync(STATE_SANDBOX_DIR, { recursive: true, force: true }); } catch { /* no-op */ } });

// BRO-3048 live-data coupling audit: safe on live shows.json because it asserts that one named Broadway show fires the broadway-we section and that a named Off-Broadway show is excluded, not a week-wide count; a new show in the window cannot flip either, and the unit cases below build their own fixture shows.json.
// A "this week had exactly N things" assertion would need the fixture pattern instead (NEWSLETTER_TEST_SHOWS_PATH/REVIEWS_PATH).
const WEEK_START = '2026-08-24';
const BW_SHOW_ID = 'paranormal-activity-2026';
const BW_SHOW_TITLE = 'Paranormal Activity';
const OB_SHOW_TITLE = 'The Real Ivanov';

function runGenerator(weekStart, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-broadway-section-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: 'broadway', NEWSLETTER_BW_WE_LEAD: '', GA4_PROPERTY_ID: '', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE_SANDBOX, ...extraEnv },
      stdio: 'pipe',
      timeout: 60_000,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${weekStart}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
    return { meta, html };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test('west-end edition renders a Broadway section for a week with a Broadway opening', () => {
  const { meta, html } = runGenerator(WEEK_START, { NEWSLETTER_EDITION: 'west-end' });

  const section = meta.sections.find((s) => s.name === 'broadway-we');
  assert.ok(section, 'expected a broadway-we section entry in meta.sections');
  assert.equal(section.fired, true, `expected broadway-we to fire; skipReason=${section.skipReason}`);

  assert.ok(html.includes('Opened on Broadway'), 'expected the "Opened on Broadway" section heading in the rendered HTML');
  assert.ok(html.includes(BW_SHOW_TITLE), `expected ${BW_SHOW_TITLE} to render in the HTML body`);

  const headingIdx = html.indexOf('Opened on Broadway');
  const showIdx = html.indexOf(BW_SHOW_TITLE, headingIdx);
  assert.ok(showIdx > headingIdx, `expected ${BW_SHOW_TITLE} to appear inside the Broadway section, after its heading`);

  const openingRef = meta.openingShows.find((s) => s.id === BW_SHOW_ID);
  assert.ok(openingRef, `expected ${BW_SHOW_ID} in meta.openingShows (image/completeness gates read this list)`);

  assert.ok(!html.includes(OB_SHOW_TITLE), `expected Off-Broadway show ${OB_SHOW_TITLE} NOT to render in the West End edition — Broadway category only`);
});

test('broadway edition never renders a broadway-we section', () => {
  // Not an html.includes('Opened on Broadway') check: the Broadway edition's
  // own broadwayOpenings() hero legitimately renders that exact heading text
  // (generate.mjs's hasOpen-only case) — the section NAME is what proves
  // weBroadwaySection() itself never fired, independent of heading text.
  const { meta } = runGenerator(WEEK_START);
  const section = meta.sections.find((s) => s.name === 'broadway-we');
  if (section) assert.equal(section.fired, false, 'expected broadway-we to never fire in the Broadway edition');
});

// Use three real Broadway openings from one week, with their real reviews,
// to isolate the secondary feed from London's primary stories. Exercise the
// composer itself so both its returned list and subject feed are covered.
test('NEWSLETTER_BW_WE_LEAD keeps cards, subject, and lede in editorial order', () => {
  const ids = ['fallen-angels-2026', 'proof-2026', 'the-fear-of-13-2026'];
  const { shows } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/shows.json'), 'utf8'));
  const { reviews } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/reviews.json'), 'utf8'));
  const selected = shows.filter(s => ids.includes(s.id));
  assert.equal(selected.length, 3);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-we-lead-data-'));
  try {
    const showsPath = path.join(dataDir, 'shows.json');
    const reviewsPath = path.join(dataDir, 'reviews.json');
    fs.writeFileSync(showsPath, JSON.stringify({ shows: selected }));
    fs.writeFileSync(reviewsPath, JSON.stringify({ reviews: reviews.filter(r => ids.includes(r.showId)) }));
    const env = { NEWSLETTER_EDITION: 'west-end', NEWSLETTER_TEST_SHOWS_PATH: showsPath, NEWSLETTER_TEST_REVIEWS_PATH: reviewsPath };
    const baseline = runGenerator('2026-04-13', env);
    const baselineIds = baseline.meta.openingShows.map(s => s.id);
    assert.deepEqual(baselineIds, ids);
    for (const override of ['proof-2026', '  the-fear-of-13-2026  ', ids[0], 'missing-show', '']) {
      const lead = ids.includes(override.trim()) ? override.trim() : baselineIds[0];
      const expected = [lead, ...baselineIds.filter(id => id !== lead)];
      const { meta, html } = runGenerator('2026-04-13', { ...env, NEWSLETTER_BW_WE_LEAD: override });
      assert.deepEqual(meta.openingShows.map(s => s.id), expected, override);
      assert.equal(meta.ledeShows[0].id, lead, override);
      assert.ok(meta.subject.startsWith(selected.find(s => s.id === lead).title), meta.subject);
      const heading = html.indexOf('Opened on Broadway');
      assert.ok(heading >= 0);
      const positions = expected.map(id => html.indexOf(selected.find(s => s.id === id).title, heading));
      assert.ok(positions.every((position, i) => position > heading && (i === 0 || position > positions[i - 1])), override);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Broadway editorial override stays secondary to real West End stories', () => {
  const { meta } = runGenerator('2026-04-13', { NEWSLETTER_EDITION: 'west-end', NEWSLETTER_BW_WE_LEAD: 'proof-2026' });
  assert.equal(meta.openingShows.find(s => s.category === 'broadway').id, 'proof-2026');
  assert.equal(meta.ledeShows[0].id, 'avenue-q-west-end-2026');
});

test('NEWSLETTER_BW_WE_LEAD leaves the Broadway edition unchanged', () => {
  const baseline = runGenerator('2026-04-13');
  const overridden = runGenerator('2026-04-13', { NEWSLETTER_BW_WE_LEAD: 'proof-2026' });
  assert.deepEqual(overridden.meta.openingShows, baseline.meta.openingShows);
  assert.equal(overridden.meta.subject, baseline.meta.subject);
  assert.deepEqual(overridden.meta.ledeShows, baseline.meta.ledeShows);
});
