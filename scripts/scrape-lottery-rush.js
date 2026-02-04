#!/usr/bin/env node
/**
 * scrape-lottery-rush.js — Robust Lottery/Rush Data System
 *
 * Scrapes lottery/rush data from two sources:
 * 1. BwayRush.com — Current prices (ScrapingBee/Bright Data markdown extraction)
 * 2. Playbill — Detailed policies/instructions (LLM-powered extraction)
 *
 * Key design principles:
 * - Incremental merge (never wholesale replace)
 * - Pre-write backup with rotation
 * - High-confidence show matching only
 * - Fail-safe: any failure preserves existing data
 *
 * Usage:
 *   node scripts/scrape-lottery-rush.js                    # Full scrape
 *   node scripts/scrape-lottery-rush.js --source=bwayrush   # Single source
 *   node scripts/scrape-lottery-rush.js --source=playbill   # Single source
 *   node scripts/scrape-lottery-rush.js --dry-run           # Preview only
 *   node scripts/scrape-lottery-rush.js --verbose           # Verbose logging
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');

// ==================== Configuration ====================

const BWAYRUSH_URL = 'https://bwayrush.com/';
const PLAYBILL_URL = 'https://playbill.com/article/broadway-rush-lottery-and-standing-room-only-policies-com-116003';
const OUTPUT_PATH = path.join(__dirname, '../data/lottery-rush.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// CLI args
const args = process.argv.slice(2);
const sourceFilter = args.find(a => a.startsWith('--source='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Load shows data for matching
const allShows = loadShows();

// Override map for titles fuzzy matching can't handle
const TITLE_OVERRIDES = {
  '& Juliet': 'and-juliet-2022',
};

// ==================== HTTP Utilities ====================

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Request timeout')));

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Fetch a URL as markdown (Bright Data) or HTML (ScrapingBee fallback).
 * Returns { content, format } or null.
 */
async function fetchContent(url, { renderJs = true, premiumProxy = false } = {}) {
  // Try Bright Data first (returns markdown natively)
  if (BRIGHTDATA_TOKEN) {
    try {
      const result = await httpsRequest('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ zone: 'scraping_browser', url, format: 'raw' }),
      });
      if (result && result.length > 500) {
        if (verbose) console.log(`  [Bright Data] Success (${result.length} chars HTML)`);
        return { content: result, format: 'html' };
      }
    } catch (err) {
      console.error(`  [Bright Data] Failed: ${err.message}`);
    }
  }

  // Fallback: ScrapingBee (returns HTML, converted to pseudo-markdown for link parsing)
  if (SCRAPINGBEE_KEY) {
    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_KEY,
        url,
        render_js: String(renderJs),
      });
      if (premiumProxy) params.set('premium_proxy', 'true');
      const apiUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
      const result = await httpsRequest(apiUrl);
      if (result && result.length > 500) {
        if (verbose) console.log(`  [ScrapingBee] Success (${result.length} chars HTML)`);
        return { content: result, format: 'html' };
      }
    } catch (err) {
      console.error(`  [ScrapingBee] Failed: ${err.message}`);
    }
  }

  return null;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert HTML to pseudo-markdown preserving link structure.
 * Converts <a href="url" title="tooltip">text</a> to [text](url "tooltip")
 * This allows the same parseBwayRushMarkdown() to work on both formats.
 */
function htmlToMarkdownLinks(html) {
  return html
    // Strip scripts and styles
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Convert <a> tags to markdown links, preserving title attribute
    .replace(/<a\s+[^>]*?href="([^"]*)"[^>]*?title="([^"]*)"[^>]*?>(.*?)<\/a>/gi,
      (_, href, title, text) => `[${text.replace(/<[^>]*>/g, '').trim()}](${href} "${title}")`)
    // Convert remaining <a> tags without title
    .replace(/<a\s+[^>]*?href="([^"]*)"[^>]*?>(.*?)<\/a>/gi,
      (_, href, text) => `[${text.replace(/<[^>]*>/g, '').trim()}](${href})`)
    // Block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Decode entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ==================== Show ID Resolution ====================

function resolveShowId(externalTitle) {
  // Check overrides first
  if (TITLE_OVERRIDES[externalTitle]) {
    return { id: TITLE_OVERRIDES[externalTitle], confidence: 'override' };
  }

  const match = matchTitleToShow(externalTitle, allShows);

  // Only accept high-confidence matches
  if (match && match.confidence === 'high') {
    return { id: match.show.id, confidence: match.confidence };
  }

  return null;
}

