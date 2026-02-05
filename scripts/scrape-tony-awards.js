#!/usr/bin/env node
/**
 * Scrape Tony Awards Data from Wikipedia
 *
 * Wikipedia has well-structured tables for each Tony Awards ceremony.
 * This script scrapes nominations and wins, then matches to our shows.json.
 *
 * Usage:
 *   node scripts/scrape-tony-awards.js                    # All years (2005-present)
 *   node scripts/scrape-tony-awards.js --year=2024        # Single year
 *   node scripts/scrape-tony-awards.js --dry-run          # Preview without saving
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Tony Awards ceremonies by year (ceremony number, Wikipedia page suffix)
// Broadway season 2004-05 had 59th Tonys in 2005, which is our data start
const TONY_CEREMONIES = [];
for (let year = 2005; year <= 2025; year++) {
  const ceremonyNum = year - 1946; // 1947 was 1st Tony Awards

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

    // Find the nominations section
    // Wikipedia uses tables with category headers
    const tables = doc.querySelectorAll('table.wikitable');

    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      let currentCategory = null;

      for (const row of rows) {
        const th = row.querySelector('th');
        const tds = row.querySelectorAll('td');

        // Check if this row has a category header
        if (th) {
          const headerText = th.textContent?.trim() || '';
          // Check if it's a category we care about
          for (const cat of MAJOR_CATEGORIES) {
            if (headerText.toLowerCase().includes(cat.toLowerCase())) {
              currentCategory = cat;
              break;
            }
          }
        }

        // Parse nominee cells
        if (currentCategory && tds.length >= 1) {
          for (const td of tds) {
            const text = td.textContent?.trim() || '';
            const isWinner = td.style?.fontWeight === 'bold' ||
                           td.querySelector('b, strong') !== null ||
                           td.style?.backgroundColor?.includes('gold') ||
                           td.classList?.contains('winner');

            // Extract show name - usually in italics or after a dash
            const italics = td.querySelectorAll('i');
            for (const italic of italics) {
              const showName = italic.textContent?.trim();
              if (showName && showName.length > 2) {
                nominations.push({
                  category: currentCategory,
                  show: showName,
                  winner: isWinner,
                  year
                });
              }
            }

            // Also check for links that might be show titles
            const links = td.querySelectorAll('a');
            for (const link of links) {
              const href = link.getAttribute('href') || '';
              const linkText = link.textContent?.trim();
              // Wikipedia musical/play links often contain "(musical)" or "(play)"
              if (href.includes('_(musical)') || href.includes('_(play)') || href.includes('_musical)')) {
                if (linkText && linkText.length > 2) {
                  const exists = nominations.some(n =>
                    n.category === currentCategory && n.show === linkText
                  );
                  if (!exists) {
                    nominations.push({
                      category: currentCategory,
                      show: linkText,
                      winner: isWinner,
                      year
                    });
                  }
                }
              }
            }
          }
        }
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

    if (!existing) {
      awardsData.shows[showId] = {
        tony: {
          season: data.season,
          ceremony: data.ceremony,
          nominations: data.nominations.length,
          nominatedFor: data.nominations,
          wins: data.wins
        }
      };
      newEntries++;
    } else {
      // Update existing - only if we have more data
      if (!existing.tony) {
        existing.tony = {
          season: data.season,
          ceremony: data.ceremony,
          nominations: data.nominations.length,
          nominatedFor: data.nominations,
          wins: data.wins
        };
        updated++;
      } else if (data.nominations.length > (existing.tony.nominations || 0)) {
        existing.tony = {
          season: data.season,
          ceremony: data.ceremony,
          nominations: data.nominations.length,
          nominatedFor: data.nominations,
          wins: data.wins
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
