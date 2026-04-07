#!/usr/bin/env node
/**
 * backfill-review-dates.js — Fetch pages for undated reviews to extract publishDate.
 *
 * Lightweight alternative to collect-review-texts.js: only fetches the page to
 * extract datePublished from JSON-LD/meta tags. Does NOT re-collect full text.
 *
 * Usage:
 *   node scripts/backfill-review-dates.js [--limit=N] [--show=SHOW_ID] [--dry-run]
 *
 * Options:
 *   --limit=N            Max reviews to process (default: 50)
 *   --show=ID            Only process a specific show
 *   --dry-run            Show what would be updated without writing files
 *   --offset=N           Skip first N undated reviews (for batching)
 *   --domains=high-yield Only process reviews from high-yield domains (>70% date rate)
 *   --domains=a.com,b.com  Only process specific domains
 *   --prioritize         Sort high-yield domains first (even without --domains filter)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');

const args = process.argv.slice(2);
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const offset = parseInt(args.find(a => a.startsWith('--offset='))?.split('=')[1] || '0');
const domainMode = args.find(a => a.startsWith('--domains='))?.split('=')[1]; // high-yield, custom list, or omit for all
const prioritize = args.includes('--prioritize'); // sort by high-yield domains first

// Domains with >70% existing date rate — HTML fetching works well on these
const HIGH_YIELD_DOMAINS = new Set([
  'hollywoodreporter.com', 'ew.com', 'nydailynews.com', 'vulture.com',
  'timeout.com', 'variety.com', 'theatermania.com', 'wsj.com', 'nypost.com',
  'deadline.com', 'observer.com', 'talkinbroadway.com', 'ny1.com',
  'telegraph.co.uk', 'newyorktheatreguide.com', 'standard.co.uk',
  'theaterlife.com', 'ft.com', 'whatsonstage.com', 'independent.co.uk',
  'thestage.co.uk', 'chicagotribune.com', 'nytimes.com', 'washingtonpost.com',
  'theguardian.com', 'npr.org', 'latimes.com', 'usatoday.com',
]);

// Domains that never/rarely have structured date metadata — skip to save API credits
const SKIP_DOMAINS = new Set([
  'cititour.com',        // 216 undated, 0% date rate, custom CMS with no metadata
  'nytheatre.com',       // 11 undated, 0% date rate, defunct
  'stagedoor.com',       // aggregator excerpts, not original articles
]);

// --- Date extraction from HTML (copied from collect-review-texts.js) ---

function normalizeExtractedDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  try {
    const dateMatch = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dateMatch) {
      const year = parseInt(dateMatch[1]);
      const month = parseInt(dateMatch[2]);
      const day = parseInt(dateMatch[3]);
      if (year < 1970 || year > 2030) return null;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    if (year < 1970 || year > 2030) return null;
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch (e) {
    return null;
  }
}

function extractPublishDateFromHtml(html) {
  if (!html || html.length < 100) return null;

  // 1. JSON-LD datePublished (most reliable)
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const data = JSON.parse(jsonStr);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const date = item.datePublished || item.dateCreated;
        if (date) {
          const normalized = normalizeExtractedDate(date);
          if (normalized) return normalized;
        }
      }
    } catch (e) { /* invalid JSON-LD, skip */ }
  }

  // 2. HTML meta tags
  const metaSelectors = [
    /meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /meta[^>]*property=["']og:article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']DC\.date\.issued["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const regex of metaSelectors) {
    const m = html.match(regex);
    if (m && m[1]) {
      const normalized = normalizeExtractedDate(m[1]);
      if (normalized) return normalized;
    }
  }

  // 3. <time datetime="..."> in article context
  const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeMatch && timeMatch[1]) {
    const normalized = normalizeExtractedDate(timeMatch[1]);
    if (normalized) return normalized;
  }

  return null;
}

function extractDateFromText(text) {
  if (!text || text.length < 50) return null;
  const first500 = text.substring(0, 500);
  // Skip context words that indicate run dates, not publish dates
  const contextWords = /(?:running|runs|through|until|closes|closing|opened|opens|previews|performances)/i;

  const datePatterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gi,
    /\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}/gi,
  ];

  const found = [];
  for (const pat of datePatterns) {
    let m;
    while ((m = pat.exec(first500)) !== null) {
      // Check surrounding context — reject if near run/closing date words
      const start = Math.max(0, m.index - 30);
      const context = first500.substring(start, m.index + m[0].length + 30);
      if (!contextWords.test(context)) {
        found.push(m[0]);
      }
    }
  }

  if (found.length === 1) {
    return normalizeExtractedDate(found[0]);
  }
  return null;
}