// ==================== Platform Detection ====================

function detectPlatform(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.includes('todaytix.com')) return 'TodayTix';
  if (lower.includes('luckyseat.com')) return 'LuckySeat';
  if (lower.includes('broadwaydirect.com')) return 'Broadway Direct';
  if (lower.includes('socialtoaster.com') || lower.includes('rush.telecharge.com')) return 'Telecharge';
  if (lower.includes('hamiltonmusical.com')) return 'Hamilton App';
  return null;
}

// ==================== BwayRush Extraction ====================

async function scrapeBwayRush() {
  console.log('\n[BwayRush] Fetching current prices...');
  const result = await fetchContent(BWAYRUSH_URL, { renderJs: true, premiumProxy: true });

  if (!result) {
    console.error('[BwayRush] Failed to fetch page — skipping');
    return {};
  }

  // Convert HTML to pseudo-markdown if needed (preserving link structure)
  if (result.format === 'html') {
    if (verbose) console.log('[BwayRush] Converting HTML to markdown links...');
    result.content = htmlToMarkdownLinks(result.content);
    result.format = 'markdown';
  }

  if (result.content.length < 500) {
    console.error(`[BwayRush] Response too short (${result.content.length} chars) — skipping`);
    return {};
  }

  const rawData = parseBwayRushMarkdown(result.content);
  const showCount = Object.keys(rawData).length;

  if (showCount < 5) {
    console.error(`[BwayRush] Only found ${showCount} shows — something is wrong, skipping`);
    return {};
  }

  console.log(`[BwayRush] Parsed ${showCount} shows from markdown`);
  return mapBwayRushToShows(rawData);
}

function parseBwayRushMarkdown(markdown) {
  // Preprocess: join multi-line markdown links into single lines
  // e.g., [$49\n\nin-person](url) → [$49 in-person](url)
  const text = markdown.replace(/\[(\$[^\]]*?)\]\(([^)]+)\)/g, (_match, content, url) => {
    const joined = content.replace(/\n+/g, ' ').trim();
    return `[${joined}](${url})`;
  });

  const shows = {};

  // Find show title links: [Title](url "Title at Theatre")
  // URL pattern excludes ) and " to prevent matching across link boundaries
  const titlePattern = /\[([^\]]+)\]\(([^)"]+)\s+"([^"]+)"\)/g;
  const titleMatches = [...text.matchAll(titlePattern)];

  for (let i = 0; i < titleMatches.length; i++) {
    const match = titleMatches[i];
    const title = match[1];
    const tooltip = match[3];

    // Get block between this show and next
    const startIdx = match.index + match[0].length;
    const endIdx = i < titleMatches.length - 1 ? titleMatches[i + 1].index : text.length;
    const block = text.slice(startIdx, endIdx);

    // Stop at FAQ section
    if (title === 'FAQ' || block.includes('What is rush?')) break;

    // Extract prices from the block
    const prices = extractPrices(block);

    shows[title] = { tooltip, prices };
  }

  return shows;
}

function extractPrices(block) {
  const prices = [];

  // 1. Extract linked prices: [$XX descriptor](url)
  const linkPattern = /\[(\$[^\]]+)\]\(([^)]+)\)/g;
  const linkRanges = [];
  let match;

  while ((match = linkPattern.exec(block)) !== null) {
    linkRanges.push({ start: match.index, end: match.index + match[0].length });

    const content = match[1]; // "$49 in-person" (after preprocessing)
    const url = match[2];

    // Split: first token is price, rest is descriptor
    const spaceIdx = content.indexOf(' ');
    const priceStr = spaceIdx > 0 ? content.slice(0, spaceIdx) : content;
    const descriptor = spaceIdx > 0 ? content.slice(spaceIdx + 1).trim() : '';

    const parsed = parsePriceStr(priceStr);
    if (parsed) {
      prices.push({ ...parsed, descriptor, url });
    }
  }

  // 2. Extract unlinked prices: $XX on their own line (not inside brackets)
  let cleanBlock = block;
  for (const range of [...linkRanges].reverse()) {
    cleanBlock = cleanBlock.slice(0, range.start) + cleanBlock.slice(range.end);
  }

  const lines = cleanBlock.split('\n').map(l => l.trim()).filter(l => l);
  for (let i = 0; i < lines.length; i++) {
    const priceMatch = lines[i].match(/^\$([\d.]+(?:\/[\d.]+)?)$/);
    if (priceMatch) {
      const parsed = parsePriceStr('$' + priceMatch[1]);
      if (parsed && parsed.price > 0) {
        // Check next non-empty line for descriptor
        let descriptor = '';
        if (i + 1 < lines.length && isKnownDescriptor(lines[i + 1])) {
          descriptor = lines[i + 1];
        }
        prices.push({ ...parsed, descriptor, url: null });
      }
    }
  }

  return prices;
}

