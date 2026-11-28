'use strict';
/**
 * BRO-8056 phase 1b: the shows.json self-heals pre-deploy-check.js applies
 * before every build, as one pure function. pre-deploy-check.js calls it with
 * the real clock and the disk; the show-refresh publisher calls it with the
 * build's clock and the build's image set, so a refreshed page heals exactly
 * like a built one.
 *
 * No fs, no clock: everything comes in through `ctx`. Mutates `showsData` in
 * place (the same object loadShows() returned, so saveShows() can still merge)
 * and returns what it changed plus the log lines, in order, for the caller.
 *
 * @param {{shows: object[]}} showsData
 * @param {object} ctx
 * @param {string} ctx.today - YYYY-MM-DD.
 * @param {boolean} ctx.imagesPresent - false when the checkout has no image tree
 *   (then nothing reads as a missing file).
 * @param {(publicPath: string) => boolean} ctx.imageExists - e.g.
 *   p => fs.existsSync(path.join(publicDir, p)); paths look like
 *   /images/shows/<id>/hero.webp.
 * @param {object} ctx.imageSources - data/image-sources.json ({} if missing).
 * @param {Record<string, number>} ctx.reviewCountByShow - reviews.json count per showId.
 * @returns {{changed: boolean, counts: object, messages: Array<{level: 'ok'|'log', text: string}>, statusIssues: number}}
 */
const { writeClosingDate, canWriteClosingDate } = require('./closing-date-guard');
const { mayServeDiskImage } = require('./image-source-match');
const { isPhantomImagePath } = require('./show-images');
const { isWestEndVenue, isOffWestEndVenue, isLondonMarket } = require('./venue-classification');
const { findLondonDuplicatesToRemove } = require('./london-deploy-dedup');
const { classifyBadSynopsis } = require('./synopsis-validation');
const { clearSynopsis } = require('./synopsis-source');

const HEALABLE_SYNOPSIS = new Set(['refusal', 'placeholder', 'stale']);

