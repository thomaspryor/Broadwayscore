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
// a copy of the logic), with its state file redirected into a temp dir so this
// file never races the other generator-driving tests on the tracked
// data/newsletter-state.json (see NEWSLETTER_STATE_PATH in generate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const REAL_STATE_PATH = path.join(repoRoot, 'data/newsletter-state.json');
// A week with a real London/Off-West-End opening (As You Like It, 2026-08-21)
// AND a real Broadway opening (Paranormal Activity, 2026-08-25), so both the
// london-openings and broadway-we sections have something to feature.
const WEEK = '2026-08-24';

// Runs the generator in a sandbox seeded from the real state file, and returns
// both the draft meta and the state the run persisted. Nothing under data/ is
// touched.
function runGeneratorSandboxed(weekStart, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'featured-persist-order-test-'));
  const statePath = path.join(dir, 'newsletter-state.json');
  fs.copyFileSync(REAL_STATE_PATH, statePath);
  try {
    execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
      cwd: repoRoot,
      env: { ...process.env, NEWSLETTER_OUT_DIR: dir, NEWSLETTER_STATE_PATH: statePath, ...extraEnv },
      stdio: 'pipe',
      timeout: 120_000,
    });
    return {
      meta: JSON.parse(fs.readFileSync(path.join(dir, `A-${weekStart}.meta.json`), 'utf8')),
      state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, edition, env] of [
  ['broadway', 'broadway', {}],
  ['west-end', 'west-end', { NEWSLETTER_EDITION: 'west-end' }],
]) {
  test(`${label} edition persists every opening it rendered into featuredShowIds (state write stays below markFeatured)`, () => {
    const { meta, state } = runGeneratorSandboxed(WEEK, env);

    const row = (state.issues || []).find((i) => i.weekStart === WEEK && (i.edition || 'broadway') === edition);
    assert.ok(row, `expected a ${edition} issue row for ${WEEK} in the persisted state`);

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
}

// Prevention for the race itself, rather than a before/after comparison of the
// tracked file: that comparison is a shared-resource read and any other process
// on the machine (a background refresh, another session, a parallel workflow)
// legitimately writing between the two reads would fail it for the wrong reason
// (Codex adversarial review, 2026-08-31). This is deterministic instead.
test('every newsletter test that spawns the generator redirects its state file', () => {
  const dir = path.join(repoRoot, 'scripts/newsletter');
  const offenders = [];
  let scanned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.test\.mjs$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Only files that actually launch the generator — the argv literal, the
    // same shape scripts/lib/newsletter-regen-guard.js keys on.
    if (!/['"`][^'"`]*generate\.mjs['"`]/.test(src)) continue;
    scanned++;
    if (!src.includes('NEWSLETTER_STATE_PATH')) offenders.push(f);
  }
  // A sweep that matched nothing must not read as a pass.
  assert.ok(scanned >= 5, `expected to find at least 5 generator-spawning tests, found ${scanned}`);
  assert.deepEqual(
    offenders,
    [],
    'these tests spawn scripts/newsletter/generate.mjs without setting NEWSLETTER_STATE_PATH, so each one '
    + `reads and REWRITES the tracked data/newsletter-state.json: ${offenders.join(', ')}. `
    + '`node --test` runs test FILES concurrently, so they clobber the row the others are asserting on, '
    + 'and a local run leaves a tracked data file dirty. Point the spawn at a temp copy — see '
    + 'runGeneratorSandboxed() in this file.',
  );
});
