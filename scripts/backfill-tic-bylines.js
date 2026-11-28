#!/usr/bin/env node
/**
 * Re-attribute Chicago local reviews to the critic theatreinchicago.com names (BRO-6518).
 *
 * The 2026-10-31 audit found 476 of 1,764 Chicago local reviews under the wrong or no
 * critic: every Around the Town Chicago review landed as "Jacob Davis", every
 * PicksInSix review as "Ed Tracy", and Tribune / Third Coast / Fourth Walsh reviews
 * as "unknown", because ingest-urls reads the byline from the article page and these
 * sites carry no usable one. theatreinchicago.com lists the critic beside every
 * review link, so for shows it sourced (discoverySource 'theatreinchicago') its name
 * is the byline of record.
 *
 * Per review file whose URL theatreinchicago lists with a different critic:
 *   - No file at <outletId>--<criticSlug>.json → RENAME (set criticName, move).
 *   - File there, same review                  → DUPLICATE: keep the richer copy.
 *   - File there, different review             → CONFLICT: left alone, listed.
 *
 *   node scripts/backfill-tic-bylines.js [--apply] [--root=<review-texts>]
 *       [--shows=id,id | --recent-days=N] [--cache=<tic-cache.json>]
 *
 * Dry-run by default. --cache reads saved theatreinchicago pages ({showId: {reviewsPage}})
 * instead of fetching. Runs daily after tic-daily so new shows never keep a wrong byline.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { normalizeCritic, normalizeUrl } = require('./lib/review-normalization');
const { safeUnlinkReview } = require('./lib/review-write-guard');
const { sameReview, richness, renameOntoCritic } = require('./lib/byline-backfill');
const { planTicBylineFixes } = require('./lib/tic-bylines');
const { isSiteWideAuthorSource, isSiteWideAuthorAccount } = require('./lib/content-quality');

const USAGE = `backfill-tic-bylines.js — set Chicago local reviews' critic from theatreinchicago.com.

Usage:
  node scripts/backfill-tic-bylines.js [--apply] [--root=<dir>] [--shows=a,b | --recent-days=N] [--cache=<file>]
  node scripts/backfill-tic-bylines.js --help, -h    print this usage and exit
`;

const args = process.argv.slice(2);
const arg = (n) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : null; };
const APPLY = args.includes('--apply');
const ROOT = arg('root') || path.join('data', 'review-texts');

function selectShows() {
  const raw = JSON.parse(fs.readFileSync(path.join('data', 'shows.json'), 'utf8'));
  let shows = (Array.isArray(raw) ? raw : raw.shows).filter((s) => s.discoverySource === 'theatreinchicago');
  if (arg('shows')) { const want = new Set(arg('shows').split(',')); shows = shows.filter((s) => want.has(s.id)); }
  if (arg('recent-days')) {
    const cutoff = new Date(Date.now() - Number(arg('recent-days')) * 86400000).toISOString().slice(0, 10);
    shows = shows.filter((s) => (s.discoveredAt || '') >= cutoff);
  }
  return shows;
}

async function sourceReviews(show, cache) {
  if (cache) return (cache[show.id] && cache[show.id].reviewsPage && cache[show.id].reviewsPage.reviews) || null;
  const m = ((show.evidenceUrls || []).find((u) => /theatreinchicago/.test(u)) || '').match(/\/(\d+)\/?$/);
  if (!m) return null;
  const tic = require('./lib/theatreinchicago');
  const { fetchPage } = require('./lib/scraper');
  return tic.parseReviewsPage((await fetchPage(tic.reviewsUrl(m[1]), { skipVerify: true })).content, m[1]).reviews;
}

function readFiles(showDir) {
  if (!fs.existsSync(showDir)) return [];
  return fs.readdirSync(showDir).filter((f) => f.endsWith('.json')).map((basename) => {
    try { return { basename, data: JSON.parse(fs.readFileSync(path.join(showDir, basename), 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
}

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const cache = arg('cache') ? JSON.parse(fs.readFileSync(arg('cache'), 'utf8')) : null;
  const report = { renamed: [], duplicate: [], conflict: [], unmatched: 0, errors: [] };
  const shows = selectShows();
  for (const show of shows) {
    const showDir = path.join(ROOT, show.id);
    let src;
    try { src = await sourceReviews(show, cache); } catch (e) { report.errors.push({ showId: show.id, reason: 'source-fetch', error: e.message }); continue; }
    if (!src) continue;
    const files = readFiles(showDir);
    const { fixes, unmatched } = planTicBylineFixes(files, src, { normalizeCritic, normalizeUrl, isSiteWideAuthorSource, isSiteWideAuthorAccount });
    report.unmatched += unmatched;
    for (const fx of fixes) {
      const srcPath = path.join(showDir, fx.basename);
      const dstPath = path.join(showDir, fx.dstBasename);
      const item = { showId: show.id, from: fx.from, to: fx.critic, dstBasename: fx.dstBasename };
      if (!fs.existsSync(dstPath)) {
        report.renamed.push(item);
        if (APPLY) {
          const r = renameOntoCritic(srcPath, dstPath, fx.data, fx.critic, { source: 'theatreinchicago-byline', priorCritic: fx.from });
          if (!r.wrote) { report.renamed.pop(); report.errors.push({ ...item, reason: `rename-${r.skipped}` }); }
        }
        continue;
      }
      let sib;
      try { sib = JSON.parse(fs.readFileSync(dstPath, 'utf8')); } catch (e) { report.errors.push({ ...item, reason: 'sibling-unreadable' }); continue; }
      if (!sameReview(fx.data, sib)) { report.conflict.push({ ...item, url: fx.data.url, siblingUrl: sib.url }); continue; }
      const p = richness(fx.data), s = richness(sib);
      const ourRicher = (p.len > s.len + 200 && p.len > s.len * 1.10) || (p.scored && !s.scored && p.len >= s.len);
      report.duplicate.push({ ...item, kept: ourRicher ? 'misattributed-copy' : 'sibling' });
      if (!APPLY) continue;
      if (ourRicher) {
        const del = safeUnlinkReview(dstPath, { force: false });
        if (!del.wrote) { report.errors.push({ ...item, reason: `dup-sib-unlink-${del.skipped}` }); continue; }
        const r = renameOntoCritic(srcPath, dstPath, fx.data, fx.critic, { source: 'theatreinchicago-byline', priorCritic: fx.from });
        if (!r.wrote) report.errors.push({ ...item, reason: `dup-promote-${r.skipped}` });
      } else {
        const r = safeUnlinkReview(srcPath, { force: false });
        if (!r.wrote) report.errors.push({ ...item, reason: `dup-unlink-${r.skipped}` });
      }
    }
  }
  console.log(`tic byline backfill (root=${ROOT}, ${APPLY ? 'APPLY' : 'dry-run'}, shows=${shows.length})`);
  console.log(`  rename ${report.renamed.length}, duplicate ${report.duplicate.length}, conflict ${report.conflict.length}, errors ${report.errors.length}, files not on source ${report.unmatched}`);
  // Audit report only; review-texts writes go through safeRenameReview/safeUnlinkReview above.
  const reportPath = path.join('data', 'audit', 'tic-byline-backfill.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (!cache) await require('./lib/scraper').cleanup();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
