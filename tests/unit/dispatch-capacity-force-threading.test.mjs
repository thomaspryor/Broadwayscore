// tests/unit/dispatch-capacity-force-threading.test.mjs
//
// Task #1904, ship-check catch. The terminal-capacity preflight refuses a
// launch on a LEARNED number, and both CLIs print `--force` as the escape
// hatch from it — but neither actually PASSED force through to
// launchCmuxSession, so the advertised recovery path did nothing at all. The
// bug survived the whole reclaim suite because that suite calls
// launchCmuxSession directly with `force: true`, i.e. it tests the layer
// UNDERNEATH the one that was broken.
//
// These are deliberately WIRING assertions over the call sites rather than
// behavioral ones. A behavioral test would have to drive main() with every
// Notion/Linear/ledger dep stubbed, or call launchCmux() for real — which
// opens an actual cmux workspace. The thing that broke was an argument list,
// so the argument list is what this pins. Scoped as tightly as possible (a
// named call, a named property) so an unrelated reformat cannot break it,
// which is the #1432/#1434 fragile-pattern hazard this repo has paid for
// before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

test('bsc-next: the launchCmux wrapper forwards force into the launch options', () => {
  const src = read('scripts/bsc-next.js');
  const wrapper = /function launchCmux\(([^)]*)\)\s*\{[\s\S]*?\n\}/.exec(src);
  assert.ok(wrapper, 'could not locate bsc-next.js launchCmux()');
  assert.match(wrapper[1], /\bforce\b/,
    'launchCmux must accept force — the refusal message advertises --force as the way past the capacity gate');
  assert.match(wrapper[0], /launchCmuxSession\(\{[\s\S]*?\bforce\b/,
    'accepting force is not enough; it has to reach launchCmuxSession, which is exactly the step that was missing');
});

test('bsc-next: EVERY launchCmuxFn call site passes force', () => {
  // Both dispatch paths must forward it — the succession path especially, as
  // it has the least attempt budget to spare.
  const src = read('scripts/bsc-next.js');
  const callSites = src.match(/launchCmuxFn\([^)]*\)/g) || [];
  assert.equal(callSites.length >= 2, true,
    `expected the fresh-dispatch and succession paths to both call launchCmuxFn, found ${callSites.length}`);
  for (const site of callSites) {
    assert.match(site, /force/, `this call site drops force: ${site}`);
  }
});

test('linear-next: the cmux launch call forwards force', () => {
  const src = read('scripts/linear-next.js');
  const call = /const res = launchCmuxFn\(\{[\s\S]*?\n {2}\}\);/.exec(src);
  assert.ok(call, 'could not locate linear-next.js\'s launchCmuxFn call');
  assert.match(call[0], /force:\s*!!args\.force/,
    'without this the Linear lane has no way past a stale ceiling — its refusal message would advertise a flag that does nothing');
});

test('both CLIs journal a capacity refusal as launch-refused, never launch-failed', () => {
  // 'launch-failed' is in audit-archived-in-progress.js's START_EVENTS, so a
  // refusal that created nothing would make the card read "started then
  // lost" and route it into the wrong recovery bucket.
  const startEvents = read('scripts/audit-archived-in-progress.js');
  assert.match(startEvents, /START_EVENTS = new Set\(\[[\s\S]*?'launch-failed'/,
    'this test only means something while launch-failed is still a START_EVENT');
  assert.equal(/START_EVENTS = new Set\(\[[\s\S]*?'launch-refused'/.test(startEvents), false,
    'launch-refused must stay OUT of START_EVENTS — that is the whole point of the separate event');

  for (const cli of ['scripts/bsc-next.js', 'scripts/linear-next.js']) {
    const src = read(cli);
    const refusalBlocks = src.match(/refusedForCapacity: true/g) || [];
    assert.equal(refusalBlocks.length >= 1, true, `${cli} should journal at least one capacity refusal`);
    assert.match(src, /event: 'launch-refused'/, `${cli} must use the launch-refused event for capacity refusals`);
  }
});
