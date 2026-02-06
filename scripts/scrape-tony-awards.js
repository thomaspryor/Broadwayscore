#!/usr/bin/env node
/**
 * Scrape Tony Awards Data from Wikipedia
 *
 * Wikipedia has well-structured tables for each Tony Awards ceremony.
 * This script scrapes nominations and wins, then matches to our shows.json.
 *
 * Usage:
 *   node scripts/scrape-tony-awards.js                    # All years (2005-current)
 *   node scripts/scrape-tony-awards.js --year=2024        # Single year
 *   node scripts/scrape-tony-awards.js --dry-run          # Preview without saving
 *
 * Runs automatically via GitHub Actions on June 20th each year.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Tony Awards ceremonies by year (ceremony number, Wikipedia page suffix)
// Broadway season 2004-05 had 59th Tonys in 2005, which is our data start
// Year range is dynamic - no manual updates needed each year
const START_YEAR = 2005;
const CURRENT_YEAR = new Date().getFullYear();

const TONY_CEREMONIES = [];
for (let year = START_YEAR; year <= CURRENT_YEAR; year++) {
  // Tony Awards ceremony dates from Wikipedia:
  // 59th: June 2005, 74th: Sept 2021 (delayed from 2020), 75th: June 2022,
  // 76th: June 2023, 77th: June 2024, 78th: June 2025
  //
  // Formula: Pre-2021 uses year-1946, but 2021+ is shifted due to COVID
  // The 74th (Sept 2021) covered 2019-2020 season, so 2021 should skip to 75th
  let ceremonyNum;
  if (year <= 2020) {
    ceremonyNum = year - 1946; // 2005=59th, 2019=73rd, 2020=74th
  } else if (year === 2021) {
    // Skip 2021 - the 74th was in Sept 2021 but covered 2019-2020 shows
    // Shows from 2021 are covered by 75th (June 2022)
    continue;
  } else {
    ceremonyNum = year - 1947; // 2022=75th, 2023=76th, 2024=77th, etc.
  }

  // Ordinal suffix: 1st, 2nd, 3rd, otherwise th
  let suffix = 'th';
  const lastTwo = ceremonyNum % 100;
  if (lastTwo < 11 || lastTwo > 13) {
    const lastDigit = ceremonyNum % 10;
    if (lastDigit === 1) suffix = 'st';
    else if (lastDigit === 2) suffix = 'nd';
    else if (lastDigit === 3) suffix = 'rd';
  }

  TONY_CEREMONIES.push({
    year,
    ceremony: ceremonyNum,
    season: `${year - 1}-${String(year).slice(2)}`,
    wikiPage: `${ceremonyNum}${suffix}_Tony_Awards`
  });
}

// Categories we care about (Best Musical, Best Play, Best Revival, etc.)
const MAJOR_CATEGORIES = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
  'Best Book of a Musical',
  'Best Original Score',
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
  'Best Direction of a Musical',
  'Best Direction of a Play',
  'Best Choreography',
  'Best Orchestrations',
  'Best Scenic Design',
  'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play',
  'Best Costume Design',
  'Best Costume Design of a Musical',
  'Best Costume Design of a Play',
  'Best Lighting Design',
  'Best Lighting Design of a Musical',
  'Best Lighting Design of a Play',
  'Best Sound Design',
  'Best Sound Design of a Musical',
  'Best Sound Design of a Play',
];

// Categories that are ONLY for plays (musicals cannot win these)
const PLAY_ONLY_CATEGORIES = [
  'Best Play',
  'Best Revival of a Play',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
  'Best Direction of a Play',
  'Best Scenic Design of a Play',
  'Best Costume Design of a Play',
  'Best Lighting Design of a Play',
  'Best Sound Design of a Play',
];

// Categories that are ONLY for musicals (plays cannot win these)
const MUSICAL_ONLY_CATEGORIES = [
  'Best Musical',
  'Best Revival of a Musical',
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Direction of a Musical',
  'Best Book of a Musical',
  'Best Original Score',
  'Best Choreography',
  'Best Orchestrations',
  'Best Scenic Design of a Musical',
  'Best Costume Design of a Musical',
  'Best Lighting Design of a Musical',
  'Best Sound Design of a Musical',
];

/**
 * Filter categories based on show type to prevent impossible nominations
 * (e.g., a musical can't win "Best Play")
 */
function filterCategoriesByShowType(categories, showType) {
  if (showType === 'musical') {
    return categories.filter(cat => !PLAY_ONLY_CATEGORIES.includes(cat));
  }
  if (showType === 'play') {
    return categories.filter(cat => !MUSICAL_ONLY_CATEGORIES.includes(cat));
  }
  return categories; // Unknown type - keep all
}

