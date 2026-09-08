// Regression guard for the 2026-09-06 incident: the Broadway edition for
// week 2026-08-31 had zero new Broadway/Off-Broadway openings that week, so
// the US-edition subject/lede (only London openings scoring >=75 were even
// candidates) picked ONE secondary West End story almost at random and
// dropped the other 3 real London openings (Electra/Persona, The Story, Holy
// Fool, A Month in the Country all opened that week) from the pool entirely
// — "A Month in the Country opens in London to strong reviews" led the whole
// email as if nothing else happened, even though it wasn't the venue-tier
// lead by the site's own ranking rules and 3 other real stories existed.
//
// Fixed by relaxing the >=75 gate specifically when bwEvents/obEvents are
// both empty (quietBroadwayWeek), adding a "A quiet week on Broadway." opener
// gated on the actual #1 candidate being a WE/OWE opening (not merely on no
// NEW openings — a closing/mover/recoupment can still be real news), and
// floating londonSection()'s lead card to match weOpeningStories()[0] on a
// quiet Broadway week the same way it already does for the WE edition
// (BRO-273 class bug, left open here until the second-opinion review caught
// it 2026-09-07).
//
// This runs the real generator (never a copy of its logic, per CLAUDE.md
// §15) — but against a FIXTURE corpus, not live data/shows.json (BRO-3042).
// The original version of this test picked a real historical week and hard-
// coded its 4 real London openings as the expected pool. That premise is not
// stable: shows.json only grows, and offBroadwayOpenings()'s 14-day grace
// window (deliberate — catches a show whose openingDate predates the week it
// actually got added to our DB, see that function's own comment) means ANY
// OB show later discovered/added with an openingDate inside
// [weekStart-14, weekEnd] flips quietBroadwayWeek to false for that week,
// forever, no matter how long ago the week itself passed. That's exactly
// what happened here: spellbound-off-broadway-2026 (opened 2026-08-19) was
// added to the corpus after this test was written and silently invalidated
// its "genuinely dead week" premise — main went red testing a fact about the
// world, not a bug in the code (confirmed in BRO-3042: the composer was
// behaving correctly, declining the fallback because real OB news existed).
//
// A fixture corpus with exactly the 4 WE/OWE openings makes "genuinely dead
// week" a controlled input instead of a moving target, while still
// exercising every real code path (openingEventsForWeek, aggregateScore,
// minReviews, weOpeningStories, quietBroadwayWeek, the ledeStory float,
// subject/lede assembly) exactly as the live generator does — generate.mjs
// reads NEWSLETTER_TEST_SHOWS_PATH / NEWSLETTER_TEST_REVIEWS_PATH when set
// (test-only override, added for this).
//
// The fixture also includes two DECOY shows — a Broadway opening months
// outside the week and an Off-Broadway opening just before the 14-day grace
// window's cutoff (see offBroadwayOpenings() in generate.mjs) — so
// quietBroadwayWeek being true here proves the composer correctly excluded
// them, not merely that the fixture contains nothing at all (Codex
// adversarial review, BRO-3042: an all-empty fixture "proves" quiet-week
// vacuously and stops covering the boundary this test exists to guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Same per-file state sandbox pattern as we-opening-stories.test.mjs
// (BRO-2606) — generate.mjs reads AND rewrites data/newsletter-state.json,
// and node --test runs test files concurrently. The fixture uses show IDs
// that have never appeared in any real issue, so a copy of the real state
// (rather than an empty one) is fine — notFeatured()/lastFeaturedIds() will
// trivially pass for IDs the state has never seen.
const STATE_SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-state-sandbox-'));
const STATE_SANDBOX = path.join(STATE_SANDBOX_DIR, 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE_SANDBOX);
process.on('exit', () => { try { fs.rmSync(STATE_SANDBOX_DIR, { recursive: true, force: true }); } catch { /* no-op */ } });

const WEEK_START = '2026-08-31';
const WEEK_END = '2026-09-06';