function healShows(showsData, ctx) {
  const { today, imagesPresent, imageExists, imageSources = {}, reviewCountByShow } = ctx;
  // London dedup keeps the reviewed duplicate; an empty default would make every
  // count 0 and could delete the wrong row, so the caller must pass the counts.
  if (!reviewCountByShow || typeof reviewCountByShow !== 'object') throw new Error('healShows: reviewCountByShow is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) throw new Error(`healShows: today must be YYYY-MM-DD, got ${today}`);
  if (typeof imageExists !== 'function') throw new Error('healShows: imageExists is required');
  // undefined would silently turn every image heal into a no-op.
  if (typeof imagesPresent !== 'boolean') throw new Error('healShows: imagesPresent must be a boolean');
  const messages = [];
  const ok = (text) => messages.push({ level: 'ok', text });
  const log = (text) => messages.push({ level: 'log', text });
  let shows = showsData.shows;
  const showCount = shows.length;

  // 1. BRO-4099: closed show with a future closingDate -> clear the date
  // (unless a human locked it). See pre-deploy-check.js history.
  let statusIssues = 0;
  let statusDateHealed = 0;
  for (const show of shows) {
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      if (canWriteClosingDate(show)) {
        const staleDate = show.closingDate;
        writeClosingDate(show, null, `pre-deploy-check self-heal: cleared stale future closingDate on closed show (was ${staleDate})`, { todayStr: today });
        log(`   Self-healed "${show.title}" (${show.id}): cleared future closingDate ${staleDate} on closed show`);
        statusDateHealed++;
      } else {
        log(`⚠️  "${show.title}" (${show.id}) is marked closed but closingDate ${show.closingDate} is in the future (humanCorrectedClosingDate=true — needs manual review, not auto-healing; deploy proceeds)`);
        statusIssues++;
      }
    }
  }
  if (statusIssues === 0 && statusDateHealed === 0) {
    ok(`Show status/date integrity: ${showCount} shows checked, no contradictions`);
  } else if (statusDateHealed > 0) {
    ok(`Auto-healed ${statusDateHealed} show(s) with a status=closed/future-closingDate contradiction`);
  }

  // 2. Image refs: clear phantom paths, fill null refs from files that exist,
  // upgrade .jpg -> .webp when the .webp exists.
  let orphansFixed = 0;
  let jpgUpgraded = 0;
  let danglingRefsFixed = 0;
  const exists = (p) => imagesPresent && imageExists(p);
  for (const show of shows) {
    if (!show || !show.id) continue;
    const dirPath = `/images/shows/${show.id}`;
    let danglingFixed = false;
    for (const key of ['hero', 'poster', 'thumbnail']) {
      const val = show.images && show.images[key];
      if (imagesPresent && isPhantomImagePath(val, { exists: imageExists })) {
        show.images[key] = null;
        danglingFixed = true;
      }
    }
    if (danglingFixed) danglingRefsFixed++;
    const findImage = (name) => {
      if (!mayServeDiskImage(show, imageSources[show.id]?.[name])) return null;
      for (const ext of ['webp', 'jpg', 'png']) {
        if (exists(`${dirPath}/${name}.${ext}`)) return `${name}.${ext}`;
      }
      return null;
    };
    const heroFile = findImage('hero');
    const posterFile = findImage('poster');
    const thumbFile = findImage('thumbnail');
    if (!heroFile && !posterFile && !thumbFile) continue;

    if (!show.images) show.images = {};
    let fixed = false;
    if (!show.images.hero && heroFile) { show.images.hero = `${dirPath}/${heroFile}`; fixed = true; }
    if (!show.images.poster && posterFile) { show.images.poster = `${dirPath}/${posterFile}`; fixed = true; }
    if (!show.images.thumbnail && thumbFile) { show.images.thumbnail = `${dirPath}/${thumbFile}`; fixed = true; }
    for (const key of ['hero', 'poster', 'thumbnail']) {
      const val = show.images[key];
      if (val && typeof val === 'string' && val.endsWith('.jpg') && val.startsWith('/images/')) {
        if (exists(`${dirPath}/${key}.webp`)) {
          show.images[key] = val.replace(/\.jpg$/, '.webp');
          jpgUpgraded++;
          fixed = true;
        }
      }
    }
    if (fixed) orphansFixed++;
  }
  if (danglingRefsFixed > 0) ok(`Cleared image paths with no file behind them on ${danglingRefsFixed} shows`);
  if (orphansFixed > 0) ok(`Auto-fixed ${orphansFixed} shows with orphan/outdated image refs`);
  if (jpgUpgraded > 0) ok(`Upgraded ${jpgUpgraded} image paths from .jpg → .webp`);

  // 3. London venue vs category.
  let categoryFixed = 0;
  for (const show of shows) {
    if (!show.venue || show.venue === 'TBA' || !isLondonMarket(show.category)) continue;
    if (show.category === 'off-west-end' && isWestEndVenue(show.venue)) {
      show.category = 'west-end';
      categoryFixed++;
    } else if (show.category === 'west-end' && isOffWestEndVenue(show.venue)) {
      show.category = 'off-west-end';
      categoryFixed++;
    }
  }
  if (categoryFixed > 0) ok(`Auto-fixed ${categoryFixed} venue/category mismatches`);

  // 4. Same-production London duplicate rows with 0 reviews (BRO-275).
  const toRemove = findLondonDuplicatesToRemove(shows, reviewCountByShow);
  if (toRemove.size > 0) {
    showsData.shows = shows.filter(s => !toRemove.has(s.id));
    shows = showsData.shows;
    ok(`Auto-removed ${toRemove.size} duplicate London show(s): ${[...toRemove].join(', ')}`);
  }

  // 5. Clear-cut bad synopses (refusal / placeholder / stale).
  let refusalStripped = 0;
  for (const show of shows) {
    if (!show || typeof show.synopsis !== 'string') continue;
    const { bad, reason } = classifyBadSynopsis(show);
    if (bad && HEALABLE_SYNOPSIS.has(reason)) {
      log(`   Stripped ${reason} synopsis from "${show.title}" (${show.id})`);
      clearSynopsis(show, null);
      refusalStripped++;
    }
  }
  if (refusalStripped > 0) ok(`Auto-stripped ${refusalStripped} bad synopsis(es)`);

  const counts = { statusDateHealed, danglingRefsFixed, orphansFixed, jpgUpgraded, categoryFixed, londonDuplicatesRemoved: toRemove.size, refusalStripped };
  const changed = Object.values(counts).some(n => n > 0);
  return { changed, counts, messages, statusIssues, removedIds: [...toRemove] };
}

module.exports = { healShows };