// Load shows.json for matching
const showsPath = path.join(__dirname, '../data/shows.json');
const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;

// Build lookup maps
const showsByTitle = new Map();
const showsBySlug = new Map();
shows.forEach(show => {
  showsBySlug.set(show.slug, show);
  // Normalize title for matching
  const normalizedTitle = normalizeTitle(show.title);
  if (!showsByTitle.has(normalizedTitle)) {
    showsByTitle.set(normalizedTitle, []);
  }
  showsByTitle.get(normalizedTitle).push(show);
});

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/,/g, '')  // Remove commas for better matching
    .replace(/:/g, '')  // Remove colons for better matching
    .replace(/&/g, 'and')  // Normalize ampersand to "and"
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/i, '')
    .trim();
}

// Title aliases for Wikipedia names that don't match our shows.json titles
// Keys should be normalized (lowercase, no colons/commas, & → and, no leading "the")
const TITLE_ALIASES = {
  // Full titles on Wikipedia vs. shortened in our data
  "sweeney todd the demon barber of fleet street": "sweeney todd",
  "25th annual putnam county spelling bee": "25th annual putnam county spelling bee",
  "a gentleman's guide to love and murder": "a gentleman's guide to love and murder",
  "beautiful the carole king musical": "beautiful the carole king musical",

  // Slash/spacing variations
  "topdog/underdog": "topdog / underdog",
  "sea wall/a life": "sea wall / a life",

  // Article variations
  "an american in paris": "american in paris",
  "a raisin in the sun": "raisin in the sun",

  // Billy Elliot (colon in ours, not in Wikipedia)
  "billy elliot the musical": "billy elliot the musical",

  // The Band's Visit
  "band's visit": "band's visit",

  // Moulin Rouge variations
  "moulin rouge! the musical": "moulin rouge! the musical",
  "moulin rouge!": "moulin rouge! the musical",

  // POTUS - abbreviation vs full title
  "potus": "potus or behind every great dumbass are seven women trying to keep him alive",

  // Shows that should match with articles handled
  "an enemy of the people": "an enemy of the people",
  "a strange loop": "a strange loop",
};

/**
 * Match a Tony nominee to our shows.json
 */
function matchShow(showName, year) {
  let normalized = normalizeTitle(showName);

  // Check aliases first
  if (TITLE_ALIASES[normalized]) {
    normalized = TITLE_ALIASES[normalized];
  }

  // Direct title match
  const candidates = showsByTitle.get(normalized) || [];

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1) {
    // Multiple shows with same title - find the one from the right year
    const yearMatches = candidates.filter(show => {
      const openYear = new Date(show.openingDate).getFullYear();
      // Tony eligibility: show opened before cutoff (usually late April)
      // So a show that opened in 2024 would be eligible for 2024 or 2025 Tonys
      return openYear === year || openYear === year - 1;
    });
    if (yearMatches.length === 1) {
      return yearMatches[0];
    }
    // Return most recent if still ambiguous
    if (yearMatches.length > 1) {
      return yearMatches.sort((a, b) =>
        new Date(b.openingDate) - new Date(a.openingDate)
      )[0];
    }
  }

  // Try partial matches
  for (const [title, shows] of showsByTitle) {
    if (title.includes(normalized) || normalized.includes(title)) {
      const yearMatches = shows.filter(show => {
        const openYear = new Date(show.openingDate).getFullYear();
        return openYear === year || openYear === year - 1;
      });
      if (yearMatches.length >= 1) {
        return yearMatches[0];
      }
    }
  }

  return null;
}

/**
 * Fetch and parse a Wikipedia Tony Awards page
 *
 * Wikipedia Tony Awards tables have this structure:
 * - TH cells contain category names (e.g., "Best Play ‡")
 * - TD cells below contain nominees in UL/LI lists
 * - Winners have their show title wrapped in <b> tags
 * - The ‡ symbol after category names indicates the award was given
 */
