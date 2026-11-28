import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-shows-prebuild.js');
const row = (id, o = {}) => ({ id, title: id.toUpperCase(), slug: id, category: 'broadway', status: 'open', venue: 'Hudson Theatre', ...o });

function run(shows, extraEnv = { SKIP_ROW_ALERT: 'true' }) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'rows-')), 'shows.json');
  writeFileSync(f, JSON.stringify({ shows }));
  return spawnSync('node', [script], { env: { ...process.env, SHOWS_FILE_OVERRIDE: f, ...extraEnv }, encoding: 'utf8' });
}

test('BRO-5954: a null-venue row and a null-title row are skipped, named, and the build gate passes', () => {
  const r = run([row('alpha'), row('bad-venue', { venue: null }), row('bad-title', { title: null }), row('gamma')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping 2 malformed/);
  assert.match(r.stderr, /bad-venue: venue is null/);
  assert.match(r.stderr, /bad-title: title is null/);
  assert.match(r.stdout, /::warning title=Skipped malformed shows.json row::bad-venue/);
  assert.match(r.stdout, /2 shows, no duplicates/);
});

test('real duplicates still block the build', () => {
  const r = run([row('alpha'), row('alpha-copy', { title: 'ALPHA', slug: 'alpha' })]);
  assert.equal(r.status, 1);
});

test('BRO-6025: a SHOWS_FILE_OVERRIDE fixture run never reaches the alert router, even without SKIP_ROW_ALERT', () => {
  const ledger = path.join(mkdtempSync(path.join(tmpdir(), 'ledger-')), 'ledger.json');
  const r = run([row('alpha'), null, 5, { id: 'a' }], { ALERT_LEDGER_PATH: ledger, SKIP_ROW_ALERT: '', LINEAR_API_KEY: '', RESEND_API_KEY: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping 3 malformed/);
  assert.equal(existsSync(ledger), false, 'alert router wrote a ledger for a fixture run');
  assert.doesNotMatch(r.stderr, /row-skip alert/);
});
