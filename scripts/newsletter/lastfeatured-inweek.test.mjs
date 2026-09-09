// Regression guard (owner-reported 2026-08-30/31, BRO-2573): The Real Ivanov
// (opened 2026-08-25, off-broadway, 14 clean scored reviews) appeared as the
// Broadway edition's Pan of the Week that issue but never got its own
// "Opened Off-Broadway" card — not that week, not ever. Root cause: a stale
// data/newsletter-state.json entry from the 2026-08-10 issue already listed
// the show as "featured" three weeks before its real opening, and
// offBroadwayOpenings()'s lastFeaturedIds suppression trusted that history
// unconditionally. Fixed (commit 88392c0598a) so a show whose openingDate
// falls IN THE CURRENT WEEK can never be suppressed by lastFeaturedIds — that
// specific opening event could not possibly have been covered by an earlier
// issue, no matter what stale state.json says.
//
// A second, related fix in the same commit: broadwayOpenings()/
// offBroadwayOpenings() were called unconditionally regardless of edition,
// so a West End run still fired markFeatured() on every NYC show that
// opened that week and polluted the WE edition's OWN state.json entry with
// Broadway/OB ids (no live rendering bug — sectionOrder never renders their
// HTML in WE mode — but real state pollution, same failure class already
// fixed 2026-07-12 for 5 sibling sections). Now IS_WE-gated the same way.
//
// This test runs the real generator (never a copy of its logic, per
// CLAUDE.md §15) against the live data checkout for the exact week and show
// the bug was reported on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const WEEK = '2026-08-24';
const SHOW_ID = 'the-real-ivanov-off-broadway-2026';
const SHOW_TITLE = 'The Real Ivanov';

// The generator's state file is redirected into a temp dir, seeded from the real
// one (BRO-2606). These runs used to read AND REWRITE the tracked
// data/newsletter-state.json; `node --test` runs test FILES concurrently, so this
// file and featured-state-persist-order.test.mjs raced each other on it — and a
// local run left a tracked data file dirty in a shared checkout. Seeding from the
// real file keeps the stale-entry history the first test below depends on.
function runGenerator(weekStart, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastfeatured-inweek-test-'));
  const statePath = path.join(dir, 'newsletter-state.json');
  fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), statePath);
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_OUT_DIR: dir, NEWSLETTER_STATE_PATH: statePath, ...extraEnv },
      stdio: 'pipe',
      timeout: 60_000,
    });
    return {
      meta: JSON.parse(fs.readFileSync(path.join(dir, `A-${weekStart}.meta.json`), 'utf8')),
      html: fs.readFileSync(path.join(dir, `A-${weekStart}.html`), 'utf8'),
      state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('broadway edition renders an in-week off-Broadway opening even when a stale lastFeaturedIds entry claims it was already featured', () => {
  const { meta, html } = runGenerator(WEEK);

  const section = meta.sections.find((s) => s.name === 'offbroadway-openings');
  assert.ok(section, 'expected an offbroadway-openings section entry');
  assert.equal(section.fired, true, `expected offbroadway-openings to fire; skipReason=${section.skipReason}`);

  assert.ok(html.includes(SHOW_TITLE), `expected ${SHOW_TITLE} to render in the Opened Off-Broadway body`);
  const openingRef = meta.openingShows.find((s) => s.id === SHOW_ID);
  assert.ok(openingRef, `expected ${SHOW_ID} in meta.openingShows (lede/completeness gates read this list)`);
});

// Narrowed 2026-08-31 (BRO-2606). The original assertion was "a WE run records
// ZERO Broadway/off-Broadway ids", which was the right invariant while the WE
// edition rendered no NYC shows at all. BRO-2590 then added the broadway-we
// section, so the WE edition now legitimately renders (and must therefore
// remember) the week's Broadway openings — its own inBroadwayOpeningWindowForWE()
// grace window reads them back out of lastFeaturedIds next week. The real
// invariant underneath both cases is unchanged and is what this now asserts: a
// WE run may only record NYC ids it actually RENDERED. bwO/obO's ids — the
// BRO-2573 pollution — are never rendered in the WE edition, so they must still
// never appear, and off-Broadway can never appear at all (broadway-we is
// Broadway-category only).
test('west-end edition run records only the Broadway ids it actually rendered — never bwO/obO pollution', () => {
  const { meta, state } = runGenerator(WEEK, { NEWSLETTER_EDITION: 'west-end' });
  const issue = state.issues.find((i) => i.weekStart === WEEK && i.edition === 'west-end');
  assert.ok(issue, `expected a west-end issue row for ${WEEK}`);

  const { shows } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/shows.json'), 'utf8'));
  const categoryById = new Map(shows.map((s) => [s.id, s.category]));
  const nyc = (issue.featuredShowIds || []).filter((id) => {
    const cat = categoryById.get(id);
    return cat === 'broadway' || cat === 'off-broadway';
  });

  const offBroadway = nyc.filter((id) => categoryById.get(id) === 'off-broadway');
  assert.deepEqual(offBroadway, [], `the West End edition renders no off-Broadway show anywhere, so none may be recorded; found: ${offBroadway.join(', ')}`);

  // Everything else must be a show the WE draft actually put on the page.
  const renderedIds = new Set((meta.openingShows || []).map((s) => s.id));
  const unrendered = nyc.filter((id) => !renderedIds.has(id));
  assert.deepEqual(unrendered, [], `expected every Broadway id in the West End edition's own state row to have been rendered in the draft (BRO-2573 pollution guard), found unrendered: ${unrendered.join(', ')}`);
});