async function scrapeTonyYear(year, ceremonyNum, wikiPage) {
  const url = `https://en.wikipedia.org/wiki/${wikiPage}`;
  console.log(`\n📜 Scraping ${ceremonyNum}th Tony Awards (${year})...`);
  console.log(`   URL: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'BroadwayScorecard/1.0 (broadway data aggregator; contact@example.com)'
      }
    });

    if (!response.ok) {
      console.log(`   ❌ HTTP ${response.status}`);
      return [];
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const nominations = [];

    // Find wikitables - the main nominations table is usually the first one
    const tables = doc.querySelectorAll('table.wikitable');

    for (const table of tables) {
      const rows = table.querySelectorAll('tr');

      for (const row of rows) {
        const thCells = row.querySelectorAll('th');
        const tdCells = row.querySelectorAll('td');

        // Process each TH/TD pair in the row
        // Wikipedia often has 2 categories per row (e.g., Best Play | Best Musical)
        thCells.forEach((th, colIndex) => {
          const headerText = th.textContent?.trim() || '';

          // Find matching category
          let matchedCategory = null;
          for (const cat of MAJOR_CATEGORIES) {
            if (headerText.toLowerCase().includes(cat.toLowerCase())) {
              matchedCategory = cat;
              break;
            }
          }

          if (!matchedCategory) return;

          // Find the corresponding TD cell (same column in next row, or check current row)
          // Try to find TD in same position
          let td = null;

          // Check if there's a TD in current row at same column
          if (tdCells[colIndex]) {
            td = tdCells[colIndex];
          }

          // If no TD in current row, look at next row
          if (!td) {
            const nextRow = row.nextElementSibling;
            if (nextRow) {
              const nextTds = nextRow.querySelectorAll('td');
              if (nextTds[colIndex]) {
                td = nextTds[colIndex];
              }
            }
          }

          if (!td) return;

          // Parse nominees from the TD cell
          // Structure: <ul><li><i><b>Winner</b></i> or <i>Nominee</i></li>...</ul>
          const listItems = td.querySelectorAll('li');

          if (listItems.length > 0) {
            // Process list items
            listItems.forEach(li => {
              // Check if this item contains a show (look for italic text)
              const italic = li.querySelector('i');
              if (!italic) return;

              const showName = italic.textContent?.trim();
              if (!showName || showName.length <= 2) return;

              // Check if winner - bold can be:
              // 1. Inside <i>: <i><b>Title</b></i>
              // 2. Parent of <i>: <b><i>Title</i></b>
              // 3. Ancestor of <i>: <b><a><i>Title</i></a></b>
              const hasBoldInside = italic.querySelector('b, strong') !== null;

              // Check ancestors up to the <li> for bold
              let ancestorIsBold = false;
              let el = italic.parentElement;
              while (el && el !== li) {
                if (el.tagName === 'B' || el.tagName === 'STRONG') {
                  ancestorIsBold = true;
                  break;
                }
                el = el.parentElement;
              }

              const isWinner = hasBoldInside || ancestorIsBold;

              nominations.push({
                category: matchedCategory,
                show: showName,
                winner: isWinner,
                year
              });
            });
          } else {
            // No list structure - try to parse directly from cell
            // Some older Wikipedia pages use plain text with line breaks
            const italics = td.querySelectorAll('i');
            italics.forEach(italic => {
              const showName = italic.textContent?.trim();
              if (!showName || showName.length <= 2) return;

              // Check for bold (same logic as above)
              const hasBoldInside = italic.querySelector('b, strong') !== null;

              let ancestorIsBold = false;
              let el = italic.parentElement;
              while (el && el !== td) {
                if (el.tagName === 'B' || el.tagName === 'STRONG') {
                  ancestorIsBold = true;
                  break;
                }
                el = el.parentElement;
              }

              const isWinner = hasBoldInside || ancestorIsBold;

              nominations.push({
                category: matchedCategory,
                show: showName,
                winner: isWinner,
                year
              });
            });
          }
        });
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = nominations.filter(n => {
      const key = `${n.category}|${n.show}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`   Found ${unique.length} nominations`);
    return unique;

  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return [];
  }
}

/**
 * Alternative: Scrape from official Tony Awards website
 * The official site has a searchable database
 */
