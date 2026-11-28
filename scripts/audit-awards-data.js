#!/usr/bin/env node
/**
 * Comprehensive advisory awards audit. Usage:
 *   node scripts/audit-awards-data.js [--verbose]
 * Writes data/audit/awards-data-audit.json. Findings do not change the exit code.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { auditAwardsData } = require('./lib/awards-data-audit');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'audit', 'awards-data-audit.json');

function readData(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (error) {
    console.error(`ERROR: Could not load ${name}: ${error.message}`);
    process.exit(1);
  }
}

const report = auditAwardsData(readData('awards.json'), readData('shows.json'), {
  verbose: process.argv.includes('--verbose'),
  log: console.log,
  confirmedTies: readData('awards-confirmed-ties.json').ties,
});
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
console.log(`\nReport written to: ${OUTPUT_FILE}`);
