// LIVE-DATA-LANE: reads data/reviews.json (untracked core data); data/shows.json (untracked core data); +3 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// Owner 2026-11-15: Coming Up lists ALL Broadway openings of the coming week, and the
// weekly must not show a Wanted "66 -> 59" mover when readers were told 60.
// Runs the real generator on the real 2026-11-09 data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'comingup-state-'));
const STATE = path.join(SANDBOX, 'newsletter-state.json');
fs.copyFileSync(path.join(repoRoot, 'data/newsletter-state.json'), STATE);
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* no-op */ } });

function generateBroadway(weekStart) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comingup-gen-'));
  execFileSync('node', [path.join(repoRoot, 'scripts/newsletter/generate.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_EDITION: 'broadway', NEWSLETTER_OUT_DIR: outDir, NEWSLETTER_STATE_PATH: STATE, NEWSLETTER_AI_SUBJECT_DISABLED: '1', GA4_PROPERTY_ID: '' },
    stdio: 'pipe',
    timeout: 90_000,
  });
  const html = fs.readFileSync(path.join(outDir, `A-${weekStart}.html`), 'utf8');
  fs.rmSync(outDir, { recursive: true, force: true });
  return html;
}

test('Broadway 2026-11-09: Coming Up lists every Broadway show opening 2026-11-16..22', () => {
  const html = generateBroadway('2026-11-09');
  const seg = html.slice(html.indexOf('Coming Up'));
  const shows = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/shows.json'), 'utf8'));
  const list = Array.isArray(shows) ? shows : shows.shows;
  const expected = list.filter((s) => s.category === 'broadway' && s.type !== 'opera' && s.openingDate >= '2026-11-16' && s.openingDate <= '2026-11-22');
  assert.ok(expected.length >= 4, 'fixture week should have 4 Broadway openings');
  for (const s of expected) assert.ok(seg.includes(`/show/${s.slug}`), `${s.title} (opens ${s.openingDate}) missing from Coming Up`);
});

test('Broadway 2026-11-09: no Wanted mover card (opened Nov 8, readers were told 60)', () => {
  const html = generateBroadway('2026-11-09');
  assert.ok(!html.includes('down 7 pts'), 'Wanted must not show a 66 -> 59 mover');
  const i = html.indexOf('Biggest Mover');
  assert.ok(i < 0 || !html.slice(i, i + 3000).includes('/show/wanted'), 'Wanted must not be a mover card');
});