function parsePriceStr(priceStr) {
  const cleaned = priceStr.replace(/^\$/, '').replace(/\s*\+fee$/i, '');

  // Handle "$55/65" format (weekday/weekend)
  const slashMatch = cleaned.match(/^([\d.]+)\/([\d.]+)$/);
  if (slashMatch) {
    return { price: parseFloat(slashMatch[1]), priceWeekend: parseFloat(slashMatch[2]) };
  }

  const price = parseFloat(cleaned);
  return isNaN(price) ? null : { price };
}

function isKnownDescriptor(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    'in-person', 'mobile', 'digital', 'student', '30 under 30', 'under 30',
    'ponyboy', 'military', 'mtc', 'hiptix', 'linctix', 'college',
    'general', 'anniv', 'club 2064',
  ];
  return patterns.some(p => lower.includes(p));
}

/**
 * Classify a price entry into our schema field type.
 * Uses descriptor text and URL patterns.
 */
function classifyPrice(descriptor, url) {
  const desc = (descriptor || '').toLowerCase().trim();
  const urlLower = (url || '').toLowerCase();

  // Special programs (descriptor-based, highest priority)
  if (desc.includes('college') || desc.includes('student')) return { field: 'studentRush' };
  if (desc.includes('30 under 30') || desc.includes('under 30')) return { field: 'under30' };
  if (desc.includes('ponyboy')) return { field: 'special', name: 'Ponyboy Seat' };
  if (desc.includes('military')) return { field: 'militaryTickets' };
  if (desc.includes('mtc')) return { field: 'special', name: 'MTC $35' };
  if (desc.includes('hiptix')) return { field: 'special', name: 'HipTix' };
  if (desc.includes('linctix')) return { field: 'special', name: 'LincTix' };
  if (desc.includes('anniv')) return { field: 'specialLottery', name: descriptor };
  if (desc.includes('club 2064')) return { field: 'specialLottery', name: 'Club 2064' };

  // In-person rush
  if (desc.includes('in-person')) return { field: 'rush', rushType: 'general' };

  // Mobile — usually TodayTix rush, but Hamilton lottery uses "mobile" too
  if (desc.includes('mobile')) {
    if (urlLower.includes('lottery')) return { field: 'lottery' };
    return { field: 'rush', rushType: 'digital' };
  }

  // Digital — lottery or digital rush depending on URL
  if (desc.includes('digital')) {
    if (urlLower.includes('rush_select')) return { field: 'digitalRush' };
    return { field: 'lottery' };
  }

  // No descriptor — SRO (standing room)
  if (!desc) return { field: 'standingRoom' };

  if (verbose) console.log(`  [Classify] Unknown descriptor: "${descriptor}"`);
  return { field: 'unknown' };
}

