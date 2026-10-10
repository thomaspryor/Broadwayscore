// BRO-1711: destructive-risk scripts (fs deletes / saveShows / safeWriteReview)
// must carry the shared --help guard. Frozen-baseline ratchet: the baseline may
// not contain any destructive script, and no script may be a NEW violator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkFile, DESTRUCTIVE_CALL_RE, loadBaseline } = require('../audit-help-flag-safety.js');

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = loadBaseline();

test('baseline holds no destructive-risk script (fs delete / saveShows / safeWriteReview)', () => {
  const offenders = [...baseline].filter((f) =>
    DESTRUCTIVE_CALL_RE.test(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')),
  );
  assert.deepEqual(offenders, [], `add hasHelpFlag (scripts/lib/cli-help.js) to: ${offenders.join(', ')}`);
});

test('no script outside the baseline is a help-flag violator', () => {
  const violators = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'audit-help-flag-safety.js' && !baseline.has(f))
    .filter((f) => checkFile(f, fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')));
  assert.deepEqual(violators, []);
});

test('predicate catches an unguarded destructive script and passes a guarded one', () => {
  assert.ok(DESTRUCTIVE_CALL_RE.test("fs.rmSync(p, { recursive: true });"));
  assert.ok(checkFile('x.js', "const fs=require('fs');\nfs.rmSync('a');\n"));
  assert.equal(
    checkFile('y.js', "const fs=require('fs');\nconst { hasHelpFlag } = require('./lib/cli-help.js');\nif (hasHelpFlag(process.argv.slice(2))) { process.exit(0); }\nfs.rmSync('a');\n"),
    null,
  );
});

// Behavioural check (BRO-1711 review): text greps missed a guard sitting AFTER an
// earlier usage-exit. Actually run --help on the retrofitted scripts.
import { spawnSync } from 'node:child_process';
const RETROFITTED = [
  'discover-outlet-reviews-serp', 'fix-canonical-duplicate-backpointer', 'fix-duplicates-and-zeros',
  'fix-outlet-case', 'gather-reviews', 'health-check', 'ingest-review-from-url', 'recovery-marker',
  'rollback-reroute-backlog', 'scrape-london-box-office-roundups', 'scrape-theatre-reviews',
];
for (const name of RETROFITTED) {
  test(`${name}.js --help prints usage and exits 0`, () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, `${name}.js`), '--help'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /usage/i);
  });
}
