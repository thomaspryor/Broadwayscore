/**
 * --help must never run a commercial-data writer (BRO-4989 incident:
 * `sweep-pending-commercial.js --help` ran the live sweep and rewrote
 * commercial-pending-review.json and commercial-research-queue.json).
 * Same class as #498/#764 (backfill-lbo --help ran a real sweep).
 *
 * 1. Every scripts/*.js that names a commercial data file and writes files
 *    must check --help (exitOnHelp / hasHelpFlag) — new writers included.
 * 2. Each one, run with --help, exits 0 and prints usage without touching
 *    data/ (checked against file mtimes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { exitOnHelp } = require('../../scripts/lib/cli-help');

const ROOT = process.cwd();
const SCRIPTS = path.join(ROOT, 'scripts');
const NAMES_COMMERCIAL = /commercial(-pending-review|-research-queue|-pending-archive)?\.json/;
const WRITES = /writeFileSync|writeJson|atomicWrite|saveCommercial|writeCommercial/;
const CHECKS_HELP = /exitOnHelp|hasHelpFlag/;

const writers = fs.readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => {
    const s = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    return NAMES_COMMERCIAL.test(s) && WRITES.test(s);
  });

test('found the commercial writers', () => {
  assert.ok(writers.length >= 20, `only ${writers.length}`);
  assert.ok(writers.includes('sweep-pending-commercial.js'));
});

test('every commercial writer checks --help before running', () => {
  const missing = writers.filter((f) => !CHECKS_HELP.test(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')));
  assert.deepEqual(missing, [], `add require('./lib/cli-help').exitOnHelp(module); as the first statement of: ${missing.join(', ')}`);
});

// Only the commercial files: other unit tests in the parallel batch may
// legitimately write elsewhere under data/.
function dataMtimes() {
  const out = {};
  const dir = path.join(ROOT, 'data');
  for (const f of fs.readdirSync(dir).filter((n) => NAMES_COMMERCIAL.test(n))) {
    try { out[f] = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* broken link */ }
  }
  return out;
}

test("--help exits 0 with usage and leaves the commercial data files untouched", () => {
  const before = dataMtimes();
  for (const f of writers) {
    const out = execFileSync('node', [path.join(SCRIPTS, f), '--help'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', RESEND_API_KEY: '' },
    });
    assert.ok(out.trim().length > 0, `${f} printed nothing`);
  }
  assert.deepEqual(dataMtimes(), before);
});

test('exitOnHelp is a no-op for a required module', () => {
  exitOnHelp({ filename: 'x.js' }, ['--help']); // not require.main: returns
  assert.ok(true);
});
