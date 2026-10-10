#!/usr/bin/env node
'use strict';

/**
 * check-model-drift.js — compare every commercial.json record's stored
 * recoupment model values with a fresh run of the same model (BRO-5004).
 * Read-only. Advisory: exits 0 unless --strict.
 *
 *   node scripts/check-model-drift.js [--json] [--strict]
 *
 * Kinds (scripts/lib/model-drift.js):
 *   same-day  stored today but a run on today's inputs differs: the run did
 *             not stick (lost in a push merge, or a later writer changed an
 *             input the same day). --strict fails on these.
 *   drift     inputs moved since the last run (a cost or capital edit, new
 *             grosses, a closing date) by 5+ points and 10%+.
 *   method    the stored tier differs from the one a run would use now.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { liveModelRun, modelDrift } = require('./lib/model-drift');

const args = process.argv.slice(2);
const USAGE = 'Usage: node scripts/check-model-drift.js [--json] [--strict]  (read-only; see header)';
if (require('./lib/cli-help').hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const JSON_OUT = args.includes('--json');
const STRICT = args.includes('--strict');

const DATA = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA, 'commercial.json'))
  ? path.join(DATA, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function main() {
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const commercial = load(COMMERCIAL_PATH).shows;
  const lookup = makeGrossesLookup(load(path.join(DATA, 'grosses.json')), load(path.join(DATA, 'grosses-history.json')));
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }
  const today = new Date().toISOString().split('T')[0];

  let checked = 0;
  const flagged = [];
  for (const [key, comm] of Object.entries(commercial)) {
    const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) continue;
    const fresh = liveModelRun(show, comm, lookup);
    if (!fresh.result) continue;
    checked++;
    const d = modelDrift(comm, fresh, today);
    if (d) flagged.push({ slug: key, ...d });
  }
  const count = (k) => flagged.filter((f) => f.kind === k).length;
  const summary = { checked, sameDay: count('same-day'), drift: count('drift'), method: count('method') };

  if (JSON_OUT) {
    console.log(JSON.stringify({ today, summary, flagged }, null, 2));
  } else {
    console.log(`Model drift: ${checked} modelled records; ${summary.sameDay} same-day, ${summary.drift} drift, ${summary.method} method`);
    for (const f of flagged) console.log(`  [${f.kind}] ${f.slug}: ${f.detail}`);
    if (flagged.length) console.log('Stored values refresh on the next merge-model-recoupment.js run.');
  }
  if (STRICT && summary.sameDay > 0) process.exit(1);
}

main();
