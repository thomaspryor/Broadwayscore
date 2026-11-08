// BRO-7110 follow-up: land-local-check refuses a checkout missing any CORE_DATA_FILES entry and
// points at setup-local-data.sh. Every generated (cast pipeline) entry must therefore have a
// build step in that script, or a cloud worktree (whose main checkout has no copy to take) is
// refused with no automatic remedy. require()s the real list (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { CORE_DATA_FILES } = require('./land-local-check.js');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts/setup-local-data.sh'), 'utf8');

const generated = (SCRIPT.match(/^GENERATED_FILES=\(([^)]*)\)/m) || [])[1]?.trim().split(/\s+/) || [];
const fn = (SCRIPT.match(/^generator_for\(\) \{[\s\S]*?^\}/m) || [])[0];

test('setup-local-data.sh declares GENERATED_FILES and a generator_for() build step', () => {
  assert.ok(generated.length > 0, 'GENERATED_FILES parsed');
  assert.ok(fn, 'generator_for() present');
});

test('every land-local-check core file that is not core-repo data is generated and buildable', () => {
  const coreRepo = new Set(['shows.json', 'reviews.json']);
  for (const rel of CORE_DATA_FILES) {
    const name = path.basename(rel);
    if (coreRepo.has(name)) continue;
    assert.ok(generated.includes(name), `${name} is in GENERATED_FILES`);
    const gen = execFileSync('bash', ['-c', `${fn}\ngenerator_for "$1"`, '_', name], { encoding: 'utf8' }).trim();
    assert.ok(gen, `${name} has a generator_for() mapping`);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', gen)), `scripts/${gen} exists`);
  }
});
