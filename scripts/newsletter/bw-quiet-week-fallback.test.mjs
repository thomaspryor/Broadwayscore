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
// §15) for the exact reported week and asserts the opener, the lede show
// count, and the rendered card order all agree.
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
// and node --test runs test files concurrently.
const STATE_SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-state-sandbox-'));
const STATE_SANDBOX = path.join(STATE_SANDBOX_DIR, 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE_SANDBOX);
process.on('exit', () => { try { fs.rmSync(STATE_SANDBOX_DIR, { recursive: true, force: true }); } catch { /* no-op */ } });

const WEEK_START = '2026-08-31';
// weOpeningStories() ranking for this real week (West End tier before Off
// West End, then most-reviewed-first): Electra/Persona (32 reviews, West
// End) > The Story (23 reviews, West End) > Holy Fool (23 reviews, Off West
// End) > A Month in the Country (24 reviews, Off West End, actually the
// best-reviewed of the four — this test does not assert it leads; only that
// it isn't dropped).
const LEAD_SHOW = { id: 'electra-persona-west-end-2026', title: 'Electra / Persona' };
const OTHER_SHOW_IDS = [
  'the-story-west-end-2026',
  'holy-fool-off-west-end-2026',
  'a-month-in-the-country-west-end-2026',
];

test('broadway edition for weekStart 2026-08-31 (a genuinely dead BW/OB news week) names all 4 real London openings and agrees on the lead across subject, lede, and card order', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-quiet-week-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), WEEK_START], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_EDITION: 'broadway', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE_SANDBOX },
      stdio: 'pipe',
      timeout: 60_000,
    });

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${WEEK_START}.meta.json`), 'utf8'));
    const html = fs.readFileSync(path.join(outDir, `A-${WEEK_START}.html`), 'utf8');

    // The pool wasn't truncated back down to one show — all 4 real London
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
  }
});