// weOpeningStories() ranking (West End tier before Off West End, then
// most-reviewed-first within a tier — see weTierRank()/the sort in
// weOpeningStories()): Electra/Persona (12 reviews, West End) is the clear
// #1 — more reviews than the other West End show, and West End always
// outranks Off West End regardless of review count or score.
const LEAD_SHOW = { id: 'fx-electra-persona', title: 'Electra / Persona (Fixture)' };
const OTHER_SHOW_IDS = [
  'fx-the-story',
  'fx-holy-fool',
  'fx-month-in-the-country',
];

// Minimal show fixtures — only the fields the composer's code paths actually
// read (category/status/openingDate/type/slug/title/venue).
const FIXTURE_SHOWS = [
  { id: LEAD_SHOW.id, title: LEAD_SHOW.title, slug: LEAD_SHOW.id, category: 'west-end', status: 'open', type: 'play', openingDate: '2026-09-01', venue: 'Fixture Theatre A' },
  { id: 'fx-the-story', title: 'The Story (Fixture)', slug: 'fx-the-story', category: 'west-end', status: 'open', type: 'play', openingDate: '2026-09-03', venue: 'Fixture Theatre B' },
  { id: 'fx-holy-fool', title: 'Holy Fool (Fixture)', slug: 'fx-holy-fool', category: 'off-west-end', status: 'open', type: 'play', openingDate: '2026-09-04', venue: 'Fixture Theatre C' },
  { id: 'fx-month-in-the-country', title: 'A Month in the Country (Fixture)', slug: 'fx-month-in-the-country', category: 'off-west-end', status: 'open', type: 'play', openingDate: '2026-09-02', venue: 'Fixture Theatre D' },
  // Decoy Broadway opening, months before the target week — proves
  // quietBroadwayWeek is false only when it should be, not merely because
  // the fixture is empty. openingEventsForWeek('broadway') must exclude it
  // via inWeek(), the same gate real Broadway shows go through.
  { id: 'fx-decoy-broadway', title: 'Decoy Broadway Show (Fixture)', slug: 'fx-decoy-broadway', category: 'broadway', status: 'open', type: 'play', openingDate: '2026-06-01', venue: 'Fixture Theatre E' },
  // Decoy Off-Broadway opening one day before offBroadwayOpenings()'s 14-day
  // grace-window cutoff (weekStart - 14 = 2026-08-17) — proves the cutoff is
  // enforced, the exact boundary spellbound-off-broadway-2026 crossed in the
  // live-data version of this test (BRO-3042).
  { id: 'fx-decoy-off-broadway', title: 'Decoy Off-Broadway Show (Fixture)', slug: 'fx-decoy-off-broadway', category: 'off-broadway', status: 'open', type: 'play', openingDate: '2026-08-16', venue: 'Fixture Theatre F' },
];

// Reviews drive aggregateScore() via its reviews.json fallback (no
// public/data/shows/<id>.json exists for these fixture IDs, so the
// composite-score cache lookup always misses and falls through to computing
// straight off this array — see loadCompositeScore() in generate.mjs).
// Review counts: Electra=12 (most-reviewed West End show, so it's #1 within
// its tier), The Story=6, Holy Fool=5, Month=7 (best-reviewed of all four,
// but Off West End tier still ranks it behind both West End shows — the
// exact "venue tier outranks score" case the original incident was about;
// this test only asserts it isn't dropped, not that it leads).
function reviewsFor(showId, count, score, publishDate = '2026-09-01') {
  return Array.from({ length: count }, (_, i) => ({
    showId,
    outlet: `Fixture Outlet ${i + 1}`,
    critic: `Fixture Critic ${i + 1}`,
    assignedScore: score,
    publishDate,
    tier: 1,
  }));
}
const FIXTURE_REVIEWS = [
  ...reviewsFor(LEAD_SHOW.id, 12, 78),
  ...reviewsFor('fx-the-story', 6, 70),
  ...reviewsFor('fx-holy-fool', 5, 65),
  ...reviewsFor('fx-month-in-the-country', 7, 82),
  // Decoys: fully scoreable (so exclusion is provably the date-window logic,
  // not a missing-score short-circuit), reviewed on their own (pre-week)
  // opening dates so they never enter any "this week" review count either.
  ...reviewsFor('fx-decoy-broadway', 5, 72, '2026-06-01'),
  ...reviewsFor('fx-decoy-off-broadway', 3, 68, '2026-08-16'),
];

