#!/usr/bin/env node
/**
 * BRO-6211: advisory audit. Every outlet cited by >=10 shows in data/commercial.json
 * must be a host the recoupment poller watches (TRACK_RECOUPMENT_FEEDS) or sit in
 * EXEMPT_HOSTS with a reason. Exit 0 covered, 1 gap or stale exemption, 2 data missing.
 * Run by check-corpus-drift.js (advisory by construction).
 *
 *   node scripts/audit-commercial-source-coverage.js [--json]
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { TRACK_RECOUPMENT_FEEDS } = require('./lib/rss-discovery');
const { MAIN_REPO_ROOT } = require('./lib/repo-root');
const cov = require('./lib/commercial-source-coverage');

function commercialPath() {
  const local = path.join(__dirname, '..', 'data', 'commercial.json');
  if (fs.existsSync(local)) return local;
  return path.join(MAIN_REPO_ROOT, 'data', 'commercial.json');
}

function run() {
  const p = commercialPath();
  if (!fs.existsSync(p)) { console.error(`commercial.json not found at ${p}`); return 2; }
  const shows = JSON.parse(fs.readFileSync(p, 'utf8')).shows || {};
  const counts = cov.countCitedHosts(shows);
  const tracked = cov.trackedHosts(TRACK_RECOUPMENT_FEEDS);
  const res = cov.evaluateCoverage(counts, tracked, cov.EXEMPT_HOSTS);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ tracked: [...tracked], ...res }, null, 2));
  } else {
    console.log(`Tracked recoupment hosts: ${[...tracked].sort().join(', ')}`);
    for (const u of res.uncovered) console.log(`GAP: ${u.host} cited by ${u.shows} shows, not tracked and not exempt. Add a feed to BROADWAY_BUSINESS_FEEDS in scripts/lib/rss-discovery.js or an EXEMPT_HOSTS reason in scripts/lib/commercial-source-coverage.js.`);
    for (const w of res.warnings) console.log(`WARN: ${w.host} cited by ${w.shows} shows (fails at ${cov.FAIL_AT_SHOWS}).`);
    for (const h of res.staleExemptions) console.log(`STALE: exemption for ${h} is no longer needed (not cited, or now tracked).`);
    for (const h of res.emptyReasons) console.log(`NO-REASON: exemption for ${h} has no reason.`);
    console.log(`${counts.size} cited hosts; ${res.uncovered.length} gaps, ${res.warnings.length} warnings, ${res.staleExemptions.length} stale exemptions.`);
  }
  return res.uncovered.length || res.staleExemptions.length || res.emptyReasons.length ? 1 : 0;
}

if (require.main === module) process.exit(run());
module.exports = { run };
