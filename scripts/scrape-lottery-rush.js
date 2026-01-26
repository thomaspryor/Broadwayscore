#!/usr/bin/env node
/**
 * scrape-lottery-rush.js
 *
 * Scrapes lottery/rush data from multiple sources:
 * 1. Playbill - detailed policies and instructions
 * 2. BwayRush.com - current prices (more frequently updated)
 *
 * Cross-references both sources and flags discrepancies.
 * BwayRush prices are preferred when they differ.
 *
 * Usage: node scripts/scrape-lottery-rush.js
 *
 * Requires: Playwright
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PLAYBILL_URL = 'https://playbill.com/article/broadway-rush-lottery-and-standing-room-only-policies-com-116003';
const BWAYRUSH_URL = 'https://bwayrush.com/';
const OUTPUT_PATH = path.join(__dirname, '../data/lottery-rush.json');

// Known show ID mappings from show titles to our slugs
const SHOW_TITLE_TO_ID = {
  // Uppercase (Playbill format)
  '& JULIET': 'and-juliet-2022',
  'ALADDIN': 'aladdin-2014',
  'ALL OUT: COMEDY ABOUT AMBITION': 'all-out-2025',
  'THE BOOK OF MORMON': 'book-of-mormon-2011',
  'BUENA VISTA SOCIAL CLUB': 'buena-vista-social-club-2025',
  'BUG': 'bug-2026',
  'CHESS': 'chess-2025',
  'CHICAGO': 'chicago-1996',
  'DEATH BECOMES HER': 'death-becomes-her-2024',
  'THE GREAT GATSBY': 'the-great-gatsby-2024',
  'HADESTOWN': 'hadestown-2019',
  'HAMILTON': 'hamilton-2015',
  'HARRY POTTER AND THE CURSED CHILD': 'harry-potter-2021',
  "HELL'S KITCHEN": 'hells-kitchen-2024',
  'JUST IN TIME': 'just-in-time-2025',
  'LIBERATION': 'liberation-2025',
  'THE LION KING': 'the-lion-king-1997',
  'MAMMA MIA!': 'mamma-mia-2025',
  'MARJORIE PRIME': 'marjorie-prime-2025',
  'MAYBE HAPPY ENDING': 'maybe-happy-ending-2024',
  'MJ THE MUSICAL': 'mj-2022',
  'MOULIN ROUGE! THE MUSICAL': 'moulin-rouge-2019',
  'OEDIPUS': 'oedipus-2025',
  'OH, MARY!': 'oh-mary-2024',
  'OPERATION MINCEMEAT': 'operation-mincemeat-2025',
  'THE OUTSIDERS': 'the-outsiders-2024',
  'RAGTIME': 'ragtime-2025',
  'SIX: THE MUSICAL': 'six-2021',
  'STRANGER THINGS: THE FIRST SHADOW': 'stranger-things-2025',
  'WICKED': 'wicked-2003',
  'TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK)': 'two-strangers-bway-2025',

  // Mixed case (BwayRush format)
  '& Juliet': 'and-juliet-2022',
  'Aladdin': 'aladdin-2014',
  'All Out': 'all-out-2025',
  'The Book of Mormon': 'book-of-mormon-2011',
  'Buena Vista Social Club': 'buena-vista-social-club-2025',
  'Bug': 'bug-2026',
  'Chess': 'chess-2025',
  'Chicago': 'chicago-1996',
  'Death Becomes Her': 'death-becomes-her-2024',
  'The Great Gatsby': 'the-great-gatsby-2024',
  'Hadestown': 'hadestown-2019',
  'Hamilton': 'hamilton-2015',
  'Harry Potter and the Cursed Child': 'harry-potter-2021',
  "Hell's Kitchen": 'hells-kitchen-2024',
  'Just in Time': 'just-in-time-2025',
  'Liberation': 'liberation-2025',
  'The Lion King': 'the-lion-king-1997',
  'Mamma Mia!': 'mamma-mia-2025',
  'Marjorie Prime': 'marjorie-prime-2025',
  'Maybe Happy Ending': 'maybe-happy-ending-2024',
  'MJ': 'mj-2022',
  'Moulin Rouge!': 'moulin-rouge-2019',
  'Oedipus': 'oedipus-2025',
  'Oh, Mary!': 'oh-mary-2024',
  'Operation Mincemeat': 'operation-mincemeat-2025',
  'The Outsiders': 'the-outsiders-2024',
  'Ragtime': 'ragtime-2025',
  'Six': 'six-2021',
  'Stranger Things: The First Shadow': 'stranger-things-2025',
  'Wicked': 'wicked-2003',
  'Two Strangers (Carry a Cake Across New York)': 'two-strangers-bway-2025',
};

// ============================================================================
// BwayRush Scraper - More current price data
// ============================================================================

async function scrapeBwayRush(browser) {
  console.log('\n[BwayRush] Scraping current prices...');
  const page = await browser.newPage();

  try {
    await page.goto(BWAYRUSH_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Extract show data from the page
    const showData = await page.evaluate(() => {
      const shows = {};

      // Find all show containers - they have links to show websites
      const showContainers = document.querySelectorAll('[class*="generic"]');

      // Look for links that contain show info
      const allLinks = document.querySelectorAll('a');
      let currentShow = null;

      allLinks.forEach(link => {
        const text = link.textContent.trim();
        const href = link.href;

        // Detect show name links (they link to official show sites)
        if (href && !href.includes('bwayrush') && !href.includes('instagram') &&
            !href.includes('todaytix') && !href.includes('telecharge') &&
            !href.includes('luckyseat') && !href.includes('broadwaydirect') &&
            !href.includes('socialtoaster') &&
            text && text.length > 2 && text.length < 60 &&
            !text.includes('$') && !text.match(/^\d/)) {
          // This might be a show name
          currentShow = text;
          if (!shows[currentShow]) {
            shows[currentShow] = { rush: [], lottery: [], sro: null, special: [] };
          }
        }

        // Detect price links
        const priceMatch = text.match(/^\$?([\d.]+(?:\/\d+)?)\s*(.*)$/);
        if (priceMatch && currentShow && shows[currentShow]) {
          const price = priceMatch[1];
          const type = priceMatch[2].toLowerCase();

          if (type.includes('in-person') || type.includes('general')) {
            shows[currentShow].rush.push({ price: parseFloat(price), type: 'in-person', url: href });
          } else if (type.includes('mobile') || type.includes('digital rush')) {
            shows[currentShow].rush.push({ price: parseFloat(price), type: 'digital', url: href });
          } else if (type.includes('digital') || type.includes('lottery')) {
            shows[currentShow].lottery.push({ price: parseFloat(price), url: href });
          } else if (type.includes('student')) {
            shows[currentShow].special.push({ price: parseFloat(price), type: 'student', url: href });
          } else if (type.includes('30 under 30') || type.includes('under 30')) {
            shows[currentShow].special.push({ price: parseFloat(price), type: 'under30', url: href });
          } else if (type.includes('sro') || type.includes('standing')) {
            shows[currentShow].sro = parseFloat(price);
          } else if (type.includes('anniv')) {
            shows[currentShow].special.push({ price: parseFloat(price), type: 'anniversary', url: href });
          }
        }
      });

      return shows;
    });

    await page.close();
    console.log(`[BwayRush] Found ${Object.keys(showData).length} shows`);
    return showData;

  } catch (error) {
    console.error('[BwayRush] Error:', error.message);
    await page.close();
    return {};
  }
}

// Alternative: Extract from page snapshot (more reliable)
async function scrapeBwayRushFromSnapshot(browser) {
  console.log('\n[BwayRush] Scraping from page structure...');
  const page = await browser.newPage();

  try {
    await page.goto(BWAYRUSH_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Get the full HTML and parse it
    const html = await page.content();

    // Extract data using a more structured approach
    const data = await page.evaluate(() => {
      const results = {};

      // The page structure has show blocks with links
      // Each show has a title link followed by price links
      const container = document.body;
      const text = container.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      let currentShow = null;

      for (const line of lines) {
        // Skip header lines
        if (line.includes('week of') || line === 'show' || line === 'rush' ||
            line === 'lottery' || line === 'sro' || line === 'special' ||
            line.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i) ||
            line.match(/^\d+[ap]m$/) || line === '0') {
          continue;
        }

        // Check if this is a show name (no $ sign, reasonable length)
        if (!line.includes('$') && line.length > 2 && line.length < 80 &&
            !line.match(/^Closing|^Previews|^FAQ|^What is/i)) {
          // Could be a show name
          const cleanName = line.replace(/\s*Closing on.*$/, '').replace(/\s*Previews start.*$/, '').trim();
          if (cleanName.length > 2) {
            currentShow = cleanName;
            if (!results[currentShow]) {
              results[currentShow] = {
                rushPrices: [],
                lotteryPrices: [],
                sroPrices: [],
                specialPrices: []
              };
            }
          }
          continue;
        }

        // Parse price lines like "$49 in-person" or "$45 digital"
        const priceMatch = line.match(/^\$?([\d.]+(?:\/\d+)?)\s*(.*)$/);
        if (priceMatch && currentShow && results[currentShow]) {
          const price = parseFloat(priceMatch[1]);
          const descriptor = priceMatch[2].toLowerCase();

          if (descriptor.includes('in-person') || descriptor.includes('general')) {
            results[currentShow].rushPrices.push({ price, type: 'in-person' });
          } else if (descriptor.includes('mobile')) {
            results[currentShow].rushPrices.push({ price, type: 'mobile' });
          } else if (descriptor.includes('digital') && !descriptor.includes('lottery')) {
            // Could be digital rush or digital lottery
            if (descriptor.includes('rush')) {
              results[currentShow].rushPrices.push({ price, type: 'digital' });
            } else {
              results[currentShow].lotteryPrices.push({ price, type: 'digital' });
            }
          } else if (descriptor.includes('student')) {
            results[currentShow].specialPrices.push({ price, type: 'student' });
          } else if (descriptor.includes('30 under') || descriptor.includes('under 30')) {
            results[currentShow].specialPrices.push({ price, type: 'under30' });
          } else if (descriptor.includes('anniv')) {
            results[currentShow].specialPrices.push({ price, type: 'anniversary' });
          } else if (descriptor.includes('ponyboy')) {
            results[currentShow].specialPrices.push({ price, type: 'ponyboy' });
          } else if (descriptor.includes('club 2064')) {
            results[currentShow].lotteryPrices.push({ price, type: 'club2064' });
          } else if (!descriptor || descriptor.length < 3) {
            // Just a price, likely SRO based on context
            results[currentShow].sroPrices.push(price);
          }
        }
      }

      return results;
    });

    await page.close();

    // Convert to our format
    const converted = {};
    for (const [showName, showData] of Object.entries(data)) {
      const showId = SHOW_TITLE_TO_ID[showName];
      if (!showId) {
        console.log(`  [BwayRush] Unknown show: "${showName}"`);
        continue;
      }

      converted[showId] = {
        rushPrice: showData.rushPrices.length > 0 ? showData.rushPrices[0].price : null,
        lotteryPrice: showData.lotteryPrices.length > 0 ? showData.lotteryPrices[0].price : null,
        sroPrice: showData.sroPrices.length > 0 ? showData.sroPrices[0] : null,
        specialPrices: showData.specialPrices,
        allRush: showData.rushPrices,
        allLottery: showData.lotteryPrices
      };
    }

    console.log(`[BwayRush] Mapped ${Object.keys(converted).length} shows to our IDs`);
    return converted;

  } catch (error) {
    console.error('[BwayRush] Error:', error.message);
    await page.close();
    return {};
  }
}

// ============================================================================
// Playbill Scraper - Detailed policies
// ============================================================================

async function scrapePlaybill(browser) {
  console.log('\n[Playbill] Scraping detailed policies...');
  const page = await browser.newPage();

  try {
    await page.goto(PLAYBILL_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const content = await page.evaluate(() => {
      const article = document.querySelector('.body__inner-container') ||
                      document.querySelector('article') ||
                      document.querySelector('.article-body');
      return article ? article.innerText : document.body.innerText;
    });

    await page.close();
    console.log('[Playbill] Content extracted');
    return parsePlaybillContent(content);

  } catch (error) {
    console.error('[Playbill] Error:', error.message);
    await page.close();
    return {};
  }
}

function parsePlaybillContent(content) {
  const shows = {};
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);

  let currentShowTitle = null;
  let currentShowId = null;
  let currentSection = null;
  let sectionData = {};

  const showTitleRegex = /^([A-Z][A-Z&!':,\s\-()]+)\s*\(/;
  const sectionRegex = /^(Digital Lottery|Digital Rush|General Rush|Standing Room|Student Rush|Student Tickets|Military Tickets|Cancellation Line|The Friday Forty|\$30 Under 30|Ponyboy Seat)$/i;
  const priceRegex = /^Price:\s*\$?([\d.]+)/i;
  const howRegex = /^How:\s*(.+)/i;
  const whereRegex = /^Where:\s*(.+)/i;
  const timeRegex = /^Time:\s*(.+)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const titleMatch = line.match(showTitleRegex);
    if (titleMatch) {
      if (currentShowId && currentSection && Object.keys(sectionData).length > 0) {
        savePlaybillSection(shows, currentShowId, currentSection, sectionData);
      }

      const title = titleMatch[1].trim();
      currentShowTitle = title;
      currentShowId = SHOW_TITLE_TO_ID[title];

      if (!currentShowId) {
        console.log(`  [Playbill] Unknown show: ${title}`);
      } else {
        if (!shows[currentShowId]) {
          shows[currentShowId] = {
            lottery: null,
            rush: null,
            standingRoom: null
          };
        }
      }
      currentSection = null;
      sectionData = {};
      continue;
    }

    const sectionMatch = line.match(sectionRegex);
    if (sectionMatch && currentShowId) {
      if (currentSection && Object.keys(sectionData).length > 0) {
        savePlaybillSection(shows, currentShowId, currentSection, sectionData);
      }
      currentSection = sectionMatch[1];
      sectionData = {};
      continue;
    }

    if (currentSection && currentShowId) {
      const priceMatch = line.match(priceRegex);
      if (priceMatch) {
        sectionData.price = parseFloat(priceMatch[1]);
        continue;
      }

      const howMatch = line.match(howRegex);
      if (howMatch) {
        sectionData.how = howMatch[1];
        continue;
      }

      const whereMatch = line.match(whereRegex);
      if (whereMatch) {
        sectionData.where = whereMatch[1];
        continue;
      }

      const timeMatch = line.match(timeRegex);
      if (timeMatch) {
        sectionData.time = timeMatch[1];
        continue;
      }
    }
  }

  if (currentShowId && currentSection && Object.keys(sectionData).length > 0) {
    savePlaybillSection(shows, currentShowId, currentSection, sectionData);
  }

  console.log(`[Playbill] Parsed ${Object.keys(shows).length} shows`);
  return shows;
}

function savePlaybillSection(shows, showId, sectionType, data) {
  if (!shows[showId]) return;

  const sectionLower = sectionType.toLowerCase();

  if (sectionLower.includes('lottery') || sectionLower === 'the friday forty') {
    const platform = detectPlatform(data.where || data.how || '');
    shows[showId].lottery = {
      type: sectionLower.includes('friday forty') ? 'friday-forty' : 'digital',
      platform: platform,
      url: extractUrl(data.where || data.how || ''),
      price: data.price || null,
      time: data.time || '',
      instructions: data.how || ''
    };
  } else if (sectionLower === 'digital rush') {
    const platform = detectPlatform(data.where || data.how || '');
    if (!shows[showId].rush) {
      shows[showId].rush = {
        type: 'digital',
        platform: platform,
        url: extractUrl(data.where || data.how || ''),
        price: data.price || null,
        time: data.time || '',
        instructions: data.how || ''
      };
    } else {
      shows[showId].digitalRush = {
        platform: platform,
        url: extractUrl(data.where || data.how || ''),
        price: data.price || null,
        time: data.time || '',
        instructions: data.how || ''
      };
    }
  } else if (sectionLower === 'general rush') {
    shows[showId].rush = {
      type: 'general',
      price: data.price || null,
      time: data.time || '',
      location: data.where || '',
      instructions: data.how || ''
    };
  } else if (sectionLower === 'student rush') {
    shows[showId].studentRush = {
      price: data.price || null,
      time: data.time || '',
      instructions: data.how || ''
    };
  } else if (sectionLower === 'standing room') {
    shows[showId].standingRoom = {
      price: data.price || null,
      time: data.time || '',
      instructions: data.how || ''
    };
  }
}

function detectPlatform(text) {
  const lower = text.toLowerCase();
  if (lower.includes('todaytix')) return 'TodayTix';
  if (lower.includes('luckyseat')) return 'LuckySeat';
  if (lower.includes('broadwaydirect') || lower.includes('broadway direct')) return 'Broadway Direct';
  if (lower.includes('telecharge') || lower.includes('socialtoaster')) return 'Telecharge';
  if (lower.includes('hamilton')) return 'Hamilton App';
  return 'Unknown';
}

function extractUrl(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0].replace(/[,.]$/, '');

  const lower = text.toLowerCase();
  if (lower.includes('todaytix')) return 'https://www.todaytix.com';
  if (lower.includes('luckyseat')) return 'https://www.luckyseat.com';
  if (lower.includes('telecharge')) return 'https://rush.telecharge.com';
  if (lower.includes('broadwaydirect')) return 'https://lottery.broadwaydirect.com';

  return null;
}

// ============================================================================
// Merge and Cross-Reference
// ============================================================================

function mergeData(playbillData, bwayrushData) {
  const merged = {};
  const discrepancies = [];

  // Start with Playbill data (has detailed instructions)
  for (const [showId, showData] of Object.entries(playbillData)) {
    merged[showId] = JSON.parse(JSON.stringify(showData)); // Deep copy
  }

  // Cross-reference with BwayRush prices
  for (const [showId, bwrData] of Object.entries(bwayrushData)) {
    if (!merged[showId]) {
      // Show in BwayRush but not Playbill - add it
      merged[showId] = {
        lottery: bwrData.lotteryPrice ? {
          type: 'digital',
          platform: 'Unknown',
          url: null,
          price: bwrData.lotteryPrice,
          time: '',
          instructions: ''
        } : null,
        rush: bwrData.rushPrice ? {
          type: 'general',
          price: bwrData.rushPrice,
          time: '',
          location: '',
          instructions: ''
        } : null,
        standingRoom: bwrData.sroPrice ? {
          price: bwrData.sroPrice,
          time: '',
          instructions: ''
        } : null
      };
      console.log(`  [Merge] Added ${showId} from BwayRush (not in Playbill)`);
      continue;
    }

    // Check for price discrepancies and use BwayRush (more current)
    const show = merged[showId];

    // Lottery price check
    if (show.lottery && bwrData.lotteryPrice) {
      if (show.lottery.price !== bwrData.lotteryPrice) {
        discrepancies.push({
          show: showId,
          field: 'lottery price',
          playbill: show.lottery.price,
          bwayrush: bwrData.lotteryPrice
        });
        show.lottery.price = bwrData.lotteryPrice; // Use BwayRush
      }
    } else if (!show.lottery && bwrData.lotteryPrice) {
      // Playbill missing lottery, add from BwayRush
      show.lottery = {
        type: 'digital',
        platform: 'Unknown',
        url: null,
        price: bwrData.lotteryPrice,
        time: '',
        instructions: ''
      };
      discrepancies.push({
        show: showId,
        field: 'lottery',
        playbill: 'missing',
        bwayrush: bwrData.lotteryPrice
      });
    }

    // Rush price check
    if (show.rush && bwrData.rushPrice) {
      if (show.rush.price !== bwrData.rushPrice) {
        discrepancies.push({
          show: showId,
          field: 'rush price',
          playbill: show.rush.price,
          bwayrush: bwrData.rushPrice
        });
        show.rush.price = bwrData.rushPrice; // Use BwayRush
      }
    } else if (!show.rush && bwrData.rushPrice) {
      // Playbill missing rush, add from BwayRush
      show.rush = {
        type: 'general',
        price: bwrData.rushPrice,
        time: '',
        location: '',
        instructions: ''
      };
      discrepancies.push({
        show: showId,
        field: 'rush',
        playbill: 'missing',
        bwayrush: bwrData.rushPrice
      });
    }

    // SRO price check
    if (show.standingRoom && bwrData.sroPrice) {
      if (show.standingRoom.price !== bwrData.sroPrice) {
        discrepancies.push({
          show: showId,
          field: 'SRO price',
          playbill: show.standingRoom.price,
          bwayrush: bwrData.sroPrice
        });
        show.standingRoom.price = bwrData.sroPrice; // Use BwayRush
      }
    } else if (!show.standingRoom && bwrData.sroPrice) {
      // Playbill missing SRO, add from BwayRush
      show.standingRoom = {
        price: bwrData.sroPrice,
        time: '',
        instructions: 'Available only if sold out.'
      };
      discrepancies.push({
        show: showId,
        field: 'standingRoom',
        playbill: 'missing',
        bwayrush: bwrData.sroPrice
      });
    }

    // Add special prices from BwayRush
    if (bwrData.specialPrices && bwrData.specialPrices.length > 0) {
      for (const special of bwrData.specialPrices) {
        if (special.type === 'student' && !show.studentRush) {
          show.studentRush = { price: special.price, time: '', instructions: 'Valid student ID required.' };
        } else if (special.type === 'under30' && !show.under30) {
          show.under30 = { price: special.price, instructions: 'For ages 30 and under with valid ID.' };
        } else if (special.type === 'anniversary' && !show.specialLottery) {
          show.specialLottery = { name: 'Anniversary Lottery', price: special.price };
        }
      }
    }
  }

  return { merged, discrepancies };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('Broadway Lottery/Rush Scraper - Multi-Source');
  console.log('='.repeat(60));

  const browser = await chromium.launch({ headless: true });

  try {
    // Scrape both sources
    const playbillData = await scrapePlaybill(browser);
    const bwayrushData = await scrapeBwayRushFromSnapshot(browser);

    // Merge data
    console.log('\n[Merge] Cross-referencing sources...');
    const { merged, discrepancies } = mergeData(playbillData, bwayrushData);

    // Report discrepancies
    if (discrepancies.length > 0) {
      console.log(`\n[Discrepancies] Found ${discrepancies.length} price differences:`);
      for (const d of discrepancies) {
        console.log(`  - ${d.show}: ${d.field} (Playbill: ${d.playbill}, BwayRush: ${d.bwayrush}) -> Using BwayRush`);
      }
    } else {
      console.log('\n[Discrepancies] None found - sources agree!');
    }

    // Build output
    const output = {
      lastUpdated: new Date().toISOString(),
      sources: [PLAYBILL_URL, BWAYRUSH_URL],
      discrepanciesFound: discrepancies.length,
      shows: merged
    };

    // Write output
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log(`\n[Output] Wrote lottery-rush.json with ${Object.keys(merged).length} shows.`);

    // Run tag sync
    console.log('\n[Tags] Syncing tags in shows.json...');
    const syncScript = path.join(__dirname, 'sync-lottery-rush-tags.js');
    if (fs.existsSync(syncScript)) {
      const { execSync } = require('child_process');
      execSync(`node ${syncScript}`, { stdio: 'inherit' });
    }

    console.log('\n' + '='.repeat(60));
    console.log('Done!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n[Error]', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
