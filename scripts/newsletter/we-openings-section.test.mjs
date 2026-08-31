// Regression guard for card #1152 (2026-08-09): the West End weekly draft for
// week 2026-08-03 reached Resend with NO openings section at all — the subject
// line named "Now You See Me Live opens to decent reviews." but the body had
// no 'Opened in the West End' section, so I'm Every Woman (opened 2026-08-05,
// inside the week window) was invisible to subscribers.
//
// Investigation ruled out the suspected cause (a duplicate shows.json entry
// resolving reviews to the wrong show id — the closed 2026-03 run and the open
// 2026-08 run are correctly separate, and the open run correctly owns its 29
// reviews). The real cause was a send-day data-freshness gap: the draft was
// generated before this week's WE openers had cleared minReviews(3), so
// londonSection()'s score-gated list was legitimately empty at that moment.
// generate.mjs is otherwise correct — running it again once review data lands
// produces the right output — but nothing regression-tested that it stays
// correct for this exact week. This test runs the real generator (never a
// copy of its logic, per CLAUDE.md §15) against the live data checkout and
// asserts the openings section both gets computed AND gets rendered for the
// show the bug report named.
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

const WEEK_START = '2026-08-03';
const SHOW_ID = 'im-every-woman-off-west-end-2026';

test('west-end edition for weekStart 2026-08-03 renders an openings section including I\'m Every Woman', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-openings-section-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK_START], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: 'west-end', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE_SANDBOX },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK_START}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK_START}.html`), 'utf8');

    // The show must be a computed opening — not just present somewhere in the
    // lede prose (that check alone was proven invalid: a prior session cleared
    // this bug on an HTML substring grep, and the section was still missing).
    assert.ok(
      meta.openingShows.some((s) => s.id === SHOW_ID),
      `expected meta.openingShows to include ${SHOW_ID}; got: ${JSON.stringify(meta.openingShows.map((s) => s.id))}`,
    );

    const londonSection = meta.sections.find((s) => s.name === 'london-openings');
    assert.ok(londonSection, 'expected a london-openings section entry in meta.sections');
    assert.equal(londonSection.fired, true, `london-openings must have fired; skipReason: ${londonSection.skipReason}`);

    // The section heading must actually be in the rendered body, not just
    // computed in meta — the reported bug had a correct subject/lede with an
    // entirely absent body section.
    assert.ok(html.includes('Opened in the West End'), 'expected the west-end openings section heading in the rendered HTML');
    assert.ok(html.includes("I'm Every Woman"), "expected \"I'm Every Woman\" to render in the HTML body");

    // The show must render AFTER the openings heading, not merely somewhere
    // earlier in the lede — same "lede ⊆ body is not section ⊆ body" gap.
    const headingIdx = html.indexOf('Opened in the West End');
    const showIdx = html.indexOf("I'm Every Woman", headingIdx);
    assert.ok(showIdx > headingIdx, "expected \"I'm Every Woman\" to appear inside the openings section, after its heading");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
