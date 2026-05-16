#!/usr/bin/env node
/**
 * Enrich awards.json with Olivier Award data from Wikipedia.
 *
 * Parses per-category Wikipedia pages to extract winners and nominees.
 * Maps to our show IDs via title + year matching.
 *
 * Usage: node scripts/enrich-olivier-awards.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { isLondonMarket } = require('./lib/venue-classification');

const AWARDS_PATH = path.join(__dirname, '..', 'data', 'awards.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Show-level Olivier categories (award goes to the show)
const SHOW_CATEGORIES = [
  { page: 'Laurence Olivier Award for Best New Musical', category: 'Best New Musical' },
  { page: 'Laurence Olivier Award for Best New Play', category: 'Best New Play' },
  { page: 'Laurence Olivier Award for Best Musical Revival', category: 'Best Musical Revival' },
  { page: 'Laurence Olivier Award for Best Revival', category: 'Best Revival' },
];

// Person-level categories (award goes to a person FOR a show)
const PERSON_CATEGORIES = [
  { page: 'Laurence Olivier Award for Best Actor', category: 'Best Actor' },
  { page: 'Laurence Olivier Award for Best Actress', category: 'Best Actress' },
  { page: 'Laurence Olivier Award for Best Actor in a Musical', category: 'Best Actor in a Musical' },
  { page: 'Laurence Olivier Award for Best Actress in a Musical', category: 'Best Actress in a Musical' },
  { page: 'Laurence Olivier Award for Best Actor in a Supporting Role', category: 'Best Actor in a Supporting Role' },
  { page: 'Laurence Olivier Award for Best Actress in a Supporting Role', category: 'Best Actress in a Supporting Role' },
  { page: 'Laurence Olivier Award for Best Actor in a Supporting Role in a Musical', category: 'Best Actor in a Supporting Role in a Musical' },
  { page: 'Laurence Olivier Award for Best Actress in a Supporting Role in a Musical', category: 'Best Actress in a Supporting Role in a Musical' },
  { page: 'Laurence Olivier Award for Best Director', category: 'Best Director' },
  { page: 'Laurence Olivier Award for Best Theatre Choreographer', category: 'Best Theatre Choreographer' },
  { page: 'Laurence Olivier Award for Best Set Design', category: 'Best Set Design' },
  { page: 'Laurence Olivier Award for Best Costume Design', category: 'Best Costume Design' },
  { page: 'Laurence Olivier Award for Best Lighting Design', category: 'Best Lighting Design' },
  { page: 'Laurence Olivier Award for Best Sound Design', category: 'Best Sound Design' },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BroadwayScorecardBot/1.0 (broadway-scorecard project)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function getPageContent(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await fetchJson(url);
  const pages = data.query.pages;
  const pageId = Object.keys(pages)[0];
  if (pageId === '-1') return null;
  return pages[pageId].revisions?.[0]?.slots?.main?.['*'] || null;
}

function cleanWikitext(text) {
  return text
    .replace(/<!--.*?-->/gs, '')
    .replace(/<ref[^>]*>.*?<\/ref>/gis, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<\/?(?:br|small|nowiki|sup|sub)[^>]*>/gi, ' ')
    .replace(/\{\{(?:efn|sfn|cite|citation|harvnb)[^}]*\}\}/gi, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'{2,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a category page's wikitables for show-level awards.
 * Tables have columns like: Year | Show | Book | Music | Lyrics
 * Winners have background:#B0C4DE highlight
 */
