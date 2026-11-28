#!/usr/bin/env node
/**
 * BRO-8449: daily advisory check, included reviews whose url names another place.
 * Lists the ones no fresh content verdict has judged (queue for the weekly
 * `reverify-stale-cv-promoted.js --url-place`) and the ones a fresh "right production"
 * verdict contradicts. Acceptance: 0 unjudged.
 *
 * Usage: node scripts/audit-url-place-included.js [--strict] [--alert] [--counts=PATH] [--json=PATH]
 *   --strict  exit 1 when any unjudged hit remains
 *   --alert   file/refresh worker cards (audit-alert router); clears them when clean
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log('Usage:\n  node scripts/audit-url-place-included.js [--strict] [--alert] [--counts=PATH] [--json=PATH]');
  process.exit(0);
}
const { collectUrlPlaceHits, unjudged, contradicted, loadAcks } = require('./lib/url-place-included');
const root = path.join(__dirname, '..');
const R = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
const reviewTextsDir = path.join(root, 'data', 'review-texts');
// Missing input must never read as "clean" (it would resolve the worker cards): fail closed, no alert.
let showDirs = 0;
try { showDirs = fs.readdirSync(reviewTextsDir).length; } catch { showDirs = 0; }
if (showDirs < 10) {
  console.error(`audit-url-place-included: data/review-texts missing or near empty (${showDirs} show dirs); refusing to report or alert`);
  process.exit(3);
}
const hits = collectUrlPlaceHits({
  reviews: R.reviews || R, shows: S.shows || S,
  reviewTextsDir, acks: loadAcks(),
});
const out = { hits: hits.length, unjudged: unjudged(hits), contradicted: contradicted(hits), acked: hits.filter((h) => h.acked).length, flagged: hits.filter((h) => h.state === 'flagged').length };
console.log(`url-place included hits=${out.hits} unjudged=${out.unjudged.length} contradicted=${out.contradicted.length} acked=${out.acked} flaggedByVerifier=${out.flagged}`);
for (const h of [...out.unjudged, ...out.contradicted]) console.log(`  ${h.state} ${h.showId}/${h.file} (${h.place})`);
const arg = (n) => argv.find((a) => a.startsWith(`--${n}=`));
if (arg('counts')) fs.writeFileSync(arg('counts').split('=')[1], JSON.stringify({ generatedAt: new Date().toISOString(), hits: out.hits, unjudged: out.unjudged.length, contradicted: out.contradicted.length, acked: out.acked, flaggedByVerifier: out.flagged }, null, 2) + '\n');
if (arg('json')) fs.writeFileSync(arg('json').split('=')[1], JSON.stringify(out, null, 2));
(async () => {
  if (argv.includes('--alert')) {
    const { decideUrlPlaceAlerts } = require('./lib/url-place-included-alert');
    const { routeAuditDecisions } = require('./lib/audit-alert');
    await routeAuditDecisions(decideUrlPlaceAlerts(out), 'audit-url-place-included');
  }
  process.exitCode = argv.includes('--strict') && out.unjudged.length ? 1 : 0;
})().catch((err) => { console.error(`audit-url-place-included: alert step failed: ${err.stack || err.message}`); process.exitCode = 3; });