test('broadway edition for a genuinely dead BW/OB news week names all 4 fixture London openings and agrees on the lead across subject, lede, and card order', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-quiet-week-data-'));
  const showsPath = path.join(dataDir, 'shows.json');
  const reviewsPath = path.join(dataDir, 'reviews.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: FIXTURE_SHOWS }));
  fs.writeFileSync(reviewsPath, JSON.stringify({ reviews: FIXTURE_REVIEWS }));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-quiet-week-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK_START], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NEWSLETTER_EDITION: 'broadway',
        NEWSLETTER_OUT_DIR: outDir,
        NEWSLETTER_STATE_PATH: STATE_SANDBOX,
        NEWSLETTER_TEST_SHOWS_PATH: showsPath,
        NEWSLETTER_TEST_REVIEWS_PATH: reviewsPath,
      },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK_START}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK_START}.html`), 'utf8');

    // The pool wasn't truncated back down to one show — all 4 fixture London
    // openings survive into the lede's show references.
    const ledeIds = meta.ledeShows.map((s) => s.id).sort();
    assert.deepEqual(
      ledeIds,
      [LEAD_SHOW.id, ...OTHER_SHOW_IDS].sort(),
      `expected all 4 London openings in ledeShows; got: ${JSON.stringify(ledeIds)}`,
    );

    // Subject leads with the weOpeningStories() pick.
    assert.ok(
      meta.subject.includes(LEAD_SHOW.title),
      `expected subject to name ${LEAD_SHOW.title}; got: ${meta.subject}`,
    );

    // The "quiet week" framing sentence fires (real Broadway/OB news would
    // suppress it — see the newsworthyCandidates[0].kind gate in generate.mjs).
    assert.ok(html.includes('A quiet week on Broadway.'), 'expected the quiet-week opener sentence in the rendered HTML');

    // Neither decoy ever renders anywhere — proves they were excluded by the
    // date-window logic itself, not merely absent from the corpus.
    assert.ok(!html.includes('Decoy Broadway Show'), 'decoy Broadway show (months outside the week) must not render');
    assert.ok(!html.includes('Decoy Off-Broadway Show'), 'decoy Off-Broadway show (one day before the grace-window cutoff) must not render');

    // Lede's first named show is the same show the subject names.
    assert.equal(
      meta.ledeShows[0].id,
      LEAD_SHOW.id,
      `expected first lede show to be ${LEAD_SHOW.id}; got: ${JSON.stringify(meta.ledeShows.map((s) => s.id))}`,
    );

    // The rendered card order in the body ("London Openings" is the BW
    // edition's heading; "Opened in the West End" is WE-only) also leads
    // with the same show — the ledeStory float extended to quietBroadwayWeek.
    const headingIdx = html.indexOf('London Openings');
    assert.ok(headingIdx >= 0, 'expected the London Openings section heading in the rendered HTML');
    const leadIdx = html.indexOf(LEAD_SHOW.title, headingIdx);
    assert.ok(leadIdx > headingIdx, `expected ${LEAD_SHOW.title} to render inside the London Openings section`);
    for (const otherId of OTHER_SHOW_IDS) {
      const otherTitle = meta.ledeShows.find((s) => s.id === otherId)?.title;
      assert.ok(otherTitle, `expected ${otherId} to be a named lede show`);
      const otherIdx = html.indexOf(otherTitle, headingIdx);
      if (otherIdx >= 0) {
        assert.ok(leadIdx < otherIdx, `expected ${LEAD_SHOW.title} to render before ${otherTitle}`);
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