function parseOlivierTable(content, categoryName) {
  const results = [];
  const tables = content.match(/\{\|[^}]*class="wikitable"[\s\S]*?\|\}/g) || [];

  for (const table of tables) {
    const rows = table.split(/\n\|-/);
    let currentYear = null;

    for (const row of rows) {
      const yearMatch = row.match(/\|\s*(?:rowspan\s*=?\s*"?\d+"?\s*\|)?\s*\[?\[?(\d{4})\]?\]?/);
      if (yearMatch) {
        currentYear = parseInt(yearMatch[1]);
      }
      if (!currentYear || currentYear < 1976) continue;

      const isWinner = /background\s*:\s*#/i.test(row);

      // Extract show title from italic markup ''Title'' or links
      const cells = row.split(/\n?\|/).filter(c => c.trim());
      for (const cell of cells) {
        if (/^\s*(?:rowspan|style|class|\d{4}|!)/.test(cell.trim())) continue;
        const italicMatch = cell.match(/''([^']+)''/);
        if (italicMatch) {
          let showTitle = cleanWikitext(italicMatch[1]).trim();
          showTitle = showTitle.replace(/\s*\((?:musical|play|opera|ballet)\)\s*$/i, '').trim();
          if (showTitle.length >= 2 && !/^Year$|^Musical$|^Play$|^Production$/i.test(showTitle)) {
            results.push({ year: currentYear, show: showTitle, category: categoryName, isWinner });
            break;
          }
        }
      }
    }
  }
  return results;
}

/**
 * Parse person-level category pages. Format: Year | Actor | ''Show''
 */
function parsePersonCategoryPage(content, categoryName) {
  const results = [];
  const tables = content.match(/\{\|[^}]*class="wikitable"[\s\S]*?\|\}/g) || [];

  for (const table of tables) {
    const rows = table.split(/\n\|-/);
    let currentYear = null;

    for (const row of rows) {
      const yearMatch = row.match(/\|\s*(?:rowspan\s*=?\s*"?\d+"?\s*\|)?\s*\[?\[?(\d{4})\]?\]?/);
      if (yearMatch) currentYear = parseInt(yearMatch[1]);
      if (!currentYear || currentYear < 1976) continue;

      const isWinner = /background\s*:\s*#/i.test(row);
      const italicMatches = row.match(/''([^']+)''/g);
      if (!italicMatches) continue;

      for (const match of italicMatches) {
        const showTitle = cleanWikitext(match.replace(/''/g, ''))
          .replace(/\s*\((?:musical|play|opera|ballet)\)\s*$/i, '')
          .trim();
        if (showTitle.length >= 2 && !/^Year$|^Actor$|^Actress$|^Director$|^Production$|^Category$/i.test(showTitle)) {
          results.push({ year: currentYear, show: showTitle, category: categoryName, isWinner });
        }
      }
    }
  }
  return results;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s*:\s*the musical$/i, '')
    .replace(/\s*-\s*the musical$/i, '')
    .replace(/\s*:\s*both parts$/i, '')
    .replace(/\s*–\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBaseTitle(title) {
  return normalizeTitle(title)
    .replace(/:\s.*$/, '')
    .replace(/\s*-\s.*$/, '')
    .trim();
}

function matchShowToId(showTitle, year, shows) {
  const normalized = normalizeTitle(showTitle);
  const baseTitle = getBaseTitle(showTitle);

  // Pass 1: WE shows — exact or substring/base match (wide year tolerance)
  for (const show of shows) {
    if (!isLondonMarket(show.category)) continue;
    const showNorm = normalizeTitle(show.title);
    const showBase = getBaseTitle(show.title);
    const showYear = parseInt(show.id.match(/(\d{4})$/)?.[1] || '0');

    if (Math.abs(showYear - year) <= 6) {
      if (showNorm === normalized || showNorm.includes(normalized) || normalized.includes(showNorm) ||
          (baseTitle.length >= 5 && showBase === baseTitle)) {
        return show.id;
      }
    }
  }

  // Pass 2: All other shows
  for (const show of shows) {
    if (isLondonMarket(show.category)) continue;
    const showNorm = normalizeTitle(show.title);
    const showBase = getBaseTitle(show.title);
    const showYear = parseInt(show.id.match(/(\d{4})$/)?.[1] || '0');

    if (Math.abs(showYear - year) <= 3) {
      if (showNorm === normalized || showNorm.includes(normalized) || normalized.includes(showNorm) ||
          (baseTitle.length >= 5 && showBase === baseTitle)) {
        return show.id;
      }
    }
  }

  return null;
}

async function main() {
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  console.log(`Shows: ${shows.length} | Existing awards entries: ${Object.keys(awardsData.shows).length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  const allAwards = [];

  // Parse show-level categories
  for (const cat of SHOW_CATEGORIES) {
    process.stdout.write(`Fetching ${cat.page}... `);
    try {
      const content = await getPageContent(cat.page);
      if (!content) { console.log('PAGE NOT FOUND'); continue; }
      const results = parseOlivierTable(content, cat.category);
      console.log(`${results.length} entries (${results.filter(r => r.isWinner).length} winners)`);
      allAwards.push(...results);
    } catch (e) { console.log(`ERROR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }

  // Parse person-level categories
  for (const cat of PERSON_CATEGORIES) {
    process.stdout.write(`Fetching ${cat.page}... `);
    try {
      const content = await getPageContent(cat.page);
      if (!content) { console.log('PAGE NOT FOUND'); continue; }
      const results = parsePersonCategoryPage(content, cat.category);
      console.log(`${results.length} entries (${results.filter(r => r.isWinner).length} winners)`);
      allAwards.push(...results);
    } catch (e) { console.log(`ERROR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nTotal raw entries: ${allAwards.length}`);

  // Match to show IDs and group
  const showMap = new Map();
  let matched = 0, unmatched = 0;
  const unmatchedShows = new Map();

  for (const award of allAwards) {
    const showId = matchShowToId(award.show, award.year, shows);
    if (!showId) {
      const key = `${award.show} (${award.year})`;
      unmatchedShows.set(key, (unmatchedShows.get(key) || 0) + 1);
      unmatched++;
      continue;
    }
    matched++;
    if (!showMap.has(showId)) {
      showMap.set(showId, { nominations: new Set(), wins: new Set(), year: award.year });
    }
    const entry = showMap.get(showId);
    entry.nominations.add(award.category);
    if (award.isWinner) entry.wins.add(award.category);
    // Use earliest ceremony year
    if (award.year < entry.year) entry.year = award.year;
  }

  console.log(`Matched: ${matched} | Unmatched: ${unmatched}`);
  console.log(`Unique shows with Olivier data: ${showMap.size}`);

  const sortedUnmatched = Array.from(unmatchedShows.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (sortedUnmatched.length > 0) {
    console.log(`\nTop unmatched shows:`);
    for (const [name, count] of sortedUnmatched) {
      console.log(`  ${name}: ${count} nominations`);
    }
  }

  // Merge into awards.json
  let newEntries = 0, updatedEntries = 0;
  for (const [showId, data] of showMap) {
    if (!awardsData.shows[showId]) {
      awardsData.shows[showId] = {};
      newEntries++;
    } else {
      updatedEntries++;
    }
    const olivierSeason = `${data.year - 1}-${String(data.year).slice(2)}`;
    awardsData.shows[showId].olivier = {
      season: olivierSeason,
      nominations: data.nominations.size,
      nominatedFor: Array.from(data.nominations).sort(),
      wins: Array.from(data.wins).sort()
    };
  }

  console.log(`\n=== Summary ===`);
  console.log(`New award entries: ${newEntries}`);
  console.log(`Updated existing entries: ${updatedEntries}`);

  // Show examples with most nominations
  const topShows = Array.from(showMap.entries())
    .sort((a, b) => b[1].nominations.size - a[1].nominations.size)
    .slice(0, 10);
  console.log(`\nTop shows by Olivier nominations:`);
  for (const [id, data] of topShows) {
    console.log(`  ${id}: ${data.wins.size}W/${data.nominations.size}N`);
  }

  if (!DRY_RUN && showMap.size > 0) {
    awardsData._meta.lastUpdated = new Date().toISOString();
    if (!awardsData._meta.sources.includes('Wikipedia (Olivier Awards)')) {
      awardsData._meta.sources.push('Wikipedia (Olivier Awards)');
    }
    awardsData._meta.description = 'Broadway and West End show awards data - Tony Awards, Drama Desk, Outer Critics Circle, Drama League, Laurence Olivier Awards';
    fs.writeFileSync(AWARDS_PATH, JSON.stringify(awardsData, null, 2) + '\n');
    console.log(`\nawards.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }

  // Sync olivier-winner tag in shows.json. Tags only the CURRENT WE production
  // (status open or previews) when its awards.shows[id].olivier.wins is non-empty.
  // Rationale:
  //   - The WE shelf in WestEndPageClient.tsx filters by `status === 'open' &&
  //     tags.includes('olivier-winner')` — historical/closed shows won't appear
  //     on the shelf even if tagged, so backfilling 100+ historical entries is
  //     pure noise.
  //   - The tag is the gate for the "Olivier Award Winning Shows" featured row.
  //     We only want CURRENT productions on that shelf.
  //   - Tags are never REMOVED (additive only) so manually-curated tags from
  //     prior sessions survive. Manual tags on closed shows persist as history.
  // (showsData was loaded earlier in main(); we reuse and rewrite it.)
  let tagged = 0;
  const newlyTagged = [];
  for (const show of shows) {
    if (show.status !== 'open' && show.status !== 'previews') continue;
    const olivier = awardsData.shows[show.id]?.olivier;
    if (!olivier || !Array.isArray(olivier.wins) || olivier.wins.length === 0) continue;
    if (!show.tags) show.tags = [];
    if (!show.tags.includes('olivier-winner')) {
      show.tags.push('olivier-winner');
      tagged++;
      newlyTagged.push(`${show.id} (${olivier.wins.length} wins: ${olivier.wins.slice(0, 2).join(', ')}${olivier.wins.length > 2 ? '...' : ''})`);
    }
  }

  if (tagged > 0) {
    if (DRY_RUN) {
      console.log(`\n(dry run) Would tag ${tagged} shows with olivier-winner:`);
      newlyTagged.forEach(line => console.log(`  + ${line}`));
    } else {
      fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
      console.log(`\nTagged ${tagged} shows with olivier-winner:`);
      newlyTagged.forEach(line => console.log(`  + ${line}`));
    }
  } else {
    console.log(`\nNo new olivier-winner tags to add (all winning shows already tagged).`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
