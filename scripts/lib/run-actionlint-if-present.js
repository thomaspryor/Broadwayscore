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
// it can't fix. Same flags AND same `[skip-actionlint]` commit-message escape
// hatch as that CI step (test.yml's "Lint workflow files" step) — without the
// hatch, an emergency hotfix CI would let through gets newly blocked locally
// (ship-check/Codex finding). Scope matches CI exactly: `.yml` only, not
// `.yaml` — CI's glob is `.github/workflows/*.yml` (test.yml:2409), so
// including `.yaml` here would block on a file CI itself never checks.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const has = spawnSync('command', ['-v', 'actionlint'], { shell: true });
if (has.status !== 0) {
  console.log('actionlint not on PATH — skipping (CI installs it in test.yml)');
  process.exit(0);
}

const log = spawnSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf8' });
if (log.status === 0 && log.stdout.includes('[skip-actionlint]')) {
  console.log('actionlint skipped via [skip-actionlint] commit-message tag (matches CI)');
  process.exit(0);
}

const workflowDir = path.join(process.cwd(), '.github', 'workflows');
if (!fs.existsSync(workflowDir)) process.exit(0);

const files = fs
  .readdirSync(workflowDir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => path.join('.github', 'workflows', f));
if (files.length === 0) process.exit(0);

const result = spawnSync(
  'actionlint',
  ['-color', '-shellcheck=', '-ignore', 'maximum number of inputs', ...files],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
