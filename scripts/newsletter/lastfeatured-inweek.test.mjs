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

function runGenerator(weekStart, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastfeatured-inweek-test-'));
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

test('broadway edition renders an in-week off-Broadway opening even when a stale lastFeaturedIds entry claims it was already featured', () => {
  const { meta, html } = runGenerator(WEEK);

  const section = meta.sections.find((s) => s.name === 'offbroadway-openings');
  assert.ok(section, 'expected an offbroadway-openings section entry');
  assert.equal(section.fired, true, `expected offbroadway-openings to fire; skipReason=${section.skipReason}`);

  assert.ok(html.includes(SHOW_TITLE), `expected ${SHOW_TITLE} to render in the Opened Off-Broadway body`);
  const openingRef = meta.openingShows.find((s) => s.id === SHOW_ID);
  assert.ok(openingRef, `expected ${SHOW_ID} in meta.openingShows (lede/completeness gates read this list)`);
});

test('west-end edition run leaves no Broadway/off-Broadway show ids in its own featuredShowIds state', () => {
  runGenerator(WEEK, { NEWSLETTER_EDITION: 'west-end' });
  const state = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/newsletter-state.json'), 'utf8'));
  const issue = state.issues.find((i) => i.weekStart === WEEK && i.edition === 'west-end');
  assert.ok(issue, `expected a west-end issue row for ${WEEK}`);

  const { shows } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/shows.json'), 'utf8'));
  const categoryById = new Map(shows.map((s) => [s.id, s.category]));
  const nyc = (issue.featuredShowIds || []).filter((id) => {
    const cat = categoryById.get(id);
    return cat === 'broadway' || cat === 'off-broadway';
  });
  assert.deepEqual(nyc, [], `expected no Broadway/off-Broadway ids in the West End edition's own state row, found: ${nyc.join(', ')}`);
});
