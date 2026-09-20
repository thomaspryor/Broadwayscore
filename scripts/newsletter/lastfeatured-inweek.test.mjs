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
// FIXTURE, not live data (BRO-3866, same class of bug as BRO-3042's
// bw-quiet-week-fallback.test.mjs). The original version of the first test
// below pinned to the real show the bug was reported on
// (the-real-ivanov-off-broadway-2026) and read live data/shows.json. That
// premise isn't stable: offBroadwayOpenings() also requires
// `s.status === 'open'`, and the real show closed (closingDate 2026-09-19) —
// main went red testing a fact about the world (a show's run ended), not a
// bug in the code. A small fixture corpus (via generate.mjs's
// NEWSLETTER_TEST_SHOWS_PATH/NEWSLETTER_TEST_REVIEWS_PATH override, added for
// BRO-3042) makes "in-week opening, stale featured history" a controlled
// input instead of a moving target, while still exercising the exact code
// path the regression is about (offBroadwayOpenings()'s
// `inWeek(s.openingDate) || !lastFeaturedIds.has(s.id)` bypass) through the
// real generator (never a copy of its logic, per CLAUDE.md §15).
//
// The second test below still runs against live data/shows.json — it asserts
// a general invariant (no off-Broadway id ever leaks into a WE state row)
// rather than pinning to one show's fate, so it isn't exposed to this class
// of drift.
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
const FIXTURE_SHOW_ID = 'fx-real-ivanov';
const FIXTURE_SHOW_TITLE = 'The Real Ivanov (Fixture)';
const FIXTURE_SHOWS = [
  {
    id: FIXTURE_SHOW_ID,
    title: FIXTURE_SHOW_TITLE,
    slug: FIXTURE_SHOW_ID,
    category: 'off-broadway',
    status: 'open',
    type: 'play',
    openingDate: '2026-08-25',
    venue: 'Fixture Off-Broadway Theatre',
  },
];
// aggregateScore() falls back to averaging this array directly — no
// public/data/shows/<id>.json exists for a fixture id, so the composite-score
// cache lookup always misses (see loadCompositeScore() in generate.mjs).
// 5 reviews clears minReviews('off-broadway') (3).
const FIXTURE_REVIEWS = Array.from({ length: 5 }, (_, i) => ({
  showId: FIXTURE_SHOW_ID,
  outlet: `Fixture Outlet ${i + 1}`,
  critic: `Fixture Critic ${i + 1}`,
  assignedScore: 82,
  publishDate: '2026-08-26',
  tier: 1,
}));
// The stale history the first test depends on: a prior issue already listed
// the fixture show as featured two weeks before its real (in-week) opening —
// same shape as the real BRO-2573 incident's 2026-08-10 entry. Within
// offBroadwayOpenings()'s 16-day lastFeaturedIds lookback for WEEK
// (2026-08-24 - 16d = 2026-08-08), so it's live pressure on the bypass this
// test guards.
const STALE_STATE = {
  issues: [
    { weekStart: '2026-08-10', edition: 'broadway', featuredShowIds: [FIXTURE_SHOW_ID] },
  ],
};

// The generator's state file is redirected into a temp dir, seeded from the real
// one (BRO-2606). These runs used to read AND REWRITE the tracked
// data/newsletter-state.json; `node --test` runs test FILES concurrently, so this
// file and featured-state-persist-order.test.mjs raced each other on it — and a
// local run left a tracked data file dirty in a shared checkout. Used only by
// the second test below now (the first builds its own fixture state, above).
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastfeatured-inweek-data-'));
  const showsPath = path.join(dataDir, 'shows.json');
  const reviewsPath = path.join(dataDir, 'reviews.json');
  const statePath = path.join(dataDir, 'newsletter-state.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: FIXTURE_SHOWS }));
  fs.writeFileSync(reviewsPath, JSON.stringify({ reviews: FIXTURE_REVIEWS }));
  fs.writeFileSync(statePath, JSON.stringify(STALE_STATE));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastfeatured-inweek-out-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NEWSLETTER_OUT_DIR: outDir,
        NEWSLETTER_STATE_PATH: statePath,
        NEWSLETTER_TEST_SHOWS_PATH: showsPath,
        NEWSLETTER_TEST_REVIEWS_PATH: reviewsPath,
      },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK}.html`), 'utf8');

    const section = meta.sections.find((s) => s.name === 'offbroadway-openings');
    assert.ok(section, 'expected an offbroadway-openings section entry');
    assert.equal(section.fired, true, `expected offbroadway-openings to fire; skipReason=${section.skipReason}`);

    assert.ok(html.includes(FIXTURE_SHOW_TITLE), `expected ${FIXTURE_SHOW_TITLE} to render in the Opened Off-Broadway body`);
    const openingRef = meta.openingShows.find((s) => s.id === FIXTURE_SHOW_ID);
    assert.ok(openingRef, `expected ${FIXTURE_SHOW_ID} in meta.openingShows (lede/completeness gates read this list)`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