async function scrapeOfficialTonys(showTitle) {
  // TonyAwards.com has an API-like search
  const searchUrl = `https://www.tonyawards.com/nominees/?q=${encodeURIComponent(showTitle)}`;
  // This would need proper scraping setup - placeholder for now
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const yearArg = args.find(a => a.startsWith('--year='));
  const targetYear = yearArg ? parseInt(yearArg.split('=')[1]) : null;

  console.log('🏆 Tony Awards Data Scraper');
  console.log('===========================');
  if (dryRun) console.log('DRY RUN - no changes will be saved\n');

  // Load existing awards data
  const awardsPath = path.join(__dirname, '../data/awards.json');
  let awardsData;
  try {
    awardsData = JSON.parse(fs.readFileSync(awardsPath, 'utf8'));
  } catch (e) {
    awardsData = {
      _meta: {
        description: 'Broadway show awards data - Tony Awards, Drama Desk, Outer Critics Circle, Drama League',
        lastUpdated: new Date().toISOString().split('T')[0],
        sources: ['Wikipedia', 'TonyAwards.com']
      },
      shows: {}
    };
  }

  const ceremonies = targetYear
    ? TONY_CEREMONIES.filter(c => c.year === targetYear)
    : TONY_CEREMONIES;

  if (ceremonies.length === 0) {
    console.log(`No ceremonies found for year ${targetYear}`);
    process.exit(1);
  }

  // Collect all nominations by show
  const showNominations = new Map(); // showId -> { nominations: [], wins: [] }

  for (const ceremony of ceremonies) {
    const nominations = await scrapeTonyYear(
      ceremony.year,
      ceremony.ceremony,
      ceremony.wikiPage
    );

    // Rate limit - Wikipedia has strict limits
    await new Promise(r => setTimeout(r, 2500));

    // Match nominations to shows
    for (const nom of nominations) {
      const show = matchShow(nom.show, nom.year);

      if (show) {
        if (!showNominations.has(show.id)) {
          showNominations.set(show.id, {
            season: ceremony.season,
            ceremony: `${ceremony.ceremony}th`,
            nominations: [],
            wins: []
          });
        }

        const data = showNominations.get(show.id);
        if (!data.nominations.includes(nom.category)) {
          data.nominations.push(nom.category);
        }
        if (nom.winner && !data.wins.includes(nom.category)) {
          data.wins.push(nom.category);
        }
      } else {
        console.log(`   ⚠️  No match for: "${nom.show}" (${nom.category})`);
      }
    }
  }

  // Update awards data
  let updated = 0;
  let newEntries = 0;

  for (const [showId, data] of showNominations) {
    const existing = awardsData.shows[showId];
    const show = shows.find(s => s.id === showId);
    const showType = show?.type; // 'musical' or 'play'

    // Filter out impossible categories based on show type
    const filteredNominations = filterCategoriesByShowType(data.nominations, showType);
    const filteredWins = filterCategoriesByShowType(data.wins, showType);

    if (!existing) {
      awardsData.shows[showId] = {
        tony: {
          season: data.season,
          ceremony: data.ceremony,
          nominations: filteredNominations.length,
          nominatedFor: filteredNominations,
          wins: filteredWins
        }
      };
      newEntries++;
    } else {
      // Update existing - if we have more nominations OR different wins
      if (!existing.tony) {
        existing.tony = {
          season: data.season,
          ceremony: data.ceremony,
          nominations: filteredNominations.length,
          nominatedFor: filteredNominations,
          wins: filteredWins
        };
        updated++;
      } else if (filteredNominations.length > (existing.tony.nominations || 0) ||
                 filteredWins.length !== (existing.tony.wins?.length || 0)) {
        // Update if more nominations OR wins count changed
        existing.tony = {
          season: data.season,
          ceremony: data.ceremony,
          nominations: filteredNominations.length,
          nominatedFor: filteredNominations,
          wins: filteredWins
        };
        updated++;
      }
    }
  }

  // Summary
  console.log('\n📊 Summary:');
  console.log(`   New entries: ${newEntries}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Total shows with Tony data: ${Object.keys(awardsData.shows).length}`);

  // Handle shows that weren't nominated (shut-out)
  // Only for recent seasons where we can be sure they were eligible
  if (!targetYear || targetYear >= 2020) {
    for (const show of shows) {
      const openYear = new Date(show.openingDate).getFullYear();
      // Check if show was eligible for a Tony season we scraped
      const eligibleYear = ceremonies.find(c =>
        c.year === openYear || c.year === openYear + 1
      );

      if (eligibleYear && !awardsData.shows[show.id]?.tony) {
        // Mark as not nominated (shut-out) only if show opened before Tony cutoff
        const openDate = new Date(show.openingDate);
        const tonyCutoff = new Date(eligibleYear.year, 3, 25); // Late April cutoff

        if (openDate < tonyCutoff && show.status !== 'previews') {
          awardsData.shows[show.id] = awardsData.shows[show.id] || {};
          awardsData.shows[show.id].tony = {
            season: eligibleYear.season,
            ceremony: `${eligibleYear.ceremony}th`,
            nominations: 0,
            nominatedFor: [],
            wins: [],
            shutOut: true
          };
        }
      }
    }
  }

  // Save
  if (!dryRun) {
    awardsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(awardsPath, JSON.stringify(awardsData, null, 2));
    console.log(`\n✅ Saved to ${awardsPath}`);
  } else {
    console.log('\n🔍 Dry run complete - no changes saved');
  }
}

main().catch(console.error);