function mapBwayRushToShows(rawData) {
  const result = {};
  const unmatched = [];

  for (const [title, showData] of Object.entries(rawData)) {
    if (showData.prices.length === 0) {
      if (verbose) console.log(`  [Skip] ${title} (no prices)`);
      continue;
    }

    const resolved = resolveShowId(title);
    if (!resolved) {
      unmatched.push(title);
      continue;
    }

    const entry = {};

    for (const p of showData.prices) {
      const cls = classifyPrice(p.descriptor, p.url);

      switch (cls.field) {
        case 'lottery':
          if (!entry.lottery) {
            entry.lottery = {
              type: 'digital',
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
            if (p.priceWeekend) entry.lottery.priceWeekend = p.priceWeekend;
          }
          break;

        case 'rush':
          if (!entry.rush) {
            entry.rush = {
              type: cls.rushType || 'general',
              price: p.price,
            };
            if (cls.rushType === 'digital') {
              entry.rush.platform = detectPlatform(p.url);
              entry.rush.url = p.url;
            }
          } else if (cls.rushType === 'digital' && entry.rush.type === 'general') {
            // General rush exists, add digital as separate field
            entry.digitalRush = {
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'digitalRush':
          if (!entry.digitalRush) {
            entry.digitalRush = {
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'studentRush':
          if (!entry.studentRush) {
            entry.studentRush = { price: p.price };
          }
          break;

        case 'standingRoom':
          if (!entry.standingRoom) {
            entry.standingRoom = { price: p.price };
          }
          break;

        case 'specialLottery':
          if (!entry.specialLottery) {
            entry.specialLottery = {
              name: cls.name || 'Special Lottery',
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'under30':
          if (!entry.under30) {
            entry.under30 = { price: p.price };
          }
          break;

        case 'special':
          if (!entry.special) {
            entry.special = { name: cls.name, price: p.price };
          }
          break;

        case 'militaryTickets':
          if (!entry.militaryTickets) {
            entry.militaryTickets = { price: p.price };
          }
          break;
      }
    }

    result[resolved.id] = entry;
  }

  if (unmatched.length > 0) {
    console.log(`\n[BwayRush] ${unmatched.length} unmatched titles:`);
    unmatched.forEach(t => console.log(`  ? "${t}"`));
  }

  console.log(`[BwayRush] Mapped ${Object.keys(result).length} shows to IDs`);
  return result;
}

// ==================== Playbill Extraction ====================

async function scrapePlaybill() {
  if (!ANTHROPIC_KEY) {
    console.error('[Playbill] ANTHROPIC_API_KEY not set — skipping');
    return {};
  }

  console.log('\n[Playbill] Fetching article...');
  const result = await fetchContent(PLAYBILL_URL, { renderJs: false });

  if (!result) {
    console.error('[Playbill] Failed to fetch article — skipping');
    return {};
  }

  // Convert HTML to text if needed (reduces tokens for LLM)
  let articleText = result.content;
  if (result.format === 'html') {
    articleText = htmlToText(articleText);
  }

  if (articleText.length < 1000) {
    console.error(`[Playbill] Article too short (${articleText.length} chars) — skipping`);
    return {};
  }

  console.log(`[Playbill] Got article (${articleText.length} chars), extracting via LLM...`);

  const extracted = await extractPlaybillWithLLM(articleText);
  if (!extracted || extracted.length === 0) {
    console.error('[Playbill] LLM extraction returned no results — skipping');
    return {};
  }

  console.log(`[Playbill] LLM extracted ${extracted.length} valid shows`);
  return mapPlaybillToShows(extracted);
}

async function extractPlaybillWithLLM(articleText) {
  const prompt = `Extract lottery/rush/SRO data from this Playbill article.

Return ONLY a JSON array (no markdown fences, no explanation). Each element:
{
  "title": "Show Title",
  "lottery": { "type": "digital", "platform": "...", "url": "...", "price": 49, "time": "...", "instructions": "..." } or null,
  "rush": { "type": "general|digital", "price": 49, "time": "...", "location": "...", "instructions": "..." } or null,
  "digitalRush": { "platform": "...", "url": "...", "price": 49, "time": "...", "instructions": "..." } or null,
  "standingRoom": { "price": 45, "time": "...", "instructions": "..." } or null,
  "studentRush": { "price": 39, "time": "...", "instructions": "..." } or null,
  "specialLottery": { "name": "...", "platform": "...", "url": "...", "price": 15, "instructions": "..." } or null
}

CRITICAL classification rules:
- LOTTERY = random drawing/selection. Winners are chosen randomly. Platforms: Broadway Direct, LuckySeat, Telecharge lottery, Hamilton App. Uses words like "lottery", "enter", "winners selected/drawn/notified".
- RUSH = first-come first-served. No random drawing. Platforms: TodayTix (always rush, never lottery), box office window. Uses words like "rush", "available", "first-come".
- DIGITAL RUSH = rush tickets via app/website. TodayTix is ALWAYS digitalRush, never lottery.
- GENERAL RUSH = in-person at box office window.
- STANDING ROOM = standing-only tickets sold when show is sold out. Must explicitly say "standing room" or "SRO". Do NOT classify LincTix, HipTix, or other named discount programs as standing room.
- SPECIAL LOTTERY = a secondary/novelty lottery alongside the main one (e.g., "$15 anniversary lottery"). Only use if a show ALSO has a regular lottery.
- If a show has only ONE lottery program, put it in "lottery" (not "specialLottery"), even if it has a special name.

Other rules:
- price must be a number (not a string with $)
- Only include fields that actually exist in the article
- Do not invent data not in the article
- Do NOT include null-valued fields — omit them entirely
- Do NOT create duplicate entries: if the same program appears in multiple fields (e.g., same price and platform in both "lottery" and "rush"), keep only the correct one

Article:
${articleText}`;

  try {
    const response = await httpsRequest('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const parsed = JSON.parse(response);
    const text = parsed.content?.[0]?.text;

    if (!text) throw new Error('No text in LLM response');

    // Extract JSON array (handle potential markdown wrapping)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in LLM response');

    const shows = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(shows)) throw new Error('LLM response is not an array');

    // Validate: each entry must have a title and at least one program
    const valid = shows.filter(entry => {
      if (!entry.title || typeof entry.title !== 'string') return false;
      return !!(entry.lottery || entry.rush || entry.digitalRush ||
                entry.standingRoom || entry.studentRush || entry.specialLottery ||
                entry.under30 || entry.special || entry.studentTickets || entry.militaryTickets);
    });

    console.log(`  [LLM] ${shows.length} extracted, ${valid.length} valid`);
    return valid;

  } catch (err) {
    console.error(`[Playbill] LLM extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Post-process LLM-extracted data to fix common misclassifications.
 * Runs on each show entry before mapping to show IDs.
 */
function postProcessPlaybillEntry(entry) {
  // 1. Remove explicitly null fields
  for (const key of Object.keys(entry)) {
    if (entry[key] === null) delete entry[key];
  }

  // 2. TodayTix entries: usually rush, but can be lottery if it involves random drawing
  if (entry.lottery && entry.lottery.platform === 'TodayTix') {
    const lotteryText = JSON.stringify(entry.lottery).toLowerCase();
    const hasLotteryLanguage = /\b(winner|drawing|drawn|selected|enter|entries|lottery)\b/.test(lotteryText);

    if (hasLotteryLanguage) {
      // Genuine lottery that uses TodayTix as platform (e.g., Harry Potter Friday Forty)
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Keeping TodayTix lottery (has lottery language)`);
    } else {
      // Plain TodayTix rush misclassified as lottery → move to digitalRush
      if (!entry.digitalRush) {
        entry.digitalRush = { ...entry.lottery };
        delete entry.digitalRush.type;
      } else if (!entry.rush) {
        entry.rush = {
          type: 'digital',
          platform: 'TodayTix',
          url: entry.lottery.url,
          price: entry.lottery.price,
          time: entry.lottery.time,
          instructions: entry.lottery.instructions,
        };
      }
      delete entry.lottery;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Moved TodayTix from lottery → digitalRush`);
    }
  }

  // 2b. If digitalRush has lottery language and no lottery exists, promote it to lottery
  if (entry.digitalRush && !entry.lottery) {
    const drText = JSON.stringify(entry.digitalRush).toLowerCase();
    const hasLotteryLanguage = /\b(winner|drawing|drawn|selected|entries\s+accepted)\b/.test(drText);
    if (hasLotteryLanguage) {
      entry.lottery = {
        type: 'digital',
        platform: entry.digitalRush.platform,
        url: entry.digitalRush.url,
        price: entry.digitalRush.price,
        time: entry.digitalRush.time,
        instructions: entry.digitalRush.instructions,
      };
      delete entry.digitalRush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Promoted digitalRush → lottery (has lottery language)`);
    }
  }

  // 3. Deduplicate lottery & specialLottery when same price (with tolerance)
  if (entry.lottery && entry.specialLottery) {
    const normPlatform = (p) => (p || '').toLowerCase().replace(/\s*(lottery|digital)\s*/g, '').trim();
    const samePlatform = normPlatform(entry.lottery.platform) === normPlatform(entry.specialLottery.platform);
    const priceDiff = Math.abs(entry.lottery.price - entry.specialLottery.price);
    const priceClose = priceDiff < 2 || priceDiff / Math.max(entry.lottery.price, entry.specialLottery.price) < 0.1;
    if (priceClose && samePlatform) {
      // If specialLottery has a distinctive name, it's the real program — remove lottery
      if (entry.specialLottery.name && entry.specialLottery.name !== 'Special Lottery') {
        delete entry.lottery;
        if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed lottery (duplicate of named specialLottery "${entry.specialLottery.name}")`);
      } else {
        delete entry.specialLottery;
        if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate specialLottery (same as lottery)`);
      }
    }
  }

  // 4. If only specialLottery exists (no lottery), promote it to lottery
  if (entry.specialLottery && !entry.lottery) {
    entry.lottery = {
      type: 'digital',
      platform: entry.specialLottery.platform,
      url: entry.specialLottery.url,
      price: entry.specialLottery.price,
      time: entry.specialLottery.time || entry.specialLottery.instructions,
      instructions: entry.specialLottery.instructions,
    };
    delete entry.specialLottery;
    if (verbose) console.log(`  [PostProcess] ${entry.title}: Promoted specialLottery → lottery (only lottery program)`);
  }

  // 5. Deduplicate rush & lottery when same price+platform (keep lottery if it's a real lottery)
  if (entry.lottery && entry.rush) {
    if (entry.lottery.price === entry.rush.price &&
        (entry.rush.type === 'digital' || !entry.rush.location)) {
      // Digital rush duplicating lottery → remove rush
      delete entry.rush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate rush (same as lottery)`);
    }
  }

  // 6. Deduplicate digitalRush & rush when both exist and are TodayTix
  if (entry.digitalRush && entry.rush) {
    if (entry.rush.type === 'digital' &&
        entry.rush.platform === entry.digitalRush.platform &&
        entry.rush.price === entry.digitalRush.price) {
      delete entry.rush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate rush (same as digitalRush)`);
    }
  }

  // 7. Remove standingRoom if price matches a special program (LincTix, HipTix, etc.)
  if (entry.standingRoom && entry.special) {
    if (entry.standingRoom.price === entry.special.price) {
      delete entry.standingRoom;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed standingRoom (duplicate of special program)`);
    }
  }
  // Also check for non-integer SRO prices that suggest misclassification
  if (entry.standingRoom && !Number.isInteger(entry.standingRoom.price)) {
    if (verbose) console.log(`  [PostProcess] ${entry.title}: Suspicious SRO price $${entry.standingRoom.price} (non-integer)`);
    // If there's no explicit "standing room" in instructions, likely misclassified
    const sroText = JSON.stringify(entry.standingRoom).toLowerCase();
    if (!sroText.includes('standing') && !sroText.includes('sro') && !sroText.includes('sold out')) {
      delete entry.standingRoom;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed non-integer SRO (likely misclassified)`);
    }
  }

  return entry;
}

function mapPlaybillToShows(extracted) {
  const result = {};
  const unmatched = [];

  for (const entry of extracted) {
    // Post-process to fix common LLM misclassifications
    postProcessPlaybillEntry(entry);

    const resolved = resolveShowId(entry.title);
    if (!resolved) {
      unmatched.push(entry.title);
      continue;
    }

    const showEntry = {};
    const fields = [
      'lottery', 'rush', 'digitalRush', 'standingRoom', 'studentRush',
      'specialLottery', 'under30', 'special', 'studentTickets', 'militaryTickets',
    ];
    for (const field of fields) {
      if (entry[field]) showEntry[field] = entry[field];
    }

    result[resolved.id] = showEntry;
  }

  if (unmatched.length > 0) {
    console.log(`\n[Playbill] ${unmatched.length} unmatched titles:`);
    unmatched.forEach(t => console.log(`  ? "${t}"`));
  }

  console.log(`[Playbill] Mapped ${Object.keys(result).length} shows to IDs`);
  return result;
}

// ==================== Backup & Safety ====================

function backupExisting() {
  if (!fs.existsSync(OUTPUT_PATH)) return;

  const backupPath = OUTPUT_PATH.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(OUTPUT_PATH, backupPath);
  console.log(`[Backup] Saved to ${path.basename(backupPath)}`);

  // Keep only last 5 backups
  const dir = path.dirname(OUTPUT_PATH);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('lottery-rush.backup-'))
    .sort()
    .reverse();
  for (const old of backups.slice(5)) {
    fs.unlinkSync(path.join(dir, old));
  }
}

/**
 * Incrementally merge scraped data into existing data.
 * A scraper can add or update fields, but never delete them.
 * Sub-field level merge: new prices update, but existing time/instructions are preserved.
 */
function mergeIntoExisting(existing, scraped, source) {
  const changes = [];

  for (const [showId, newData] of Object.entries(scraped)) {
    if (!existing.shows[showId]) {
      // New show — add it with metadata
      existing.shows[showId] = {
        ...newData,
        _lastScrapedFrom: source,
        _lastScrapedAt: new Date().toISOString(),
      };
      changes.push({ showId, type: 'added', source });
      continue;
    }

    const current = existing.shows[showId];
    const allFields = [
      'lottery', 'rush', 'digitalRush', 'studentRush', 'standingRoom',
      'specialLottery', 'under30', 'special', 'studentTickets', 'militaryTickets',
    ];

    for (const field of allFields) {
      if (!newData[field]) continue; // Source didn't have this — preserve existing

      if (!current[field]) {
        // New field for this show
        current[field] = newData[field];
        changes.push({ showId, type: 'added-field', field, source });
      } else {
        // Merge sub-fields: update price/url/platform, preserve time/instructions
        let changed = false;
        for (const [key, value] of Object.entries(newData[field])) {
          if (value !== null && value !== undefined && value !== '') {
            if (current[field][key] !== value) {
              if (key === 'price') {
                changes.push({
                  showId, type: 'updated', field, key,
                  old: current[field][key], new: value, source,
                });
              }
              current[field][key] = value;
              changed = true;
            }
          }
        }
        if (changed && verbose) {
          console.log(`  [Merge] Updated ${showId}.${field} from ${source}`);
        }
      }
    }

    // Update provenance metadata
    current._lastScrapedFrom = source;
    current._lastScrapedAt = new Date().toISOString();
  }

  return changes;
}

/**
 * Guard: abort if the set of show IDs changed too dramatically.
 */
function validateShowIdStability(original, updated) {
  const oldIds = new Set(Object.keys(original.shows || {}));
  const newIds = new Set(Object.keys(updated.shows || {}));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));

  if (added.length > 5 || removed.length > 3) {
    console.error(`\n[Guard] ABORT: Too many ID changes (${added.length} added, ${removed.length} removed)`);
    if (added.length > 0) console.error(`  Added: ${added.join(', ')}`);
    if (removed.length > 0) console.error(`  Removed: ${removed.join(', ')}`);
    process.exit(1);
  }

  if (verbose && (added.length > 0 || removed.length > 0)) {
    console.log(`[Guard] ID changes: +${added.length} -${removed.length} (within limits)`);
  }
}

