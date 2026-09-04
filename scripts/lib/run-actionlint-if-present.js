#!/usr/bin/env node
'use strict';
//
// run-actionlint-if-present.js — thin wrapper so run-push-audits.sh's
// node-only run_audit() helper (which invokes `node "$script"`) can also
// gate on actionlint, a binary rather than a node script (BRO-2785).
//
// Skips (exit 0) when actionlint isn't on PATH: test.yml's "Lint Workflows"
// job installs it fresh every CI run, but a local checkout may not have it,
// and this push-time audit must not block on an unrelated environment gap
// it can't fix. Same flags as that CI step so the two never disagree.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const has = spawnSync('command', ['-v', 'actionlint'], { shell: true });
if (has.status !== 0) {
  console.log('actionlint not on PATH — skipping (CI installs it in test.yml)');
  process.exit(0);
}

const workflowDir = path.join(process.cwd(), '.github', 'workflows');
if (!fs.existsSync(workflowDir)) process.exit(0);

const files = fs
  .readdirSync(workflowDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => path.join('.github', 'workflows', f));
if (files.length === 0) process.exit(0);

const result = spawnSync(
  'actionlint',
  ['-color', '-shellcheck=', '-ignore', 'maximum number of inputs', ...files],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
