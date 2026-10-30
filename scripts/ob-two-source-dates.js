#!/usr/bin/env node
'use strict';
/**
 * ob-two-source-dates.js (BRO-6630): date pre-2020 Off-Broadway census
 * candidates that have no Playbill production page, by the owner's two-source
 * rule (BRO-6496 option B, docs/specs/ob-historical-backfill-v2.md, pre-COVID
 * trial): BroadwayWorld's show page plus TheaterMania's OB listing.
 *
 * READ-ONLY. Never writes shows.json or a plan. Prints a per-candidate verdict
 * and the add-show actions between ACTIONS_BEGIN / ACTIONS_END, like
 * plan-ob-historical-cohort.js, for buildPlans (new-fix-plan.js).
 *
 * Rule (decideTwoSource below), with the BRO-6496 fact-check prevention:
 *   - closing: BroadwayWorld and TheaterMania within a day;
 *   - opening: a second source too. TheaterMania's opening within a day of
 *     BroadwayWorld's, or (TM often stores the first preview there, BRO-6470)
 *     TM's date equal to BroadwayWorld's first preview while BroadwayWorld's
 *     opening is a later date;
 *   - opening equal to BroadwayWorld's first preview is refused unless
 *     TheaterMania also lists a matching preview date before it;
 *   - opening within -3..+7 days of the earliest dated critic write-up (BRO-6496
 *     allowed +30, which let a pre-announced opening that later moved through);
 *   - both venues name the same house (venuesMatch);
 *   - run of 14+ days, closed 90+ days ago, run starts and opens in the window.
 *
 * Usage:
 *   node scripts/ob-two-source-dates.js --candidates=PATH --from=YYYY-MM-DD --to=YYYY-MM-DD
 *     [--limit=N] [--skip-titles=PATH] [--today=YYYY-MM-DD]
 *   PATH is ob-census-candidates.js output. --skip-titles is a JSON array of
 *   titles already promoted by Playbill (plan-ob-historical-cohort.js).
 * Needs scraper keys (SERP + fetchPage): run locally with them, or via
 * cloud-run-script.js.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const DAY_MS = 86400 * 1000;
// Critics publish on opening night in this era; a later first write-up means the listed opening moved.
const MAX_REVIEW_LAG_DAYS = 7;
const USAGE = 'Usage: node scripts/ob-two-source-dates.js --candidates=PATH --from=YYYY-MM-DD --to=YYYY-MM-DD [--limit=N] [--skip-titles=PATH] [--today=YYYY-MM-DD]';

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function arg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

/** "October 22, 2019" → "2019-10-22"; null when it does not parse. */
function parseLongDate(s) {
  const m = String(s || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  // Full names (BroadwayWorld) or abbreviations such as "Mar" / "Sept" (Broadway.com).
  const word = m && m[1].toLowerCase();
  const month = word && word.length >= 3 && Object.keys(MONTHS).find((k) => k.startsWith(word.replace(/\.$/, '')));
  if (!month) return null;
  return `${m[3]}-${String(MONTHS[month]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const decodeEntities = (s) => String(s || '').replace(/&#x27;|&#39;|&#039;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

/**
 * Broadway.com show page (/shows/<slug>/) → { title, venue, previews, opening, closing }.
 * Dates come from the "Show Dates" block ("Previews: Mar 27, 2018 • Opening: ...");
 * the venue from the meta description ("Get official tickets to X at the <venue> from ...").
 */
function parseBroadwayComPage(html) {
  const h = String(html || '');
  const title = decodeEntities((h.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]).trim() || null;
  const venue = decodeEntities((h.match(/<meta name="description" content="[^"]*? at (?:the )?(.+?) from the trusted/) || [])[1]).trim() || null;
  const block = (h.match(/spec-name">\s*Show Dates\s*<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const pick = (label) => { const m = text.match(new RegExp(`${label}:\\s*([A-Za-z.]+ \\d{1,2}, \\d{4})`)); return m ? parseLongDate(m[1]) : null; };
  return { title, venue, previews: pick('Previews'), opening: pick('Opening'), closing: pick('Closing') };
}

/** Broadway.com slugs are the lowercased title with apostrophes dropped and other punctuation hyphenated. */
const broadwayComSlug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * BroadwayWorld show page → { name, venue, previews, opening, closing, market }.
 * Dates come from the visible meta block (Previews / Opened / Closing); the
 * venue and name from the TheaterEvent JSON-LD.
 */
function parseBwwShowPage(html) {
  const text = String(html || '');
  const out = { name: null, venue: null, previews: null, opening: null, closing: null, offBroadway: false };
  for (const m of text.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    if (d && d['@type'] === 'TheaterEvent') {
      out.name = d.name || null;
      out.venue = (d.location && d.location.name) || null;
      out.offBroadway = /off-broadway/i.test(d.name || '');
    }
  }
  const flat = text.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/(\s*\|\s*)+/g, '|');
  const field = (label) => {
    const m = flat.match(new RegExp(`\\|${label}:?\\s*\\|([A-Z][a-z]+ \\d{1,2}, \\d{4})\\|`));
    return m ? parseLongDate(m[1]) : null;
  };
  out.previews = field('Previews');
  out.opening = field('Opened') || field('Opening');
  out.closing = field('Closing') || field('Closed');
  if (/\|Off-Broadway\|/.test(flat)) out.offBroadway = true;
  return out;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const near = (a, b, tol = 1) => !!a && !!b && Math.abs(daysBetween(a, b)) <= tol;

/**
 * The two-source verdict for one candidate.
 * @param {{bww: object, tm: object, firstReview: string, fromIso: string, toIso: string, todayIso: string, venuesMatch?: Function}} p
 * @returns {{ok: boolean, reason: string, dates?: object}}
 */
function decideTwoSource({ bww, tm, firstReview, fromIso, toIso, todayIso, venuesMatch = venuesAgree }) {
  if (!bww || !bww.opening || !bww.closing) return { ok: false, reason: 'BroadwayWorld opening or closing missing' };
  if (!tm) return { ok: false, reason: 'no TheaterMania or Broadway.com listing' };
  if (!near(bww.closing, tm.closingDate)) return { ok: false, reason: `closing disagrees (BWW ${bww.closing}, TM ${tm.closingDate || '-'})` };
  const tmDates = [tm.openingDate, tm.previewsStartDate].filter(Boolean);
  const openingSecond = tmDates.some((d) => near(d, bww.opening));
  const previewSecond = !!bww.previews && bww.previews < bww.opening && tmDates.some((d) => near(d, bww.previews));
  if (!openingSecond && !previewSecond) return { ok: false, reason: `opening has no second source (BWW ${bww.previews || '-'}/${bww.opening}, TM ${tmDates.join('/') || '-'})` };
  if (bww.previews && bww.previews === bww.opening) {
    const tmEarlier = tmDates.some((d) => daysBetween(d, bww.opening) >= 3);
    if (tmEarlier) return { ok: false, reason: `BWW opening equals its first preview (${bww.opening}) and TM lists an earlier date` };
  }
  if (firstReview) {
    const lag = daysBetween(bww.opening, firstReview);
    if (lag < -3 || lag > MAX_REVIEW_LAG_DAYS) return { ok: false, reason: `opening ${bww.opening} is ${lag} days from the first write-up ${firstReview}` };
  }
  if (!bww.venue || !tm.venue || !venuesMatch(bww.venue, tm.venue)) return { ok: false, reason: `venues disagree (BWW "${bww.venue || '-'}", TM "${tm.venue || '-'}")` };
  const start = bww.previews && bww.previews < bww.opening ? bww.previews : bww.opening;
  if (start < fromIso || start > toIso) return { ok: false, reason: `run starts ${start}, outside ${fromIso}..${toIso}` };
  // Seasons are counted by opening night, so a run previewing late in the window but opening after it belongs to the next season.
  if (bww.opening > toIso) return { ok: false, reason: `opens ${bww.opening}, after ${toIso}` };
  if (daysBetween(start, bww.closing) < 14) return { ok: false, reason: 'run shorter than 14 days' };
  if (daysBetween(bww.closing, todayIso) <= 90) return { ok: false, reason: 'closed 90 days ago or less' };
  return { ok: true, reason: 'two-source', dates: { previewsStartDate: start < bww.opening ? start : null, openingDate: bww.opening, closingDate: bww.closing } };
}

// Words every venue name shares; what is left names the house (or its company).
const VENUE_STOP = new Set(['the', 'theater', 'theatre', 'theaters', 'theatres', 'stage', 'stages', 'at', 'new', 'york', 'nyc', 'company', 'center', 'centre', 'space', 'studio', 'upstairs', 'downstairs', 'off', 'broadway', 'playhouse', 'hall', 'room', 'arts', 'and', 'of', 'i', 'ii', 'iii', '1', '2', '3']);
const venueTokens = (v) => new Set(String(v || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !VENUE_STOP.has(w)));

/**
 * Do two listings name the same house? venuesMatch (deduplication.js) or
 * canonicalVenue (title-match.js) first; else a shared distinctive word
 * ("City Center Stage 1" vs "New York City Center - Stage I").
 */
function venuesAgree(a, b) {
  if (!a || !b) return false;
  const { venuesMatch } = require('./lib/deduplication');
  const { canonicalVenue } = require('./lib/title-match');
  if (venuesMatch(a, b) || canonicalVenue(a) === canonicalVenue(b)) return true;
  const tb = venueTokens(b);
  return [...venueTokens(a)].some((w) => tb.has(w));
}

const titleKey = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');

/**
 * BroadwayWorld's yearly Off-Broadway index (browseshows.php?showtype=OF&open_yr=YYYY)
 * → [{ title, url, date, venue }]. Used to find a title's show page without a SERP call.
 */
function parseBwwBrowsePage(html) {
  const out = [];
  const decode = (t) => String(t || '').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  for (const m of String(html || '').matchAll(/<article class="browse-shows-show-list__item"[\s\S]*?<\/article>/g)) {
    const a = m[0].match(/class="browse-shows-show-list__title" href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!a) continue;
    const d = m[0].match(/browse-shows-show-list__date">([^<]+)</);
    const v = m[0].match(/browse-shows-show-list__theatre">([^<]+)</);
    out.push({ title: decode(a[2]), url: a[1], date: d ? parseLongDate(decode(d[1])) : null, venue: v ? decode(v[1]) : null });
  }
  return out;
}

/** Pick the BroadwayWorld show page for a title from SERP results. */
function pickBwwUrl(results, title) {
  const want = titleKey(title);
  for (const r of results || []) {
    const url = r.url || r.link || '';
    // Old form /shows/<Title>-<id>.html, newer /shows/<Title>-<id>/cast etc.; both resolve to the .html page.
    const m = url.match(/^https?:\/\/(?:www\.)?broadwayworld\.com\/shows\/([^/?#]+?)-(\d+)(?:\.html|\/|$)/i);
    if (!m) continue;
    if (titleKey(m[1].replace(/-/g, ' ')) === want) return `https://www.broadwayworld.com/shows/${m[1]}-${m[2]}.html`;
  }
  return null;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return 0; }
  const candidatesPath = arg('candidates'); const fromIso = arg('from'); const toIso = arg('to');
  if (!candidatesPath || !/^\d{4}-\d{2}-\d{2}$/.test(fromIso || '') || !/^\d{4}-\d{2}-\d{2}$/.test(toIso || '')) { console.error(USAGE); return 2; }
  const todayIso = arg('today') || new Date().toISOString().slice(0, 10);
  const limit = Number(arg('limit')) || Infinity;
  const skip = new Set((arg('skip-titles') ? JSON.parse(fs.readFileSync(arg('skip-titles'), 'utf8')) : []).map(titleKey));

  const { findTmSameTitleShow, fetchTmOffBroadway, isTmRowInWindow, parseTmOffBroadwayRow, titleKeyLoose } = require('./lib/theatermania-ob');
  const { checkForDuplicate } = require('./lib/deduplication');
  const { toAddShowAction } = require('./lib/ob-historical-cohort');
  const { serpQuery } = require('./lib/url-discovery');
  const { fetchPage } = require('./lib/scraper');

  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = raw.shows || raw;
  const ids = new Set(shows.map((s) => s.id));

  // TheaterMania rows for the window, widened so a run that previewed before it still matches.
  const wideFrom = new Date(Date.parse(fromIso) - 120 * DAY_MS).toISOString().slice(0, 10);
  const feed = await fetchTmOffBroadway({ maxPages: 120, rowFilter: (r) => isTmRowInWindow(r, { fromIso: wideFrom, toIso }), stopWhenPageEmpty: false, orderby: 'id' });
  const tmByKey = new Map();
  for (const row of feed.rows) {
    const p = parseTmOffBroadwayRow(row, { venuesById: feed.venuesById, genresById: feed.genresById });
    if (p.skip) continue;
    const k = titleKeyLoose(p.candidate.title);
    if (!tmByKey.has(k)) tmByKey.set(k, []);
    tmByKey.get(k).push({ ...p.candidate, genre: (p.gateShape.category && p.gateShape.category.name) || null, tmId: row.id, link: row.link });
  }
  console.log(`TheaterMania rows ${wideFrom}..${toIso}: ${feed.rows.length}`);

  // BroadwayWorld's Off-Broadway index for each year the window touches (one page a year).
  const bwwIndex = new Map();
  for (let y = Number(fromIso.slice(0, 4)) - 1; y <= Number(toIso.slice(0, 4)); y++) {
    let rows = [];
    try { rows = parseBwwBrowsePage((await fetchPage(`https://www.broadwayworld.com/browseshows.php?showtype=OF&open_yr=${y}`, { purpose: 'historical-backfill' })).content); } catch { rows = []; }
    for (const r of rows) { const k = titleKey(r.title); if (!bwwIndex.has(k)) bwwIndex.set(k, []); bwwIndex.get(k).push(r); }
    console.log(`BroadwayWorld OB index ${y}: ${rows.length} shows`);
  }

  const cands = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  const actions = [];
  const verdicts = {};
  const typeGuessed = [];
  let n = 0;
  for (const c of cands) {
    if (n >= limit) break;
    const tag = (r) => { verdicts[r] = (verdicts[r] || 0) + 1; };
    if (skip.has(titleKey(c.title))) { tag('playbill'); continue; }
    const probe = { title: c.title, openingDate: c.openingDate, category: 'off-broadway' };
    const same = findTmSameTitleShow(probe, shows, { allowTransfers: true });
    let dup = null;
    try { dup = checkForDuplicate(probe, shows); } catch { dup = null; }
    if ((same && same.category === 'off-broadway') || (dup && dup.isDuplicate && dup.existingShow && dup.existingShow.category === 'off-broadway')) { tag('in-catalog'); continue; }
    n++;
    const tmRows = (tmByKey.get(titleKeyLoose(c.title)) || []);
    const hit = (bwwIndex.get(titleKey(c.title)) || []).sort((a, b) => Math.abs(daysBetween(a.date || c.openingDate, c.openingDate)) - Math.abs(daysBetween(b.date || c.openingDate, c.openingDate)))[0];
    let bwwUrl = hit ? hit.url : null;
    if (!bwwUrl) {
      const results = await serpQuery(`broadwayworld "${c.title}" off-broadway show`, { log: () => {}, skipProviders: ['scrapingbee'] }).catch(() => null);
      bwwUrl = pickBwwUrl(results, c.title);
    }
    let bww = null;
    if (bwwUrl) {
      try {
        const r = await fetchPage(bwwUrl, { purpose: 'historical-backfill' });
        bww = parseBwwShowPage(r && r.content);
      } catch (e) { bww = null; }
    }
    // Several TM rows can share a title (revivals): take the one whose closing agrees.
    let tm = (bww && tmRows.find((t) => near(t.closingDate, bww.closing))) || tmRows[0] || null;
    let second = 'theatermania';
    // TheaterMania's OB feed lacks many pre-2020 runs; the card's second allowed source is Broadway.com.
    if (bww && !tm) {
      const bcUrl = `https://www.broadway.com/shows/${broadwayComSlug(c.title)}/`;
      try {
        const bc = parseBroadwayComPage((await fetchPage(bcUrl, { purpose: 'historical-backfill' })).content);
        if (bc.title && titleKey(bc.title) === titleKey(c.title) && bc.closing) {
          tm = { venue: bc.venue, previewsStartDate: bc.previews, openingDate: bc.opening, closingDate: bc.closing, link: bcUrl, genre: null };
          second = 'broadway.com';
        }
      } catch { /* no Broadway.com page: stays refused below */ }
    }
    // c.openingDate is the census row's earliest critic write-up date (ob-census-candidates.js), not a listed opening.
    const v = bwwUrl ? decideTwoSource({ bww, tm, firstReview: c.openingDate, fromIso, toIso, todayIso }) : { ok: false, reason: 'no BroadwayWorld show page found' };
    tag(v.ok ? 'two-source' : 'refused');
    if (!v.ok) { console.log(`  - ${c.title}: ${v.reason}${bwwUrl ? ` (${bwwUrl})` : ''}`); continue; }
    const year = v.dates.openingDate.slice(0, 4);
    // House id style drops apostrophes (the-devils-disciple-…), unlike TheaterMania's own slugs (mlima-s-tale).
    const slug = `${broadwayComSlug(c.title)}-off-broadway-${year}`;
    if (ids.has(slug)) { console.log(`  - ${c.title}: id ${slug} already exists`); tag('id-exists'); continue; }
    // Broadway.com carries no genre: those default to play and are listed for a hand check.
    const entry = { id: slug, slug, title: c.title, venue: tm.venue, ...v.dates, type: tm.genre === 'Musicals' ? 'musical' : 'play', isRevival: null };
    if (!tm.genre) typeGuessed.push(slug);
    const action = toAddShowAction(entry, {
      discoveredAt: `${todayIso}T00:00:00.000Z`,
      dateSource: `two-source:bww+${second}`,
      evidenceUrls: [bwwUrl, tm.link, ...(c.evidenceUrls || []).slice(0, 4)],
      discoverySource: 'ob-historical:census',
    });
    if (!action) { console.log(`  - ${c.title}: venue "${tm.venue}" refused by sanitizeVenueForWrite`); tag('venue-refused'); continue; }
    actions.push(action);
    console.log(`  + ${v.dates.previewsStartDate || '-'} / ${v.dates.openingDate} -> ${v.dates.closingDate}  ${slug} @ ${action.show.venue}`);
  }
  console.log(`Verdicts: ${JSON.stringify(verdicts)}`);
  if (typeGuessed.length) console.log(`Type guessed as 'play' (check by hand): ${typeGuessed.join(', ')}`);
  console.log(`Promotable: ${actions.length}`);
  console.log('ACTIONS_BEGIN');
  console.log(JSON.stringify(actions));
  console.log('ACTIONS_END');
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

module.exports = { venuesAgree, parseLongDate, parseBwwShowPage, parseBroadwayComPage, broadwayComSlug, parseBwwBrowsePage, decideTwoSource, pickBwwUrl, titleKey };
