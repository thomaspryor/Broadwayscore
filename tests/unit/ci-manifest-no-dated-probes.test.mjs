// TESTS-VS-DERIVED-DATA-EXEMPT: structural check of which test files CI runs; pins no data facts
/**
 * A test registered in a test.yml manifest runs on every code push and blocks
 * main. A dated RECHECK probe (skips until `Date.now() < Date.parse('<date>')`
 * stops holding, then asserts what a cron produced) must never be one: once
 * its date passes, a cron that under-delivered reds main for every unrelated
 * push. scripts/autonomous-acceptance-recheck.js runs those probes instead.
 * BRO-4837: scripts/verify-bro-4724-recheck.test.mjs sat in the node manifest
 * and turned main red at 2026-10-07 10:29Z over 9 tours missing schedule stops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// BRO-2483: manifestEntriesFor() resolves the node manifest path to the
// COLLECTED batch (scripts/lib/unit-test-collection.js); reading the tombstone
// file literally would make both checks below vacuous for the node batch.
const { manifestEntriesFor, MANIFEST_FILES } = require('../../scripts/lib/test-yml-manifest-paths.js');
const { EXEMPT_NEVER_CI } = require('../../scripts/audit-orphan-tests.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'tests/unit/ci-manifest-no-dated-probes.test.mjs'; // its pattern fixtures would match

// Either operand order, any quote style, a literal YYYY- date.
const DATED_GATE = /Date\.now\(\)\s*<=?\s*Date\.parse\(\s*['"`]\d{4}-|Date\.parse\(\s*['"`]\d{4}-[^)]*\)\s*>=?\s*Date\.now\(\)/;

function datedProbesIn(repoRoot) {
  const found = [];
  for (const rel of MANIFEST_FILES) {
    let entries;
    try { entries = manifestEntriesFor(repoRoot, rel); } catch (e) {
      // A fixture tree may lack a manifest; anything else (a broken collector)
      // must fail rather than let this check pass with nothing scanned.
      if (e && e.code === 'ENOENT') continue;
      throw e;
    }
    for (const entry of entries) {
      if (entry === SELF) continue;
      const file = path.join(repoRoot, entry);
      if (fs.existsSync(file) && DATED_GATE.test(fs.readFileSync(file, 'utf8'))) found.push(`${rel}: ${entry}`);
    }
  }
  return found;
}

test('no test.yml manifest registers a date-gated live-data probe', () => {
  assert.deepEqual(datedProbesIn(REPO), [],
    'move dated RECHECK probes out of the CI manifest; autonomous-acceptance-recheck.js runs them');
});

// The declared list of probes whose home is a scheduled recheck, not CI. Covers
// probes whose date gate this regex cannot see (a hoisted cutoff constant).
test('no test.yml manifest registers a file audit-orphan-tests.js declares never-CI', () => {
  const clash = [];
  for (const rel of MANIFEST_FILES) {
    let entries;
    try { entries = manifestEntriesFor(REPO, rel); } catch { continue; }
    for (const entry of entries) {
      // Older keys are bare names of scripts/*.test.mjs probes and shims;
      // tests/unit holds same-named real tests that CI is meant to run. Newer
      // keys (BRO-2778) are repo-relative paths and match exactly.
      const own = (k) => Object.prototype.hasOwnProperty.call(EXEMPT_NEVER_CI, k);
      if (own(entry) || (/^scripts\/[^/]+$/.test(entry) && own(path.basename(entry)))) clash.push(`${rel}: ${entry}`);
    }
  }
  assert.deepEqual(clash, []);
});

test('the node batch is actually scanned: the collected list is what the checks read (BRO-2483)', () => {
  const node = manifestEntriesFor(REPO, 'tests/unit-test-manifest.txt');
  assert.ok(node.length >= require('../../scripts/lib/unit-test-collection.js').MIN_NODE_BATCH, `expected the collected node batch, got ${node.length} entries`);
});

test('the gate pattern catches the probe shape in both operand orders, and not ordinary date math', () => {
  assert.ok(DATED_GATE.test("const PENDING = Date.now() < Date.parse('2026-10-07T09:00:00Z');"));
  assert.ok(DATED_GATE.test('if (Date.parse("2026-10-07") > Date.now()) skip();'));
  assert.ok(DATED_GATE.test("const PENDING = Date.now() <= Date.parse('2026-10-07');"));
  assert.ok(!DATED_GATE.test('const age = Date.now() - Date.parse(audit.generatedAt);'));
  assert.ok(!DATED_GATE.test('const FIX_LANDED_MS = Date.parse(\'2026-08-26T15:01:58Z\');'));
});