/**
 * Remove entries for shows that have closed.
 * This is a lifecycle cleanup step, separate from the "scrapers never delete" rule.
 */
function cleanClosedShows(existing) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const changes = [];

  for (const showId of Object.keys(existing.shows)) {
    const show = showsData.shows.find(s => s.id === showId);
    if (show && show.status === 'closed') {
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-closed' });
    } else if (!show) {
      // Orphaned entry — show ID not in shows.json at all
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-orphan' });
    }
  }

  return changes;
}

/**
 * Post-merge cleanup: fix cross-source duplicates that can't be caught
 * in per-source post-processing (which only sees one source at a time).
 */
function postMergeCleanup(existing) {
  const fixes = [];

  for (const [showId, show] of Object.entries(existing.shows)) {
    // 1. Remove rush that duplicates lottery (same price, digital/null rush)
    if (show.lottery && show.rush) {
      if (show.lottery.price === show.rush.price &&
          (show.rush.type === 'digital' || !show.rush.location) &&
          (!show.rush.platform || !show.rush.url)) {
        delete show.rush;
        fixes.push(`${showId}: Removed rush (duplicate of lottery, same price $${show.lottery.price})`);
      }
    }

    // 2. Remove non-integer standingRoom prices (always misclassified — SRO is whole dollars)
    if (show.standingRoom && !Number.isInteger(show.standingRoom.price)) {
      fixes.push(`${showId}: Removed standingRoom $${show.standingRoom.price} (non-integer, likely misclassified)`);
      delete show.standingRoom;
    }

    // 3. Deduplicate lottery & specialLottery with null platform handling
    if (show.lottery && show.specialLottery) {
      const priceDiff = Math.abs(show.lottery.price - show.specialLottery.price);
      const priceClose = priceDiff < 2 || priceDiff / Math.max(show.lottery.price, show.specialLottery.price) < 0.1;
      // Null platform matches anything
      const platformMatch = !show.lottery.platform || !show.specialLottery.platform ||
        show.lottery.platform.toLowerCase().replace(/\s*(lottery|digital)\s*/g, '').trim() ===
        show.specialLottery.platform.toLowerCase().replace(/\s*(lottery|digital)\s*/g, '').trim();
      if (priceClose && platformMatch) {
        if (show.specialLottery.name && show.specialLottery.name !== 'Special Lottery') {
          // specialLottery IS the lottery — merge lottery details into specialLottery, then remove lottery
          for (const k of ['platform', 'url', 'time', 'instructions']) {
            if (!show.specialLottery[k] && show.lottery[k]) {
              show.specialLottery[k] = show.lottery[k];
            }
          }
          delete show.lottery;
          fixes.push(`${showId}: Removed lottery (same as specialLottery "${show.specialLottery.name}")`);
        } else {
          delete show.specialLottery;
          fixes.push(`${showId}: Removed specialLottery (duplicate of lottery)`);
        }
      }
    }

    // 4. Remove null-valued top-level fields
    for (const key of Object.keys(show)) {
      if (show[key] === null && key !== '_lastScrapedFrom' && key !== '_lastScrapedAt') {
        delete show[key];
      }
    }

    // 5. If specialLottery is the only lottery-type program, promote to lottery
    if (show.specialLottery && !show.lottery) {
      show.lottery = {
        type: 'digital',
        platform: show.specialLottery.platform,
        url: show.specialLottery.url,
        price: show.specialLottery.price,
        time: show.specialLottery.time || show.specialLottery.instructions,
        instructions: show.specialLottery.instructions,
      };
      // Clean null values from promoted entry
      for (const k of Object.keys(show.lottery)) {
        if (show.lottery[k] === null || show.lottery[k] === undefined) delete show.lottery[k];
      }
      delete show.specialLottery;
      fixes.push(`${showId}: Promoted specialLottery → lottery (only lottery program)`);
    }
  }

  if (fixes.length > 0 && verbose) {
    console.log(`\n[PostMerge] ${fixes.length} fixes:`);
    fixes.forEach(f => console.log(`  - ${f}`));
  }

  return fixes;
}

