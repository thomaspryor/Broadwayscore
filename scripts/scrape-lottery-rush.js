#!/usr/bin/env node
/**
 * scrape-lottery-rush.js
 *
 * Scrapes Playbill's Broadway Rush, Lottery, and Standing Room Only Policies page
 * and updates data/lottery-rush.json with the latest information.
 *
 * Usage: node scripts/scrape-lottery-rush.js
 *
 * Requires: Playwright
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PLAYBILL_URL = 'https://playbill.com/article/broadway-rush-lottery-and-standing-room-only-policies-com-116003';
const OUTPUT_PATH = path.join(__dirname, '../data/lottery-rush.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// Known show ID mappings from show titles to our slugs
const SHOW_TITLE_TO_ID = {
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
  'WICKED': 'wicked-2003',
  'TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK)': 'two-strangers-bway-2025',
};

async function scrapePlaybill() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Navigating to ${PLAYBILL_URL}...`);
  await page.goto(PLAYBILL_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for content to load
  await page.waitForTimeout(3000);

  console.log('Extracting page content...');
  const content = await page.evaluate(() => {
    const article = document.querySelector('.body__inner-container') ||
                    document.querySelector('article') ||
                    document.querySelector('.article-body');
    return article ? article.innerText : document.body.innerText;
  });

  await browser.close();
  console.log('Browser closed.');

  return content;
}

function parseContent(content) {
  const shows = {};
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);

  let currentShowTitle = null;
  let currentShowId = null;
  let currentSection = null;
  let sectionData = {};

  // Regex patterns
  const showTitleRegex = /^([A-Z][A-Z&!':,\s\-()]+)\s*\(/;
  const sectionRegex = /^(Digital Lottery|Digital Rush|General Rush|Standing Room|Student Rush|Student Tickets|Military Tickets|Cancellation Line|The Friday Forty|\$30 Under 30|Ponyboy Seat)$/i;
  const priceRegex = /^Price:\s*\$?([\d.]+)/i;
  const howRegex = /^How:\s*(.+)/i;
  const whereRegex = /^Where:\s*(.+)/i;
  const timeRegex = /^Time:\s*(.+)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for new show
    const titleMatch = line.match(showTitleRegex);
    if (titleMatch) {
      // Save previous section if exists
      if (currentShowId && currentSection && Object.keys(sectionData).length > 0) {
        saveSection(shows, currentShowId, currentSection, sectionData);
      }

      const title = titleMatch[1].trim();
      currentShowTitle = title;
      currentShowId = SHOW_TITLE_TO_ID[title];

      if (!currentShowId) {
        console.log(`  Unknown show: ${title}`);
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

    // Check for section header
    const sectionMatch = line.match(sectionRegex);
    if (sectionMatch && currentShowId) {
      // Save previous section
      if (currentSection && Object.keys(sectionData).length > 0) {
        saveSection(shows, currentShowId, currentSection, sectionData);
      }

      currentSection = sectionMatch[1];
      sectionData = {};
      continue;
    }

    // Parse section fields
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

  // Save last section
  if (currentShowId && currentSection && Object.keys(sectionData).length > 0) {
    saveSection(shows, currentShowId, currentSection, sectionData);
  }

  return shows;
}

function saveSection(shows, showId, sectionType, data) {
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
  if (lower.includes('telecharge')) return 'Telecharge';
  if (lower.includes('hamilton')) return 'Hamilton App';
  return 'Unknown';
}

function extractUrl(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0].replace(/[,.]$/, '');

  // Try to construct URL from platform names
  const lower = text.toLowerCase();
  if (lower.includes('todaytix')) return 'https://www.todaytix.com';
  if (lower.includes('luckyseat')) return 'https://www.luckyseat.com';
  if (lower.includes('telecharge')) return 'https://rush.telecharge.com';
  if (lower.includes('broadwaydirect')) return 'https://lottery.broadwaydirect.com';

  return null;
}

async function main() {
  try {
    // Scrape Playbill
    const content = await scrapePlaybill();

    // Parse content
    console.log('Parsing content...');
    const shows = parseContent(content);

    // Build output structure
    const output = {
      lastUpdated: new Date().toISOString(),
      source: PLAYBILL_URL,
      shows: shows
    };

    // Write output
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log(`\nWrote lottery-rush.json with ${Object.keys(shows).length} shows.`);

    // Run tag sync
    console.log('\nSyncing tags in shows.json...');
    const syncScript = path.join(__dirname, 'sync-lottery-rush-tags.js');
    if (fs.existsSync(syncScript)) {
      const { execSync } = require('child_process');
      execSync(`node ${syncScript}`, { stdio: 'inherit' });
    }

    console.log('\nDone!');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