// --- Main ---

async function main() {
  const baseDir = path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(baseDir)) {
    console.error('ERROR: data/review-texts/ not found');
    process.exit(1);
  }

  // Find all undated reviews with URLs
  const shows = fs.readdirSync(baseDir).filter(d => {
    try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
  });

  const candidates = [];
  let skippedDomain = 0;
  for (const show of shows) {
    if (showFilter && show !== showFilter) continue;
    const dir = path.join(baseDir, show);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!data.publishDate && data.url && !data.wrongProduction && !data.wrongShow) {
          let domain;
          try { domain = new URL(data.url).hostname.replace(/^www\./, ''); } catch { continue; }

          // Skip known-zero-yield domains
          if (SKIP_DOMAINS.has(domain)) { skippedDomain++; continue; }

          // Domain filter: only include specified domains
          if (domainMode === 'high-yield' && !HIGH_YIELD_DOMAINS.has(domain)) continue;
          if (domainMode && domainMode !== 'high-yield') {
            // Custom comma-separated domain list
            const customDomains = new Set(domainMode.split(',').map(d => d.trim()));
            if (!customDomains.has(domain)) continue;
          }

          const isHighYield = HIGH_YIELD_DOMAINS.has(domain);
          candidates.push({ show, file, url: data.url, filePath: path.join(dir, file), domain, isHighYield });
        }
      } catch (e) { /* skip invalid JSON */ }
    }
  }

  // Sort: high-yield domains first (when --prioritize or --domains=high-yield)
  if (prioritize || domainMode === 'high-yield') {
    candidates.sort((a, b) => {
      if (a.isHighYield && !b.isHighYield) return -1;
      if (!a.isHighYield && b.isHighYield) return 1;
      return 0;
    });
  }

  console.log(`Found ${candidates.length} undated reviews with URLs`);
  if (skippedDomain > 0) console.log(`Skipped ${skippedDomain} reviews from zero-yield domains`);
  if (domainMode) console.log(`Domain filter: ${domainMode}`);
  if (offset > 0) console.log(`Skipping first ${offset}`);

  const batch = candidates.slice(offset, offset + limit);
  console.log(`Processing batch of ${batch.length} (limit=${limit}, offset=${offset})`);
  if (dryRun) console.log('DRY RUN — no files will be modified');

  let extracted = 0, failed = 0, errors = 0;

  for (let i = 0; i < batch.length; i++) {
    const { show, file, url, filePath } = batch[i];
    console.log(`\n[${i + 1}/${batch.length}] ${show}/${file}`);
    console.log(`  URL: ${url.substring(0, 100)}`);

    try {
      // Pre-check: try URL-based extraction first (free, no API credits)
      const urlDateResult = extractDateFromUrl(url);
      if (urlDateResult && urlDateResult.date) {
        console.log(`  ✓ Date from URL (no fetch needed): ${urlDateResult.date}`);
        if (!dryRun) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          data.publishDate = urlDateResult.date;
          data.dateSource = `url-backfill-${urlDateResult.source}`;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
        extracted++;
        continue;
      }

      // Pre-check: try text-based extraction from existing fullText (free)
      {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.fullText) {
          const textDate = extractDateFromText(data.fullText);
          if (textDate) {
            console.log(`  ✓ Date from text regex (no fetch needed): ${textDate}`);
            if (!dryRun) {
              data.publishDate = textDate;
              data.dateSource = 'text-regex-backfill';
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
            }
            extracted++;
            continue;
          }
        }
      }

      // Fetch the page to extract date from HTML metadata
      const result = await fetchPage(url, { timeout: 15000 });
      const html = typeof result === 'string' ? result : (result?.html || result?.content || '');

      if (!html || html.length < 100) {
        console.log('  ✗ No HTML returned');
        failed++;
        continue;
      }

      let date = extractPublishDateFromHtml(html);

      if (date) {
        console.log(`  ✓ Extracted date: ${date}`);
        extracted++;
        if (!dryRun) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          data.publishDate = date;
          data.dateSource = 'html-backfill';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
      } else {
        console.log('  ✗ No date found in HTML or text');
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      errors++;
    }

    // Rate limiting: 2 seconds between fetches
    if (i < batch.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Processed: ${batch.length}`);
  console.log(`Dates extracted: ${extracted} (${(extracted / batch.length * 100).toFixed(0)}%)`);
  console.log(`No date found: ${failed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Remaining undated: ${candidates.length - offset - extracted}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
