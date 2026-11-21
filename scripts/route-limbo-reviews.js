#!/usr/bin/env node
'use strict';
/**
 * route-limbo-reviews.js (BRO-7930): give every "limbo" review-text file a recorded route.
 * Limbo = usable text, no exclusion flag, no score, no decision (scripts/lib/limbo-gate.js). After the
 * grace window each one is routed to reject / scoring / refetch and stamped limboRoute.
 *
 *   node scripts/route-limbo-reviews.js [--apply] [--all-shows] [--days=760] [--show=ID] [--list] [--check]
 *
 * Dry run by default. --check exits 1 when any file past the grace window is still unrouted (the class guard:
 * run it after --apply, or alone in CI/health checks). Called by replay-pending-bylines.js sweeps with apply.
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
const { routeLimbo } = require('./lib/route-limbo');

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/route-limbo-reviews.js [--apply] [--all-shows] [--days=760] [--show=ID] [--list] [--check]\nRoutes every unflagged, unscored review file past the grace window to reject / scoring / refetch (BRO-7930). Dry run unless --apply.');
    process.exit(0);
  }
  const opt = n => (args.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const apply = args.includes('--apply');
  const r = routeLimbo({ apply, allShows: args.includes('--all-shows'), days: Number(opt('days')) || 760, only: opt('show') || null, log: console.log });
  if (args.includes('--list')) for (const x of r.rows) console.log(`${x.route}\t${x.rule}\t${x.showId}/${x.file}\t${(x.url || '').slice(0, 90)}`);
  console.log(`limbo gate${apply ? '' : ' [DRY RUN]'}: scanned ${r.counts.scanned}; past-grace limbo ${r.rows.length}${apply ? `; routed ${r.counts.routed}; write-failed/locked ${r.counts.writeFailed}` : ''}; within ${r.graceDays}d grace ${r.counts.grace}`);
  console.log(`  by route: ${JSON.stringify(r.counts.byRoute)}\n  by rule: ${JSON.stringify(r.counts.byRule)}`);
  if (args.includes('--check')) {
    // After --apply nothing past the grace window may be left unrouted.
    const left = apply ? r.counts.writeFailed : r.rows.length;
    if (left > 0) { console.error(`FAIL: ${left} limbo file(s) past the ${r.graceDays}-day grace window have no route`); process.exit(1); }
    console.log('OK: no unrouted limbo files');
  }
}
