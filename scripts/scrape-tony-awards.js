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
const { matchTitleToShow } = require('./lib/show-matching');
const { cleanSearchTitle } = require('./lib/title-normalization');

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, etc.)
 */
function getOrdinalSuffix(num) {
  let suffix = 'th';
  const lastTwo = num % 100;
  if (lastTwo < 11 || lastTwo > 13) {
    const lastDigit = num % 10;
    if (lastDigit === 1) suffix = 'st';
    else if (lastDigit === 2) suffix = 'nd';
    else if (lastDigit === 3) suffix = 'rd';
  }
  return suffix;
}

// Tony Awards ceremonies by year (ceremony number, Wikipedia page suffix)
// Broadway season 2004-05 had 59th Tonys in 2005, which is our data start
// Year range is dynamic - no manual updates needed each year
const START_YEAR = 1970;
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

  const suffix = getOrdinalSuffix(ceremonyNum);

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
  'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play',
  'Best Scenic Design',
  'Best Costume Design of a Musical',
  'Best Costume Design of a Play',
  'Best Costume Design',
  'Best Lighting Design of a Musical',
  'Best Lighting Design of a Play',
  'Best Lighting Design',
  'Best Sound Design of a Musical',
  'Best Sound Design of a Play',
  'Best Sound Design',
];

// Wikipedia uses different naming conventions across ceremony pages.
// Map variant names to our canonical short forms.
const CATEGORY_ALIASES = {
  'best performance by a leading actor in a musical': 'Best Actor in a Musical',
  'best performance by a leading actress in a musical': 'Best Actress in a Musical',
  'best performance by a leading actor in a play': 'Best Actor in a Play',
  'best performance by a leading actress in a play': 'Best Actress in a Play',
  'best performance by a featured actor in a musical': 'Best Featured Actor in a Musical',
  'best performance by a featured actress in a musical': 'Best Featured Actress in a Musical',
  'best performance by a featured actor in a play': 'Best Featured Actor in a Play',
  'best performance by a featured actress in a play': 'Best Featured Actress in a Play',
  'best scenic design in a musical': 'Best Scenic Design of a Musical',
  'best scenic design in a play': 'Best Scenic Design of a Play',
  'best costume design in a musical': 'Best Costume Design of a Musical',
  'best costume design in a play': 'Best Costume Design of a Play',
  'best lighting design in a musical': 'Best Lighting Design of a Musical',
  'best lighting design in a play': 'Best Lighting Design of a Play',
  'best sound design in a musical': 'Best Sound Design of a Musical',
  'best sound design in a play': 'Best Sound Design of a Play',
  'best direction of a musical': 'Best Direction of a Musical',
  'best direction of a play': 'Best Direction of a Play',
};

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
  // Note: Best Original Score and Best Orchestrations NOT included — plays with original
  // music can be nominated (e.g., Stereophonic 2024).
  'Best Choreography',
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

  // Subtitled shows where Wikipedia uses full title
  "stranger things the first shadow": "stranger things",
  "the picture of dorian gray": "picture of dorian gray",
  "good night and good luck": "good night and good luck",
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
  for (const [title, showsList] of showsByTitle) {
    if (title.includes(normalized) || normalized.includes(title)) {
      const yearMatches = showsList.filter(show => {
        const openYear = new Date(show.openingDate).getFullYear();
        return openYear === year || openYear === year - 1;
      });
      if (yearMatches.length >= 1) {
        return yearMatches[0];
      }
    }
  }

  // Fallback: use the shared show-matching library (260+ aliases)
  const sharedMatch = matchTitleToShow(showName, shows, { market: 'broadway', year });
  if (sharedMatch && sharedMatch.show) {
    return sharedMatch.show;
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

          // Find matching category — check aliases first (Wikipedia naming variants),
          // then fall back to substring matching against canonical names
          let matchedCategory = null;
          const headerLower = headerText.toLowerCase().trim();
          for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
            if (headerLower.includes(alias)) {
              matchedCategory = canonical;
              break;
            }
          }
          if (!matchedCategory) {
            for (const cat of MAJOR_CATEGORIES) {
              if (headerLower.includes(cat.toLowerCase())) {
                matchedCategory = cat;
                break;
              }
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
          // Structure: <ul><li><b>Winner</b> <ul><li>Nominee 2</li>...</ul></li></ul>
          // Note: Wikipedia nests non-winners inside the winner's <li>, so we must use
          // querySelectorAll('li') to get all descendants. Dedup handles duplicates.
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

              // Extract nominee name (text before the show name, typically "Person – Show")
              const liText = li.textContent?.trim() || '';
              const dashIdx = liText.indexOf('–');
              const nominee = dashIdx > 0 ? liText.substring(0, dashIdx).trim() : '';

              nominations.push({
                category: matchedCategory,
                show: showName,
                winner: isWinner,
                year,
                nominee
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

    // Deduplicate — for performer categories (Actor/Actress), include nominee name
    // in key so multiple performers from the same show are kept as separate nominations
    const seen = new Set();
    const unique = nominations.filter(n => {
      const isPerformerCat = n.category.includes('Actor') || n.category.includes('Actress');
      const key = isPerformerCat
        ? `${n.category}|${n.show}|${n.nominee}`
        : `${n.category}|${n.show}`;
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
  const searchUrl = `https://www.tonyawards.com/nominees/?q=${encodeURIComponent(cleanSearchTitle(showTitle))}`;
  // This would need proper scraping setup - placeholder for now
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const yearArg = args.find(a => a.startsWith('--year='));
  const outputArg = args.find(a => a.startsWith('--output='));
  const targetYear = yearArg ? parseInt(yearArg.split('=')[1]) : null;

  console.log('🏆 Tony Awards Data Scraper');
  console.log('===========================');
  if (dryRun) console.log('DRY RUN - no changes will be saved\n');

  // Load existing awards data (use --output to write to a different file)
  const awardsPath = outputArg ? outputArg.split('=')[1] : path.join(__dirname, '../data/awards.json');
  let awardsData;
  try {
    awardsData = JSON.parse(fs.readFileSync(awardsPath, 'utf8'));
  } catch (e) {
    awardsData = {
      _meta: {
        description: 'Broadway show awards data - Tony Awards, Drama Desk, Outer Critics Circle, Drama League',
        lastUpdated: new Date().toISOString(),
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
            ceremony: `${ceremony.ceremony}${getOrdinalSuffix(ceremony.ceremony)}`,
            nominations: [],
            wins: []
          });
        }

        const data = showNominations.get(show.id);
        // Performer categories can have multiple nominees from the same show
        // (e.g., 2 actors nominated for Best Actor). Allow duplicates for these.
        const isPerformerCat = nom.category.includes('Actor') || nom.category.includes('Actress');
        if (isPerformerCat || !data.nominations.includes(nom.category)) {
          data.nominations.push(nom.category);
        }
        if (nom.winner && !data.wins.includes(nom.category)) {
          data.wins.push(nom.category);
        }
      } else {
        console.warn(`   ⚠️  No match for: "${nom.show}" (${nom.category}, ${nom.year})`);
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
      // Skip non-Broadway shows (West End, Off-Broadway)
      if (show.category && show.category !== 'broadway') continue;

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
            ceremony: `${eligibleYear.ceremony}${getOrdinalSuffix(eligibleYear.ceremony)}`,
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
    awardsData._meta.lastUpdated = new Date().toISOString();
    fs.writeFileSync(awardsPath, JSON.stringify(awardsData, null, 2));
    console.log(`\n✅ Saved to ${awardsPath}`);
  } else {
    console.log('\n🔍 Dry run complete - no changes saved');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
