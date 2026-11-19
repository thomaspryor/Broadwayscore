#!/usr/bin/env node
/**
 * Runs the reader-feedback proposal email tests (BRO-7847): the four-section
 * owner email, the thread helper, the cap, the kill switch and the planner's
 * already-fixed checks, against real catalog data. Exit 0 = pass.
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const r = spawnSync(process.execPath, ['--test', 'tests/unit/feedback-proposal-email.test.mjs', 'tests/unit/api-feedback.test.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
