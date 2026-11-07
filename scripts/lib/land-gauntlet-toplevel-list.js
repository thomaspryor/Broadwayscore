'use strict';
// scripts/lib/land-gauntlet-toplevel-list.js — the standalone
// `node scripts/test-*.js` regression steps test.yml's unit-tests job runs
// (BRO-5117), so land-gauntlet.sh's toplevel-regression gate runs the SAME list.
//
// WHY: the gauntlet claimed test.yml parity but never ran these steps, so two
// main reds landed through the gap (BRO-5079: test-opening-night-fixes.js after
// BRO-4884; BRO-5115: test-ordinal-publishdate-guards.js after BRO-5077). Same
// class as BRO-4150 (bash integration): a hand list instead of one derived from
// test.yml. Derived the same way as bash-integration-test-list.js, whose
// executableWorkflowText/stripShellComments this reuses (rule 15).
//
// Only a step whose whole command is `node scripts/test-<name>.js` (optional
// `timeout N` prefix) counts, so a path in an echo/comment never does.
const fs = require('fs');
const path = require('path');
const { stripShellComments } = require('./bash-integration-test-list.js');
const { extractRunBlocks } = require('../audit-orphan-tests.js');

const ROOT = path.join(__dirname, '..', '..');
const TEST_YML = path.join(ROOT, '.github', 'workflows', 'test.yml');

// Already run by another gauntlet gate (lint-workflows' audit loop).
const COVERED_ELSEWHERE = new Set(['scripts/test-data-write-guard.js']);

const STEP_RE = /^\s*(?:timeout\s+\d+[smh]?\s+)?node\s+(scripts\/test-[\w-]+\.js)\s*$/gm;

function listToplevelRegressionTests({ runText = null, testYmlPath = TEST_YML } = {}) {
  const text = runText != null ? runText : stripShellComments(extractRunBlocks(fs.readFileSync(testYmlPath, 'utf8')));
  const found = new Set();
  for (const m of text.matchAll(STEP_RE)) if (!COVERED_ELSEWHERE.has(m[1])) found.add(m[1]);
  return [...found].sort();
}

module.exports = { listToplevelRegressionTests, COVERED_ELSEWHERE };

if (require.main === module) {
  if (!process.argv.includes('--list')) { console.error('usage: land-gauntlet-toplevel-list.js --list'); process.exit(2); }
  const list = listToplevelRegressionTests();
  if (list.length === 0) { console.error('land-gauntlet-toplevel-list: derived ZERO node scripts/test-*.js steps from test.yml — broken matcher?'); process.exit(1); }
  for (const p of list) console.log(p);
}
