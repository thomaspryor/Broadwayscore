#!/usr/bin/env node
'use strict';
/** BRO-6516 CLI: Guardian hub list -> add-show actions. Logic: scripts/lib/uk-regional-add-plan.js. */
const fs = require('fs');
const path = require('path');
const { buildAction } = require('./lib/uk-regional-add-plan');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const LIST = path.join(ROOT, 'data', 'audit', 'uk-regional', 'production-list.json');

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-add-plan.js [--hub=<hub>] [--urls=<guardianUrl>,...] [--limit=N] [--list=<file>] [--out=<actions.json>]');
    return;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;
  const rows = JSON.parse(fs.readFileSync(arg('list') || LIST, 'utf8'));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(data) ? data : data.shows;
  const hub = arg('hub');
  const ids = arg('urls') ? new Set(arg('urls').split(',')) : null;
  const limit = Number(arg('limit')) || Infinity;
  const actions = [];
  const skipped = [];
  for (const row of rows) {
    if (actions.length >= limit) break;
    if (hub && row.hub !== hub) continue;
    if (ids && !ids.has(row.guardianUrl)) continue;
    const r = buildAction(row, shows);
    if (r.action) {
      actions.push(r.action);
      shows.push(r.action.show);
    } else skipped.push(`${row.title} @ ${row.venue}: ${r.skip}`);
  }
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(actions, null, 2) + '\n');
  console.log(`${actions.length} add-show action(s)${out ? ` -> ${out}` : ''}; ${skipped.length} skipped`);
  for (const a of actions) console.log(`  + ${a.show.id} | ${a.show.venue} | ${a.show.status} ${a.show.openingDate}`);
  for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
}

if (require.main === module) main();
