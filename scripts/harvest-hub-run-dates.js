#!/usr/bin/env node
'use strict';
/**
 * Keep city-hub regional closing dates current after extensions (BRO-7239, BRO-7291 class 1).
 *
 *   node scripts/harvest-hub-run-dates.js [--apply] [--listing] [--fetch] [--show=ID] [--out=data/audit/hub-run-dates.json]
 *
 * For every dated show on a launched hub it reads the stored review texts (data/review-texts/<show>/, excluded
 * files skipped); for shows running or closed in the last 21 days it also reads
 *   - with --listing, the run end on the listing site's own production page (theatreinchicago / theatreindc /
 *     theatreinla detail page from evidenceUrls, fetched through fetchPage()), the source the hand fixes used.
 *   - with --fetch, review URLs for shows that have no stored text yet (the BRO-7239 harvest path).
 * laterAnnouncedRunEnd (scripts/lib/run-end-from-text.js) picks an announced end LATER than ours; --apply writes it
 * through writeClosingDate, which records the extension. A human pin (humanCorrectedClosingDate) is only moved by
 * the listing page or an "extended through" sentence (an extension supersedes the hand fix, it does not contradict
 * it); a plain review-text date never overrides a pin and is reported instead.
 * Writes the report to --out. Wired into scrape-new-aggregators.yml (advisory).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { laterAnnouncedRunEnd } = require('./lib/run-end-from-text');
const { writeClosingDate, recordClosingExtension } = require('./lib/closing-date-guard');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#8211;|&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ');
const TIC_DETAIL = /^https?:\/\/(?:www\.)?theatrein(?:chicago|dc|la)\.com\/[^/]+\/\d+\/?$/i;
const EXCLUDED = (f) => f.wrongProduction || f.wrongShow || f.isRoundupArticle || f.isNonReview || f.duplicateOf;
const RECENT_CLOSED_DAYS = 21;

/** Every dated launched-hub show: stored review texts are checked for all of them (no network). */
function onHub(show, launchedCities) {
  return !!(show.localOnly && launchedCities.has(show.city) && show.openingDate);
}

/** Shows whose listing page is re-read (--listing): running, or closed in the last 21 days. */
function inScope(show, launchedCities, today) {
  if (!onHub(show, launchedCities)) return false;
  if (show.status === 'open' || show.status === 'previews') return true;
  if (show.status !== 'closed' || !show.closingDate) return false;
  const ago = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${show.closingDate}T00:00:00Z`)) / 86400000;
  return ago >= 0 && ago <= RECENT_CLOSED_DAYS;
}

/** Stored review texts for a show, as laterAnnouncedRunEnd evidence. */
function storedTexts(showId, dir = path.join(ROOT, 'data', 'review-texts')) {
  const d = path.join(dir, showId);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
    if (EXCLUDED(j) || !j.fullText) continue;
    out.push({ text: j.fullText, url: j.url || null, articleDate: /^\d{4}-\d{2}-\d{2}/.test(j.publishDate || '') ? j.publishDate.slice(0, 10) : null });
  }
  return out;
}

/**
 * Apply one decision to a show record (pure apart from mutating `show`). Returns what happened.
 * @returns {'written'|'pinned'|'unchanged'}
 */
function applyRunEnd(show, decision, todayStr, log = () => {}) {
  if (!decision) return 'unchanged';
  if (show.humanCorrectedClosingDate) {
    if (decision.kind === 'text') return 'pinned';
    // An extension past a hand-fixed date: record it, move the date, keep the pin on the new value.
    recordClosingExtension(show, decision.date, decision.source, todayStr);
    writeClosingDate(show, decision.date, decision.source, { force: true, recordExtension: false, todayStr, log });
  } else if (!writeClosingDate(show, decision.date, decision.source, {
    todayStr, log,
    // A later date announced after ours is an extension; a date read from review text that replaces an
    // unsourced/estimated one is a correction, and must not show as "Extended through" on the site.
    recordExtension: decision.kind !== 'text' && !!show.closingDateSource && !/estimat/i.test(String(show.closingDateSource)),
  })) {
    return 'pinned';
  }
  if (show.status === 'closed' && decision.date >= todayStr) show.status = 'open';
  return 'written';
}

async function main() {
  const today = arg('today', new Date().toISOString().slice(0, 10));
  const hubs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/city-hubs.json'), 'utf8')).hubs;
  const launched = new Set(Object.entries(hubs).filter(([, h]) => h.launched === true).map(([k]) => k));
  const { createShowsWriteGuard } = require('./lib/shows-write-guard');
  const { loadShows, saveShows } = createShowsWriteGuard(path.join(ROOT, 'data', 'shows.json'), { dryRun: !flag('apply') });
  const snapshot = loadShows();
  const only = arg('show', null);
  const shows = snapshot.shows.filter((s) => (only ? s.id === only : onHub(s, launched)));
  const net = flag('listing') || flag('fetch') ? require('./lib/scraper') : null;
  const tic = require('./lib/theatreinchicago');
  const report = { generatedAt: new Date().toISOString(), today, checked: shows.length, written: [], pinned: [], listings: {} };
  for (const s of shows) {
    const texts = storedTexts(s.id);
    let listing = null;
    const detail = (s.evidenceUrls || []).find((u) => TIC_DETAIL.test(u));
    if (flag('listing') && detail && (only || inScope(s, launched, today))) {
      try {
        const p = tic.parseDetailPage((await net.fetchPage(detail, { skipVerify: true })).content);
        if (p && p.closingDate) listing = { date: p.closingDate, url: detail };
        if (listing) report.listings[s.id] = listing;
      } catch (e) { console.log(`::warning::listing fetch failed for ${s.id}: ${e.message}`); }
    }
    if (flag('fetch') && !texts.length) {
      for (const url of (s.evidenceUrls || []).filter((u) => /^https?:/.test(u) && !TIC_DETAIL.test(u)).slice(0, 6)) {
        try { const p = await net.fetchPage(url, { skipVerify: true }); if (p && p.content) texts.push({ text: strip(p.content), url, articleDate: null }); } catch { /* skip */ }
      }
    }
    const decision = laterAnnouncedRunEnd({ opening: s.openingDate, closing: s.closingDate }, { texts, listing });
    if (!decision) continue;
    const from = s.closingDate || null;
    const what = applyRunEnd(s, decision, today, console.log);
    const row = { id: s.id, from, to: decision.date, kind: decision.kind, source: decision.source };
    (what === 'written' ? report.written : report.pinned).push(row);
    console.log(`${what.padEnd(8)} ${s.id} ${from} -> ${decision.date} [${decision.kind}]`);
  }
  if (flag('apply') && report.written.length) saveShows(snapshot);
  const outFile = path.resolve(ROOT, arg('out', 'data/audit/hub-run-dates.json'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n');
  console.log(`[hub-run-dates] checked ${report.checked}, ${flag('apply') ? 'wrote' : 'would write'} ${report.written.length}, pinned-text conflicts ${report.pinned.length}`);
  if (net) await net.cleanup();
}

module.exports = { onHub, inScope, storedTexts, applyRunEnd };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
