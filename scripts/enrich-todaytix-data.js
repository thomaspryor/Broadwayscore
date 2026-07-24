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

const { isLondonMarket } = require('./lib/venue-classification');
const { buildTodayTixUrl } = require('./lib/url-utils');
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
  for (const s of candidates) {
    if (s.todaytixId === ttShow.id) return s;
  }

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
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
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

  // Pass 0: direct todaytixId matches — an ID already stored in shows.json
  // (e.g. saved by update-show-status.js title matching) is authoritative, so
  // enrich regardless of TodayTix subcategory tags. Some legit WE shows carry
  // only tags like "Contemporary"/"Must-See" and would be dropped by the
  // subcategory filters below (Trainspotting the Musical, 2026-07-23).
  console.log('\n=== Pass 0: direct todaytixId matches ===');
  for (const { list, location } of [{ list: nycShows, location: 1 }, { list: londonShows, location: 2 }]) {
    for (const tt of list) {
      const show = shows.find(s => s.todaytixId === tt.id && s.status !== 'closed');
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
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  } else {
    console.log(`\nNo changes needed.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
