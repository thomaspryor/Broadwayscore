// Regression guard for BRO-273 (recovered from stale Notion card
// 3b0637c5-416f-81ad-8f39-c48edb915177): the West End weekly draft for week
// 2026-07-27 (send day 2026-08-02) named "Tao of Glass" in the card stack's
// first position (28 reviews, West End tier — the weOpeningStories() pick)
// but led the subject/lede with "Brainiac Live" (only 9 reviews, but
// Critical Gold). weGoldEvents already fed newsworthiness.mjs the correct
// weOpeningStories() order (fixed 2026-08-02, commit f65d8393741), but
// newsworthiness.mjs's own per-item gold bump could still re-rank a later,
// gold-tier show ahead of an earlier, more-reviewed, non-gold show when
// picking the subject — reintroducing the exact divergence that commit was
// meant to close. Fixed by capping each we-gold-opening candidate's weight at
// the previous (list-order) candidate's weight (weOpeningStoriesCap in
// newsworthiness.mjs), so weGoldOpenings' input order always wins.
//
// This runs the real generator (never a copy of its logic, per CLAUDE.md
// §15) for the exact reported week and asserts the subject, the lede, and
// the rendered card order all agree on the lead show.
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

const WEEK_START = '2026-07-27';
// weOpeningStories() ranking (West End tier, most-reviewed-first): Tao of
// Glass (28 reviews) > Brainiac Live (9 reviews, Critical Gold) > The Car Man
// (Off West End, 29 reviews).
const LEAD_SHOW = { id: 'tao-of-glass-west-end-2026', title: 'Tao of Glass' };
const OTHER_SHOWS = ['brainiac-live-west-end-2026', 'the-car-man-west-end-2026'];

test('west-end edition for weekStart 2026-07-27 agrees on the lead West End story across subject, lede, and card order', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-opening-stories-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK_START], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: 'west-end', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE_SANDBOX },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK_START}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK_START}.html`), 'utf8');

    // Subject leads with the weOpeningStories() pick, not the gold-tier show.
    assert.ok(
      meta.subject.startsWith(LEAD_SHOW.title),
      `expected subject to lead with ${LEAD_SHOW.title}; got: ${meta.subject}`,
    );

    // Lede's first named show is the same show.
    assert.ok(meta.ledeShows.length > 0, 'expected at least one lede show');
    assert.equal(
      meta.ledeShows[0].id,
      LEAD_SHOW.id,
      `expected first lede show to be ${LEAD_SHOW.id}; got: ${JSON.stringify(meta.ledeShows.map((s) => s.id))}`,
    );

    // The rendered card order in the body also leads with the same show.
    const headingIdx = html.indexOf('Opened in the West End');
    assert.ok(headingIdx >= 0, 'expected the west-end openings section heading in the rendered HTML');
    const leadIdx = html.indexOf(LEAD_SHOW.title, headingIdx);
    assert.ok(leadIdx > headingIdx, `expected ${LEAD_SHOW.title} to render inside the openings section`);
    for (const otherId of OTHER_SHOWS) {
      const otherTitle = otherId.startsWith('brainiac') ? 'Brainiac Live' : 'The Car Man';
      const otherIdx = html.indexOf(otherTitle, headingIdx);
      if (otherIdx >= 0) {
        assert.ok(leadIdx < otherIdx, `expected ${LEAD_SHOW.title} to render before ${otherTitle}`);
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
