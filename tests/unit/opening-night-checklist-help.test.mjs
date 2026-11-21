// --help or an unknown flag must exit before any work. It used to fall through
// to a full live checklist run that fetched aggregator pages via the paid
// scraper chain (2026-11-17: a `--help` probe spent scraper credits).
// Scraper keys are stripped and a 20s timeout fences a regression from spending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/opening-night-checklist.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SCRAPING|BRIGHT|BROWSERBASE|_API_KEY$/i.test(k)));
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });

test('--help prints usage and exits 0 without running checks', () => {
  for (const flag of ['--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage: /);
    assert.doesNotMatch(r.stdout + r.stderr, /Fetching|\[SB |\[SD /);
  }
});

test('an unknown flag exits 2 with usage, before any fetch', () => {
  const r = run('--shows=typo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown argument\(s\): --shows=typo/);
  assert.doesNotMatch(r.stdout + r.stderr, /Fetching|\[SB |\[SD /);
});
