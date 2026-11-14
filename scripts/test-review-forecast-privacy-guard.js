#!/usr/bin/env node
// BRO-7382: card VERIFY entry point. Forecasts (v1, v2, v3) must never be in a public tracked file; the guard test fails if v3 leaks.
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv)) { console.log('usage: node scripts/test-review-forecast-privacy-guard.js (runs the forecast privacy guard and v3 unit tests)'); process.exit(0); }
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const r = spawnSync(process.execPath, ['--test', 'tests/unit/forecast-privacy-guard.test.mjs', 'tests/unit/review-forecast-v3-blend.test.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
