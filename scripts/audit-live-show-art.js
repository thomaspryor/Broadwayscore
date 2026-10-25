#!/usr/bin/env node
// venue-write-guard-ok: venue is read from shows.json and passed to the vision verifier and the report row; nothing here writes shows.json
/**
 * audit-live-show-art.js (BRO-5744)
 *
 * Vision sweep of the thumbnail actually served for every live show
 * (open / previews / upcoming / announced). Reports art that shows another
 * work (wrong_show), a non-theatre work, or a generic image. ADVISORY ONLY:
 * it never nulls or deletes art (the pre-deploy orphan auto-fix would re-attach
 * the file anyway; a human or an approved-fix plan removes it).
 *
 * Usage:
 *   node scripts/audit-live-show-art.js                  # all live shows, 4 workers
 *   node scripts/audit-live-show-art.js --show=ID        # one show
 *   node scripts/audit-live-show-art.js --limit=N        # first N shows (smoke test)
 *   node scripts/audit-live-show-art.js --workers=N --no-write --no-alert
 *
 * Flagged rows fold into ONE rollup alert card (stable key, 7-day cooldown).
 *
 * Output: tmp/live-art-audit.json (needs GEMINI_API_KEY).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-live-show-art.js — vision sweep of live show thumbnails (advisory).

Usage:
  node scripts/audit-live-show-art.js [--show=ID] [--limit=N] [--workers=N] [--rpm=N] [--no-write] [--no-alert]
  node scripts/audit-live-show-art.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv)) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { verifyImage, createRateLimiter, creativesForVerify, resolveMarketSlug } = require('./lib/verify-image');
const { selectLiveShows, classifyResult, buildReport, buildLiveArtAlert, LIVE_ART_ALERT_KEY } =require('./lib/live-art-audit');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'tmp', 'live-art-audit.json');
const arg = (name) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function auditShow(show, rateLimiter) {
  const rel = show.images.thumbnail.replace(/^\//, '');
  const file = path.join(ROOT, 'public', rel.replace(/^public\//, ''));
  if (!fs.existsSync(file)) {
    return { id: show.id, title: show.title, errored: true, kind: 'error', description: `thumbnail file missing: ${show.images.thumbnail}` };
  }
  const result = await verifyImage(fs.readFileSync(file), show.title, {
    year: show.openingDate ? show.openingDate.slice(0, 4) : undefined,
    openingDate: show.openingDate,
    closingDate: show.status === 'closed' ? show.closingDate || null : null,
    market: resolveMarketSlug(show.category, show.market),
    venue: show.venue,
    creatives: creativesForVerify(show),
    mimeType: mimeFor(file),
    rateLimiter,
  });
  const cls = classifyResult(result);
  if (!cls) return null;
  return {
    id: show.id, title: show.title, status: show.status, venue: show.venue,
    thumbnail: show.images.thumbnail,
    kind: cls.kind, errored: cls.errored,
    confidence: result.confidence, imageType: result.imageType,
    issues: result.issues, description: result.description,
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set; nothing audited.');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  let shows = selectLiveShows(Array.isArray(raw) ? raw : raw.shows, { showId: arg('show') });
  if (arg('limit')) {
    const n = parseInt(arg('limit'), 10);
    if (!(n > 0)) { console.error('--limit needs a positive number'); process.exit(2); }
    shows = shows.slice(0, n);
  }
  const workers = Math.max(1, parseInt(arg('workers') || '4', 10));
  const rateLimiter = createRateLimiter(parseInt(arg('rpm') || '60', 10));
  console.log(`Auditing ${shows.length} live thumbnails with ${workers} workers...`);

  const rows = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < shows.length) {
      const show = shows[next++];
      try {
        const row = await auditShow(show, rateLimiter);
        if (row) rows.push(row);
      } catch (err) {
        rows.push({ id: show.id, title: show.title, errored: true, kind: 'error', description: err.message });
      }
      if (++done % 50 === 0) console.log(`  ${done}/${shows.length}`);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));

  rows.sort((a, b) => a.id.localeCompare(b.id));
  const report = buildReport(rows, { totalChecked: shows.length });
  console.log(`Checked ${report.totalChecked}: flagged ${report.flaggedCount} ${JSON.stringify(report.byKind)}, errors ${report.errorCount}`);
  for (const r of report.flagged.slice(0, 40)) console.log(`  ${r.kind.padEnd(16)} ${r.id}: ${String(r.description).slice(0, 90)}`);

  if (!process.argv.includes('--no-write')) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`);
  }
  // One rollup card per week (stable key); nothing is nulled or blocked.
  // A --show/--limit run is a partial sample: it must not rewrite or resolve the weekly card.
  const partial = Boolean(arg('show') || arg('limit'));
  if (!process.argv.includes('--no-alert') && !partial) {
    const { routeAlert, resolveQuietConditions } = require('./lib/owner-alert-router.js');
    const { syncRollup, snapshotRollupMembers } = require('./lib/rollup-alert');
    try {
      const opts = buildLiveArtAlert(report.flagged);
      if (!opts) {
        resolveQuietConditions([LIVE_ART_ALERT_KEY], { quietHours: 48, reason: 'no live show art flagged' });
      } else {
        const priorMembers = snapshotRollupMembers(LIVE_ART_ALERT_KEY);
        const routed = await routeAlert(opts);
        await syncRollup({
          priorMembers, key: LIVE_ART_ALERT_KEY, items: report.flagged, itemId: (r) => r.id,
          itemBlock: (r) => `- ${r.title || r.id} (${r.id}) [${r.kind}]`,
          header: (added) => `More live shows flagged (${added.length} new):`,
        }, routed);
      }
    } catch (err) {
      console.error(`routeAlert (${LIVE_ART_ALERT_KEY}) failed: ${err.message}`);
    }
  }
  // Advisory: a flagged row never fails the run. Only a run where most checks errored does.
  if (shows.length > 0 && report.errorCount * 2 > shows.length) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
