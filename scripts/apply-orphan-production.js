#!/usr/bin/env node
/**
 * BRO-7929: add a validated missing production and rehome its orphaned reviews.
 *
 *   node scripts/apply-orphan-production.js SPEC.json --add [--dry-run]
 *       Adds each spec's show entry as provisional:true (skips existing ids),
 *       so scripts/validate-show-venue.js --show=ID can cross-check it.
 *   node scripts/apply-orphan-production.js SPEC.json --finalize ID[,ID]
 *       Drops provisional once validation passed.
 *   node scripts/apply-orphan-production.js SPEC.json --rehome [--dry-run]
 *       Moves each orphaned wrongProduction review (same title, same market,
 *       dated inside the new show's window, text naming the venue) from its
 *       older same-title host dir onto the new show: flags cleared WITHOUT the
 *       blanket wrongProductionOverride (the new show's own guards still run),
 *       reroutedFrom/reroutedAt breadcrumbs left. Duplicate copies of the same
 *       review on other hosts are left in place (flagged, now covered by the
 *       new show so they stop counting as orphans).
 *
 * Writes go to the private core-data repo (SHOWS_FILE env overrides) and the
 * review-texts clone. Commit + push THOSE repos right after (dual-repo rule).
 * Spec: [{id,title,venue,previewsStartDate,openingDate,closingDate,type,isRevival,
 *         season,synopsis,evidenceUrls,venueNeedles:[...],market}]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const L = require('./lib/orphan-production-clusters');
const { sanitizeVenueForWrite } = require('./lib/venue-classification');

const ARGV = process.argv.slice(2);
const specPath = ARGV.find((a) => !a.startsWith('--'));
if (!specPath || ARGV.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(specPath ? 0 : 2);
}
const DRY = ARGV.includes('--dry-run');
const specs = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const SHOWS_FILE = process.env.SHOWS_FILE || path.join(os.homedir(), 'broadway-scorecard-data', 'shows.json');
const guard = createShowsWriteGuard(SHOWS_FILE);

function entryFrom(s) {
  const west = s.market === 'west-end';
  return {
    id: s.id,
    title: s.title,
    slug: s.id.replace(/-\d{4}$/, ''),
    venue: sanitizeVenueForWrite(s.venue),
    openingDate: s.openingDate,
    closingDate: s.closingDate || null,
    status: s.closingDate && s.closingDate < new Date().toISOString().slice(0, 10) ? 'closed' : 'open',
    type: s.type,
    isRevival: !!s.isRevival,
    runtime: null,
    intermissions: null,
    images: { thumbnail: null, poster: null, hero: null },
    synopsis: s.synopsis || null,
    ageRecommendation: null,
    previewsStartDate: s.previewsStartDate || null,
    tags: s.isRevival ? ['revival'] : [],
    theaterAddress: null,
    ticketLinks: [],
    cast: [],
    creativeTeam: [],
    category: west ? (s.category || 'off-west-end') : (s.category || 'off-broadway'),
    market: west ? 'west-end' : 'broadway',
    season: s.season || null,
    openingDateSource: s.openingDateSource || 'orphan-cluster-bro-7929',
    discoverySource: 'orphan-cluster-bro-7929',
    discoveredAt: new Date().toISOString(),
    evidenceUrls: s.evidenceUrls || [],
    provisional: true,
  };
}

if (ARGV.includes('--add')) {
  const data = guard.loadShows();
  let added = 0;
  for (const s of specs) {
    if (data.shows.some((x) => x.id === s.id)) { console.log(`exists: ${s.id}`); continue; }
    data.shows.push(entryFrom(s));
    added++;
    console.log(`add: ${s.id} (${s.venue}, ${s.openingDate}..${s.closingDate})`);
  }
  if (!DRY && added) guard.saveShows(data);
  console.log(`${DRY ? 'DRY ' : ''}added ${added}`);
}

const fin = ARGV.indexOf('--finalize');
if (fin >= 0) {
  const ids = new Set((ARGV[fin + 1] || '').split(',').filter(Boolean));
  const data = guard.loadShows();
  const done = new Set();
  for (const s of data.shows) if (ids.has(s.id) && s.provisional) { delete s.provisional; done.add(s.id); console.log(`finalized: ${s.id}`); }
  // A mistyped or already-final id must not pass silently (and must not rewrite shows.json for nothing).
  const missed = [...ids].filter((id) => !done.has(id));
  if (missed.length) console.error(`not finalized (absent or not provisional): ${missed.join(', ')}`);
  if (!done.size) process.exit(1);
  if (!DRY) guard.saveShows(data);
  if (missed.length) process.exit(1);
}

if (ARGV.includes('--rehome')) {
  const dir = resolveReviewTextsDir();
  const outletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
  const outlets = outletsRaw.outlets || outletsRaw;
  const shows = guard.loadShows().shows;
  const byTitle = L.indexShows(shows.filter((x) => !specs.some((s) => s.id === x.id)));
  const showById = new Map(shows.map((x) => [x.id, x]));
  const report = {};
  for (const s of specs) {
    const target = showById.get(s.id);
    if (!target) { console.error(`target missing from shows.json: ${s.id} (run --add)`); process.exit(1); }
    const tKey = L.normTitle(s.title);
    const lo = L.parseDate(s.previewsStartDate || s.openingDate) - L.COVER_SLACK_DAYS * L.DAY;
    const hi = (L.parseDate(s.closingDate) || Date.now()) + L.COVER_SLACK_DAYS * L.DAY;
    if (Number.isNaN(lo) || Number.isNaN(hi)) { console.error(`${s.id}: spec has no usable openingDate/previewsStartDate; refusing to rehome`); process.exit(1); }
    const needles = (s.venueNeedles && s.venueNeedles.length ? s.venueNeedles : [s.venue]).map((n) => n.toLowerCase());
    const seen = new Set();
    let moved = 0, dupeLeft = 0, rejected = 0;
    if (!DRY) fs.mkdirSync(path.join(dir, s.id), { recursive: true });
    for (const host of listShowDirs(dir, { silent: true, skipHolding: true })) {
      const hs = showById.get(host);
      if (!hs || host === s.id || L.normTitle(hs.title) !== tKey) continue;
      for (const f of fs.readdirSync(path.join(dir, host)).filter((x) => x.endsWith('.json'))) {
        const p = path.join(dir, host, f);
        let j; try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        if (!j.wrongProduction || j.wrongShow || j.duplicateOf) continue;
        const ms = L.reviewDateMs(j);
        if (!ms || ms < lo || ms > hi) continue;
        if (L.isCrossMarketNote(j)) continue; // tour / fringe / cross-market: not this run
        if (L.isCovered(byTitle, tKey, ms, Date.now())) continue; // another existing production owns this date
        // Corroboration: a UK-region outlet, a dual-market outlet, or text naming the venue.
        // (Date window + same title + no other same-title show covering it is already the orphan definition.)
        const hay = `${j.fullText || ''} ${j.excerpt || ''}`.toLowerCase();
        const o = outlets[j.outletId] || {};
        const ok = L.reviewMarket(j, outlets) === s.market || o.isDualMarket || needles.some((n) => hay.includes(n));
        if (!ok) { rejected++; continue; }
        const key = `${f}|${ms}`;
        if (seen.has(key)) { dupeLeft++; continue; }
        seen.add(key);
        const dest = path.join(dir, s.id, f);
        if (fs.existsSync(dest)) { dupeLeft++; continue; }
        const d = { ...j };
        clearWrongProductionFlags(d, { source: 'apply-orphan-production.js', reason: `BRO-7929 rehomed to ${s.id}`, noOverrideStamp: true });
        d.reroutedFrom = host;
        d.reroutedAt = new Date().toISOString();
        d.showId = s.id;
        d.showTitle = s.title;
        if (!DRY) {
          fs.writeFileSync(dest, JSON.stringify(d, null, 2) + '\n');
          fs.unlinkSync(p);
        }
        moved++;
      }
    }
    report[s.id] = { moved, dupeLeft, rejected };
    console.log(`${DRY ? 'DRY ' : ''}${s.id}: moved=${moved} duplicatesLeftOnHosts=${dupeLeft} rejected(market/venue)=${rejected}`);
  }
}
