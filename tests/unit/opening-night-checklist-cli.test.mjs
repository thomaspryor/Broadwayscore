import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/opening-night-checklist.js');
const CWD = path.resolve(__dirname, '../..');

describe('opening-night-checklist CLI', () => {
  it('--show=NON_EXISTENT_ID exits non-zero with JSON error', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--show=absolutely-does-not-exist-2099', '--json'],
      { cwd: CWD, encoding: 'utf8', timeout: 30000 }
    );
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    const output = result.stdout.trim();
    assert.ok(output.length > 0, 'stdout should contain JSON error');
    const json = JSON.parse(output);
    assert.ok(json.error || json.shows?.length === 0, 'JSON should indicate error or empty shows');
    assert.ok(json.generatedAt, 'JSON should have generatedAt');
  });

  it('--show=the-fear-of-13-2026 --json returns valid JSON with check results', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--show=the-fear-of-13-2026', '--json'],
      { cwd: CWD, encoding: 'utf8', timeout: 30000 }
    );
    // May exit 0 or 1 depending on check results — both are valid
    const output = result.stdout.trim();
    assert.ok(output.length > 0, 'stdout should contain JSON');
    const json = JSON.parse(output);
    assert.ok(json.generatedAt, 'should have generatedAt');
    assert.ok(Array.isArray(json.shows), 'should have shows array');
    if (json.shows.length > 0) {
      const show = json.shows[0];
      assert.ok(Array.isArray(show.results), 'should have results array');
      assert.ok(show.results.length >= 5, `should have at least 5 check results, got ${show.results.length}`);
      assert.ok(show.summary, 'should have summary');
      assert.equal(typeof show.summary.errors, 'number');
      assert.equal(typeof show.summary.warnings, 'number');
      assert.equal(typeof show.summary.ok, 'number');
    }
  });
});
