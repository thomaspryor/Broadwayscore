#!/usr/bin/env node
/**
 * Enrich shows.json with TodayTix data (all categories: Broadway, OB, WE).
 *
 * Fields populated:
 * - todaytixId: TodayTix numeric show ID
 * - todaytixUrl: link to TodayTix page (ticket purchase link)
 * - synopsis: from TodayTix description (only if currently empty)
 *
 * Usage: node scripts/enrich-todaytix-data.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { isLondonMarket } = require('./lib/venue-classification');
const { buildTodayTixUrl } = require('./lib/url-utils');
const { classifyTodayTixStartDate, unconfirmedStartFlags } = require('./lib/todaytix-dates');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-todaytix-data.js — Enrich shows.json with TodayTix data (all categories: Broadway, OB, WE).

Usage:
  node scripts/enrich-todaytix-data.js [options]
  node scripts/enrich-todaytix-data.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllTodayTixShows(location) {
  const city = location === 1 ? 'NYC' : 'London';
  const allShows = [];
  let offset = 0;
  while (true) {
    const url = `https://api.todaytix.com/api/v2/shows?location=${location}&limit=100&offset=${offset}`;
    console.log(`Fetching TodayTix ${city} offset=${offset}...`);
    const data = await fetchJson(url);
    if (!data.data || data.data.length === 0) break;
    allShows.push(...data.data);
    offset += 100;
    if (data.data.length < 100) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  → ${allShows.length} shows from ${city}`);
  return allShows;
}

function getTodayTixCategory(ttShow) {
  const subs = (ttShow.subcategories || []).map(s => s.name);
  if (subs.includes('Broadway')) return 'broadway';
  if (subs.includes('Off-Broadway') || subs.includes('Off Broadway')) return 'off-broadway';
  if (subs.includes('West End')) return 'west-end';
  if (subs.includes('Off West End')) return 'off-west-end';
  return null;
}

function buildTodayTixUrlFromShow(ttShow, location) {
  const city = location === 1 ? 'nyc' : 'london';
  if (ttShow.slug) {
    return buildTodayTixUrl(ttShow.id, ttShow.slug, city);
  }
  return `https://www.todaytix.com/${city}/shows/${ttShow.id}`;
}

// Authoritative direct-ID match: a stored todaytixId identifies the listing
// regardless of title or TodayTix subcategory tags. Closed shows are excluded
// because TodayTix only lists active shows — a match against a closed entry
// means the ID was recycled for a different production.
function directIdMatch(shows, ttId) {
  return shows.find(s => s.todaytixId === ttId && s.status !== 'closed') || null;
}

function matchShow(ttShow, shows, category) {
  const ttSlug = slugify(ttShow.displayName);
  const ttName = ttShow.displayName.toLowerCase();

  // Filter to matching category AND currently open/previews (TodayTix only has active shows)
  const candidates = shows.filter(s => {
    const showCat = s.category || 'broadway';
    // For London markets, match both WE and OWE shows
    if (isLondonMarket(category) ? !isLondonMarket(showCat) : showCat !== category) return false;
    // Skip closed shows — TodayTix only lists active shows, so matching
    // to a closed show is always wrong (different production)
    if (s.status === 'closed') return false;
    return true;
  });

  // 0. Direct todaytixId match (most reliable — handles name mismatches)
  const idMatch = directIdMatch(candidates, ttShow.id);
  if (idMatch) return idMatch;

  // 1. Exact slug match
  for (const s of candidates) {
    if (slugify(s.title) === ttSlug) return s;
  }

  // 2. Slug contains match (handles subtitle differences)
  // Require minimum 8 chars to avoid short-name false positives
  for (const s of candidates) {
    const showSlug = slugify(s.title);
    if (showSlug.length > 8 && (ttSlug.includes(showSlug) || showSlug.includes(ttSlug))) return s;
  }

  return null;
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showsData = loadShows();
  const shows = showsData.shows;

  console.log(`Total shows in shows.json: ${shows.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  // Fetch all TodayTix shows
  const nycShows = await fetchAllTodayTixShows(1);
  const londonShows = await fetchAllTodayTixShows(2);

  const stats = { matched: 0, todaytixIdSet: 0, todaytixUrlSet: 0, synopsisSet: 0, skipped: 0 };
  const enriched = new Set(); // Track already-enriched show IDs to avoid duplicates

  function enrichShow(show, tt, location) {
    if (enriched.has(show.id)) return; // Already processed
    enriched.add(show.id);
    stats.matched++;
    const changes = [];

    if (!show.todaytixId) {
      if (!DRY_RUN) show.todaytixId = tt.id;
      stats.todaytixIdSet++;
      changes.push(`todaytixId=${tt.id}`);
    }

    if (!show.todaytixUrl) {
      const url = buildTodayTixUrlFromShow(tt, location);
      if (!DRY_RUN) show.todaytixUrl = url;
      stats.todaytixUrlSet++;
      changes.push(`todaytixUrl`);
    }

    // Ensure ticketLinks includes a TodayTix entry
    const ttUrl = show.todaytixUrl || buildTodayTixUrlFromShow(tt, location);
    const links = show.ticketLinks || [];
    const hasTTLink = links.some(l => l.platform === 'TodayTix');
    if (!hasTTLink) {
      if (!DRY_RUN) {
        if (!show.ticketLinks) show.ticketLinks = [];
        show.ticketLinks.push({ platform: 'TodayTix', url: ttUrl, priceFrom: null });
      }
      stats.ticketLinksSet = (stats.ticketLinksSet || 0) + 1;
      changes.push('ticketLinks');
    }

    // Start-date backfill for shows already in the DB.
    //
    // discover-new-shows.js only sets dates when it CREATES a show, and its
    // todaytixId dedup means an existing entry is never revisited. So a show
    // that was discovered while its start date was still outside the trust
    // window kept null dates forever — which is why the two 2027 Encores!
    // entries that did land (hallelujah-baby, kiss-of-the-spider-woman) sat
    // dateless from April to August 2026 and never appeared on /off-broadway
    // (that page needs status open/previews; the "Starting Soon" shelf needs a
    // parseable date). This runs daily, so the same show promotes from
    // unconfirmedStartDate to previewsStartDate by itself once it comes inside
    // the window — no separate promotion pass.
    //
    // Only fills genuine holes: never overwrites an existing openingDate or
    // previewsStartDate, both of which can come from higher-trust sources
    // (IBDB, ShowScore press night, manual correction).
    //
    // Titles must still agree. Pass 0 (directIdMatch) treats a stored
    // todaytixId as authoritative with NO title comparison — deliberately, so
    // a legit show with odd TodayTix tags still enriches. That was safe when
    // this function only wrote ids/urls/an empty synopsis, but a DATE is
    // different: if TodayTix has recycled that id onto an unrelated
    // production, writing its start date would hand the status pipeline a
    // date from the wrong show and could promote our row to previews on it
    // (adversarial review, 2026-08-12). directIdMatch already excludes closed
    // rows for this reason; this closes the announced/upcoming half.
    // Prefix containment, not equality: our own titles carry disambiguation
    // suffixes TodayTix doesn't ("The Cherry Orchard (Park Avenue Armory)" vs
    // "The Cherry Orchard", "Berlin_2027" vs "Berlin"), and TodayTix sometimes
    // carries a subtitle we don't. Strict equality rejected both of those as
    // recycled ids on the first run. A genuinely recycled id gives a title that
    // shares no prefix at all.
    const ttTitle = slugify(tt.displayName || tt.name || '');
    const ourTitle = slugify(show.title || '');
    const titlesAgree = !!ttTitle && !!ourTitle
      && (ttTitle.startsWith(ourTitle) || ourTitle.startsWith(ttTitle));
    if (!show.openingDate && !show.previewsStartDate && tt.startDate && !titlesAgree) {
      stats.dateSkippedTitleMismatch = (stats.dateSkippedTitleMismatch || 0) + 1;
      changes.push(`skipped start date — TodayTix title "${tt.displayName || tt.name}" no longer matches (possible recycled id ${tt.id})`);
    } else if (!show.openingDate && !show.previewsStartDate && tt.startDate) {
      const classified = classifyTodayTixStartDate(tt.startDate, show.title, { quiet: true });
      // A date already in the PAST on a show we hold no date for at all is a
      // TodayTix placeholder, not a discovery. Real past starts get dated by
      // the status/closing pipeline long before this. Backfilling one would
      // invent a start date and hand the status logic a show that "already
      // began" (dreamgirls-2026: venue "TBA", status announced, TodayTix
      // startDate 2026-01-01 — the only past date in the 36-show backfill).
      // classifyTodayTixStartDate itself must keep trusting past dates: for a
      // genuinely running show being discovered, that date is correct.
      //
      // Today counts as "not future" too. update-show-status.yml computes
      // status BEFORE this enrichment step runs, so a date written here that
      // equals today would promote the show only on tomorrow's run — the
      // opening-night dispatch for today would already have been decided
      // against an undated row (adversarial review, 2026-08-12). Requiring a
      // strictly future date keeps this writer out of the same-day path
      // entirely instead of half-entering it.
      const startsInPast = classified.previewsStartDate
        && classified.previewsStartDate <= new Date().toISOString().slice(0, 10);
      if (startsInPast) {
        stats.pastPlaceholderSkipped = (stats.pastPlaceholderSkipped || 0) + 1;
        changes.push(`skipped past TodayTix startDate ${classified.previewsStartDate} (placeholder)`);
      } else if (classified.previewsStartDate) {
        if (!DRY_RUN) show.previewsStartDate = classified.previewsStartDate;
        stats.previewsStartDateSet = (stats.previewsStartDateSet || 0) + 1;
        changes.push(`previewsStartDate=${classified.previewsStartDate}`);
      } else if (classified.unconfirmedStartDate) {
        // Same writer shape discover-new-shows.js uses, so the two paths can't
        // drift (second-opinion review flagged the asymmetry).
        const flags = unconfirmedStartFlags(classified.unconfirmedStartDate);
        if (flags.unconfirmedStartDate && show.unconfirmedStartDate !== flags.unconfirmedStartDate) {
          if (!DRY_RUN) Object.assign(show, flags);
          stats.unconfirmedStartDateSet = (stats.unconfirmedStartDateSet || 0) + 1;
          changes.push(`unconfirmedStartDate=${flags.unconfirmedStartDate}`);
        }
      }
    } else if (show.unconfirmedStartDate && (show.openingDate || show.previewsStartDate)) {
      // A trusted date arrived from elsewhere — the quarantine is now stale and
      // would keep claiming a start date that a better source has superseded.
      if (!DRY_RUN) delete show.unconfirmedStartDate;
      stats.unconfirmedStartDateCleared = (stats.unconfirmedStartDateCleared || 0) + 1;
      changes.push('unconfirmedStartDate cleared (trusted date present)');
    }

    if ((!show.synopsis || show.synopsis === '') && tt.description) {
      const synopsis = stripHtml(tt.description).substring(0, 500);
      if (synopsis.length > 20) {
        if (!DRY_RUN) show.synopsis = synopsis;
        stats.synopsisSet++;
        changes.push(`synopsis (${synopsis.length} chars)`);
      }
    }

    if (changes.length > 0) {
      console.log(`  ${show.id}: ${changes.join(', ')}`);
    }
  }

  // Pass 0: direct todaytixId matches. Depends on IDs being seeded upstream —
  // update-show-status.js title-matches listings and stores todaytixId earlier
  // in the same workflow. A stored ID is authoritative, so enrich regardless
  // of TodayTix subcategory tags: some legit WE shows carry only tags like
  // "Contemporary"/"Must-See" and would be dropped by the subcategory filters
  // below (Trainspotting the Musical, 2026-07-23).
  console.log('\n=== Pass 0: direct todaytixId matches ===');
  for (const { list, location } of [{ list: nycShows, location: 1 }, { list: londonShows, location: 2 }]) {
    for (const tt of list) {
      const show = directIdMatch(shows, tt.id);
      if (show) enrichShow(show, tt, location);
    }
  }

  // Process NYC shows (Broadway + OB)
  console.log('\n=== Processing NYC shows ===');
  for (const tt of nycShows) {
    const ttCat = getTodayTixCategory(tt);
    if (!ttCat) continue;
    const show = matchShow(tt, shows, ttCat);
    if (!show) { stats.skipped++; continue; }
    enrichShow(show, tt, 1);
  }

  // Process London shows (WE)
  console.log('\n=== Processing London shows ===');
  const weShows = londonShows.filter(s => {
    const subs = (s.subcategories || []).map(sc => sc.name);
    return subs.includes('West End') || subs.includes('Off West End');
  });
  console.log(`  ${weShows.length} London shows from TodayTix`);

  for (const tt of weShows) {
    const ttCat = getTodayTixCategory(tt) || 'west-end';
    const show = matchShow(tt, shows, ttCat);
    if (!show) { stats.skipped++; continue; }
    enrichShow(show, tt, 2);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Matched: ${stats.matched}`);
  console.log(`todaytixId set: ${stats.todaytixIdSet}`);
  console.log(`todaytixUrl set: ${stats.todaytixUrlSet}`);
  console.log(`synopsis set: ${stats.synopsisSet}`);
  console.log(`ticketLinks set: ${stats.ticketLinksSet || 0}`);
  console.log(`Unmatched TodayTix shows: ${stats.skipped}`);

  if (!DRY_RUN && (stats.todaytixIdSet > 0 || stats.todaytixUrlSet > 0 || stats.synopsisSet > 0 || (stats.ticketLinksSet || 0) > 0)) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  } else {
    console.log(`\nNo changes needed.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
