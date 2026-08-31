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
const WEEK_START = '2026-08-24';
const BW_SHOW_ID = 'paranormal-activity-2026';
const BW_SHOW_TITLE = 'Paranormal Activity';
const OB_SHOW_TITLE = 'The Real Ivanov';

function runGenerator(weekStart, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-broadway-section-test-'));
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
