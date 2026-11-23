#!/usr/bin/env node
'use strict';
// BRO-8088 acceptance: venue agreement rules + verified venue data guards.
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const r = spawnSync(process.execPath, ['--test', 'scripts/lib/venue-info-agree.test.js', 'tests/unit/venue-info-data.test.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
