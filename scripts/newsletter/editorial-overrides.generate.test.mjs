// LIVE-DATA-LANE: reads data/reviews.json (untracked core data); data/shows.json (untracked core data); data/audience-buzz.json (untracked core data); +3 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7547: the owner decided (2026-11-15) that Pride (Bridge Theatre transfer)
// goes in the West End weekly for 2026-11-09 even though the fresh-run gate
// (BRO-3822) would hold it back. Runs the real generator and asserts the show
// renders as a card, under its plain title, and the editorial says it moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-state-'));
const STATE = path.join(SANDBOX, 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE);
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* no-op */ } });

const PRIDE = 'pride-bridge-theatre-off-west-end-2026';

function generate(edition, weekStart) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-gen-'));
  execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_EDITION: edition, NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE, NEWSLETTER_AI_SUBJECT_DISABLED: '1' },
    stdio: 'pipe',
    timeout: 90_000,
  });
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, `A-${weekStart}.meta.json`), 'utf8'));
  const html = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
  fs.rmSync(outDir, { recursive: true, force: true });
  return { meta, html };
}

test('West End 2026-11-09 features Pride under its plain title with a "moved" editorial note', () => {
  const { meta, html } = generate('west-end', '2026-11-09');
  assert.ok(meta.openingShows.some((s) => s.id === PRIDE), 'Pride must be an opening show');
  assert.ok(meta.openingShows.find((s) => s.id === PRIDE).title === 'Pride', 'plain title, no venue suffix');
  assert.ok(!html.includes('Pride - Bridge Theatre'), 'no venue-suffixed title anywhere in the email');
  assert.match(meta.lede, /Pride\*? has transferred/);
  const note = (meta.lede.match(/Pride\*? has transferred[^.]*\./) || [''])[0];
  assert.ok(note && !/Dorfman|Bridge Theatre|critics/.test(note), 'the note names no theatre and no critic count');
  assert.ok(meta.ledeShows.some((s) => s.id === PRIDE), 'lede names Pride, so the lede-in-body check must see it');
});

test('the same week in the Broadway edition does not get the West End exception', () => {
  const { meta, html } = generate('broadway', '2026-11-09');
  assert.ok(!meta.openingShows.some((s) => s.id === PRIDE));
  assert.ok(!/has moved from the Dorfman/.test(meta.lede));
  assert.ok(!html.includes('has moved from the Dorfman'));
});