// ==================== Summary ====================

function printSummary(changes) {
  if (changes.length === 0) {
    console.log('\n[Summary] No changes');
    return;
  }

  console.log(`\n[Summary] ${changes.length} changes:`);
  for (const c of changes) {
    switch (c.type) {
      case 'added':
        console.log(`  + ${c.showId} (added from ${c.source})`);
        break;
      case 'added-field':
        console.log(`  + ${c.showId} ${c.field} (new field from ${c.source})`);
        break;
      case 'updated':
        console.log(`  ~ ${c.showId} ${c.field}.${c.key}: ${c.old} → ${c.new} (from ${c.source})`);
        break;
      case 'removed-closed':
        console.log(`  - ${c.showId} (removed, show closed)`);
        break;
      case 'removed-orphan':
        console.log(`  - ${c.showId} (removed, not in shows.json)`);
        break;
    }
  }
}

// ==================== Main ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Broadway Lottery/Rush Scraper — Robust System');
  console.log('='.repeat(60));
  if (dryRun) console.log('[Mode] DRY RUN — no files will be written\n');
  if (sourceFilter) console.log(`[Mode] Source filter: ${sourceFilter}\n`);

  // Load existing data
  let existing = { lastUpdated: '', source: '', shows: {} };
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  }
  const originalSnapshot = JSON.parse(JSON.stringify(existing));

  const allChanges = [];

  // Scrape sources
  if (!sourceFilter || sourceFilter === 'bwayrush') {
    const bwayrushData = await scrapeBwayRush();
    if (Object.keys(bwayrushData).length > 0) {
      const changes = mergeIntoExisting(existing, bwayrushData, 'bwayrush');
      allChanges.push(...changes);
    }
  }

  if (!sourceFilter || sourceFilter === 'playbill') {
    const playbillData = await scrapePlaybill();
    if (Object.keys(playbillData).length > 0) {
      const changes = mergeIntoExisting(existing, playbillData, 'playbill');
      allChanges.push(...changes);
    }
  }

  // Post-merge cleanup: fix cross-source duplicates
  const mergeFixCount = postMergeCleanup(existing);

  // Clean closed shows
  const closedChanges = cleanClosedShows(existing);
  allChanges.push(...closedChanges);

  // Update top-level metadata
  existing.lastUpdated = new Date().toISOString();
  existing.source = PLAYBILL_URL;

  // Validate stability against original
  validateShowIdStability(originalSnapshot, existing);

  // Summary
  printSummary(allChanges);

  if (allChanges.length === 0) {
    console.log('\n[Result] No changes — data is up to date');
    return;
  }

  if (dryRun) {
    console.log(`\n[Dry Run] Would write ${Object.keys(existing.shows).length} shows to lottery-rush.json`);
    return;
  }

  // Backup before writing
  backupExisting();

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\n[Output] Wrote lottery-rush.json with ${Object.keys(existing.shows).length} shows`);

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
}

main().catch(err => {
  console.error('\n[Fatal]', err.message);
  if (verbose) console.error(err.stack);
  process.exit(1);
});
