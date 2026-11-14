#!/usr/bin/env node
/**
 * tb-collector-kick.js — dispatch collect-talkinbroadway-index.yml when an in-window show
 * has a Talkin' Broadway review stuck in _pending/ (BRO-7442). Logic: scripts/lib/tb-collector-kick.js.
 *
 *   node scripts/tb-collector-kick.js --shows=a,b [--root=data/review-texts] [--dry-run]
 * Needs GH_TOKEN with actions: write. Best-effort: exits 0 on any failure (the daily run is the backstop).
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { COLLECTOR_WORKFLOW, findStuckTbStubs, decideKick } = require('./lib/tb-collector-kick');

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ''; };
const dry = process.argv.includes('--dry-run');
const shows = arg('shows').split(',').map((s) => s.trim()).filter(Boolean);
const root = arg('root') || path.join(__dirname, '..', 'data', 'review-texts');

function main() {
  const stuck = findStuckTbStubs(root, shows);
  if (stuck.length === 0) { console.log('tb-collector-kick: no stuck Talkin Broadway stub'); return; }
  for (const s of stuck) console.log(`  stuck: ${s.showId}/${s.file} ${s.url || ''}`);
  let runs = [];
  try {
    runs = JSON.parse(execFileSync('gh', ['run', 'list', `--workflow=${COLLECTOR_WORKFLOW}`, '--limit', '15', '--json', 'status,createdAt'], { encoding: 'utf8', timeout: 60000 }));
  } catch (e) { console.log(`tb-collector-kick: could not list collector runs (${String(e.message).split('\n')[0]}); not dispatching`); return; }
  const d = decideKick({ stuck, runs });
  console.log(`tb-collector-kick: ${d.kick ? 'DISPATCH' : 'skip'}: ${d.reason}`);
  if (!d.kick || dry) return;
  try {
    execFileSync('gh', ['workflow', 'run', COLLECTOR_WORKFLOW], { encoding: 'utf8', timeout: 60000 });
    console.log('tb-collector-kick: dispatched collect-talkinbroadway-index.yml');
  } catch (e) { console.log(`::warning::Talkin Broadway collector dispatch failed: ${String(e.message).split('\n')[0]}`); }
}
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/tb-collector-kick.js --shows=a,b [--root=data/review-texts] [--dry-run]');
  process.exit(0);
}
try { main(); } catch (e) { console.log(`::warning::tb-collector-kick failed: ${e.message}`); }
