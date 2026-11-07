// BRO-4381: end-to-end runs of the Off-Broadway coverage guard against the
// real TheaterMania fixture, in a scratch audit dir. Requires the real script
// (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { main } = require('../../scripts/check-off-broadway-source-coverage.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'scripts', 'lib', 'fixtures', 'theatermania-ob-sample.json');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ob-coverage-'));
  const shows = join(dir, 'shows.json');
  writeFileSync(shows, JSON.stringify({ shows: [
    { id: 'degenerates-off-broadway-2026', slug: 'degenerates', title: 'Degenerates', venue: 'Playwrights Horizons', category: 'off-broadway', status: 'open' },
  ] }));
  const pending = join(dir, 'pending');
  mkdirSync(pending);
  writeFileSync(join(pending, 'bro-4377.json'), JSON.stringify({ issueNumber: 'bro-4377', status: 'pending', plan: { actions: [
    { type: 'add-show', show: { id: 'fantasma-off-broadway-2026', slug: 'fantasma', title: 'Fantasma', venue: '59E59 Theaters', category: 'off-broadway' } },
  ] } }));
  const audit = join(dir, 'audit');
  return { dir, shows, pending, audit, args: [`--shows=${shows}`, `--pending-dir=${pending}`, `--audit-dir=${audit}`, `--fixture=${FIXTURE}`] };
}

test('healthy run: writes gaps + state, pending-fix and live rows are covered', async () => {
  const s = scratch();
  const code = await main([...s.args, '--today=2026-09-29']);
  assert.equal(code, 0);
  const gaps = JSON.parse(readFileSync(join(s.audit, 'off-broadway-source-coverage-gaps.json'), 'utf8'));
  const titles = gaps.gaps.map(g => g.title);
  assert.ok(!titles.includes('Fantasma'));
  assert.ok(!titles.includes('Degenerates'));
  assert.ok(titles.includes('The Heart'));
  const state = JSON.parse(readFileSync(join(s.audit, 'off-broadway-source-coverage-state.json'), 'utf8'));
  assert.equal(state.guard.blind, false);
  assert.equal(state.guard.count, gaps.count);
  assert.ok(state['theatermania-ob:heart'], 'first-seen ledger keyed by candidateKey');
});

test('blind run (rows but none current): exit 1, gaps file untouched, ledger preserved', async () => {
  const s = scratch();
  assert.equal(await main([...s.args, '--today=2026-09-29']), 0);
  const gapsPath = join(s.audit, 'off-broadway-source-coverage-gaps.json');
  const before = readFileSync(gapsPath, 'utf8');
  // Far future: every fixture row has closed, so the feed looks rotted.
  const code = await main([...s.args, '--today=2031-01-01']);
  assert.equal(code, 1);
  assert.equal(readFileSync(gapsPath, 'utf8'), before, 'last real view kept');
  const state = JSON.parse(readFileSync(join(s.audit, 'off-broadway-source-coverage-state.json'), 'utf8'));
  assert.equal(state.guard.blind, true);
  assert.equal(state.guard.count, null);
  assert.ok(state['theatermania-ob:heart'], 'first-seen ledger survives a blind run');
});

test('--dry-run writes nothing', async () => {
  const s = scratch();
  assert.equal(await main([...s.args, '--today=2026-09-29', '--dry-run']), 0);
  assert.equal(existsSync(s.audit), false);
});
