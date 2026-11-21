#!/usr/bin/env node
/**
 * Record the URLs of an ingest plan as dispatched (BRO-6854), so the daily pickup does not send them again.
 *
 *   node scripts/city-finder-mark-dispatched.js --city=san-diego --plan=<ingest plan json>
 *
 * Run only after scripts/dispatch-ingest-batch.js succeeded. Writes data/audit/city-finder-dispatched-<city>.json.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const city = arg('city');
const planFile = arg('plan');
if (!city || !planFile) { console.error('usage: city-finder-mark-dispatched.js --city=<key> --plan=<file>'); process.exit(2); }
const file = path.join(__dirname, '..', 'data', 'audit', `city-finder-dispatched-${city}.json`);
let urls = [];
try { urls = JSON.parse(fs.readFileSync(file, 'utf8')).urls || []; } catch { /* first run */ }
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const add = Object.values(plan).flat().map((e) => e.url);
const all = [...new Set([...urls, ...add])];
fs.writeFileSync(file, JSON.stringify({ urls: all }, null, 1) + '\n');
console.error(`${city}: ${add.length} URLs marked dispatched (${all.length} total)`);
