// Regression guard (2026-08-23): the West End weekly draft for week
// 2026-08-17 led its subject line and editorial lede with "Jeeves Takes
// Charge opens to decent reviews" (Off West End, Charing Cross Theatre, 25
// reviews, score 69) ahead of "Abigail's Party opens to strong reviews"
// (West End, Harold Pinter Theatre, 25 reviews, score 79) — an Off West End
// show outranked a same-week West End show purely because weOpeningStories()
// and the newsworthiness scorer ranked by review count/score with no
// awareness of venue tier at all. The card order in the "Opened in the West
// End" section had the same bug (Jeeves/Anansi before Abigail's Party).
//
// West End (the full-scale venue tier) must always lead Off West End (the
// smaller-venue tier) in the subject, the lede, and the card order — the
// same way the Broadway edition always leads with Broadway over
// Off-Broadway. This test runs the real generator (never a copy of its
// logic, per CLAUDE.md §15) against the live data checkout for the exact
// week the bug was reported and asserts West End leads throughout.
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
const STATE_SANDBOX = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-state-sandbox-')), 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE_SANDBOX);

const WEEK_START = '2026-08-17';
const WEST_END_SHOW = { id: 'abigails-party-west-end-2026', title: "Abigail’s Party" };
const OFF_WEST_END_SHOWS = ['jeeves-takes-charge-west-end-2026', 'anansi-the-spider-west-end-2026'];

test('west-end edition for weekStart 2026-08-17 leads subject/lede/cards with the West End opening, not an Off West End one', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-openings-tier-order-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK_START], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: 'west-end', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE_SANDBOX },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK_START}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK_START}.html`), 'utf8');

    // Subject line names the West End show, not an Off West End one.
    assert.ok(
      meta.subject.includes(WEST_END_SHOW.title),
      `expected subject to lead with ${WEST_END_SHOW.title}; got: ${meta.subject}`,
    );
    for (const id of OFF_WEST_END_SHOWS) {
      assert.ok(!meta.subject.startsWith(id), `subject should not lead with an Off West End show id; got: ${meta.subject}`);
    }

    // Lede's first named show is the West End one.
    assert.ok(meta.ledeShows.length > 0, 'expected at least one lede show');
    assert.equal(meta.ledeShows[0].id, WEST_END_SHOW.id, `expected first lede show to be ${WEST_END_SHOW.id}; got: ${JSON.stringify(meta.ledeShows.map((s) => s.id))}`);

    // The rendered card order in the body also leads with the West End show.
    const headingIdx = html.indexOf('Opened in the West End');
    assert.ok(headingIdx >= 0, 'expected the west-end openings section heading in the rendered HTML');
    const westEndIdx = html.indexOf(WEST_END_SHOW.title, headingIdx);
    assert.ok(westEndIdx > headingIdx, `expected ${WEST_END_SHOW.title} to render inside the openings section`);
    for (const offId of OFF_WEST_END_SHOWS) {
      const offTitle = offId.startsWith('jeeves') ? 'Jeeves Takes Charge' : 'Anansi the Spider';
      const offIdx = html.indexOf(offTitle, headingIdx);
      if (offIdx >= 0) {
        assert.ok(westEndIdx < offIdx, `expected ${WEST_END_SHOW.title} (West End) to render before ${offTitle} (Off West End)`);
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
