// Regression guard (BRO-2606, found 2026-08-31 while verifying BRO-2590):
// scripts/newsletter/generate.mjs persisted data/newsletter-state.json BEFORE
// the london-openings, broadway-we and also-opened-recently sections ran, so
// every show those three featured was missing from the saved featuredShowIds
// and next week's lastFeaturedIds could not suppress it.
//
// Live symptom: the West End edition led with As You Like It (Globe, opened
// 2026-08-21) and gave it the hero "Opened in the West End" card in the
// 2026-08-24 issue, then did exactly the same again in the 2026-08-31 issue.
// The Broadway edition had the same hole for its "London Openings" section.
// londonSection()'s own markFeatured() comment names the mechanism it needs
// ("via lastFeaturedIds, sourced from this issue's persisted featuredShowIds");
// the write ordering had disabled it since the section was written.
//
// The invariant asserted here is deliberately structural rather than
// show-specific, so it also catches the NEXT section that starts calling
// markFeatured() below the persist block: every show an issue rendered as an
// opening must appear in that issue's persisted featuredShowIds.
//
// Runs the real generator against the live data checkout (CLAUDE.md §15 — never
// a copy of the logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const STATE_PATH = path.join(repoRoot, 'data/newsletter-state.json');
// A week with a real London/Off-West-End opening (As You Like It, 2026-08-21)
// AND a real Broadway opening (Paranormal Activity, 2026-08-25), so both the
// london-openings and broadway-we sections have something to feature.
const WEEK = '2026-08-24';

function runGenerator(weekStart, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'featured-persist-order-test-'));
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_OUT_DIR: outDir, ...extraEnv },
      stdio: 'pipe',
      timeout: 120_000,
    });
    return JSON.parse(fs.readFileSync(path.join(outDir, `A-${weekStart}.meta.json`), 'utf8'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function persistedRow(weekStart, edition) {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return (state.issues || []).find((i) => i.weekStart === weekStart && (i.edition || 'broadway') === edition);
}

// The generator writes the real data/newsletter-state.json as a side effect.
// Snapshot and restore it so a test run never leaves the tracked file dirty for
// the next session or for CI's own commit step.
function withRestoredState(fn) {
  const before = fs.readFileSync(STATE_PATH, 'utf8');
  try {
    fn();
  } finally {
    fs.writeFileSync(STATE_PATH, before);
  }
}

for (const [label, edition, env] of [
  ['broadway', 'broadway', {}],
  ['west-end', 'west-end', { NEWSLETTER_EDITION: 'west-end' }],
]) {
  test(`${label} edition persists every opening it rendered into featuredShowIds (state write stays below markFeatured)`, () => {
    withRestoredState(() => {
      const meta = runGenerator(WEEK, env);
      const row = persistedRow(WEEK, edition);
      assert.ok(row, `expected a ${edition} issue row for ${WEEK} in data/newsletter-state.json`);

      const rendered = (meta.openingShows || []).map((s) => s.id);
      assert.ok(rendered.length > 0, `expected the ${label} draft for ${WEEK} to render at least one opening`);

      const persisted = new Set(row.featuredShowIds || []);
      const missing = rendered.filter((id) => !persisted.has(id));
      assert.deepEqual(
        missing,
        [],
        `these shows were rendered as openings in the ${label} ${WEEK} issue but never reached its persisted featuredShowIds, `
        + `so next week's lastFeaturedIds cannot suppress them: ${missing.join(', ')}. `
        + 'The state-persist block in generate.mjs has to stay BELOW every section that calls markFeatured().',
      );
    });
  });
}
