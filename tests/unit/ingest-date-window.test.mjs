/**
 * ingest-review-from-url --date-window (BRO-4656): tour-stop discovery passes
 * the stop's engagement window; a page dated outside it, or undated, is skipped
 * before any file is written. Runs the REAL script offline (fetchPage stubbed
 * by a -r preload) against a temp corpus (--data-dir).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ingest-review-from-url.js');
const STUB = path.join(ROOT, 'tests', 'fixtures', 'ingest-date-window', 'stub-fetch.cjs');
const SHOW = 'spamalot-tour-2025';

function run(date, extra = [], envExtra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-window-'));
  fs.mkdirSync(path.join(root, SHOW));
  const env = { ...process.env, STUB_PUBLISH_DATE: date || '', ...envExtra };
  let out;
  try {
    out = execFileSync('node', ['-r', STUB, SCRIPT, `--show=${SHOW}`, '--url=https://www.denverpost.com/x/spamalot-review/',
      '--outlet=denver-post', `--data-dir=${root}`, ...extra], { encoding: 'utf8', stdio: 'pipe', env, timeout: 60000 });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const files = fs.readdirSync(path.join(root, SHOW)).filter(f => f.endsWith('.json'));
  fs.rmSync(root, { recursive: true, force: true });
  return { out, files };
}

const WINDOW = '--date-window=2025-12-30,2026-02-17';

test('a page dated during the tour but outside this stop is skipped with nothing written', () => {
  // Without the window this page is written (the tour-family date guard only
  // rejects dates outside every tour of the title).
  assert.equal(run('2026-06-01').files.length, 1);
  const r = run('2026-06-01', [WINDOW]);
  assert.match(r.out, /outside --date-window/);
  assert.deepEqual(r.files, []);
});

test('an undated page is skipped when a window is given', () => {
  const r = run(null, [WINDOW]);
  assert.match(r.out, /publish date unknown outside --date-window/);
  assert.deepEqual(r.files, []);
});

test('a page dated inside the window passes the window check', () => {
  const r = run('2026-01-08', [WINDOW, '--dry-run']);
  assert.doesNotMatch(r.out, /outside --date-window/);
  assert.match(r.out, /Pub:\s+2026-01-08/);
});

test('a failed fetch under a window writes no retry stub (its date cannot be checked)', () => {
  const r = run(null, [WINDOW, '--stub-on-failure'], { STUB_FETCH_FAIL: '1' });
  assert.match(r.out, /no retry stub under --date-window/);
  assert.deepEqual(r.files, []);
});
