#!/usr/bin/env node
/**
 * Universal Web Scraper with Fallback
 *
 * Tries multiple scraping services in order:
 * 1. Bright Data (primary - returns markdown)
 * 2. ScrapingBee (fallback - returns HTML)
 * 3. Playwright (last resort - requires browser)
 *
 * Usage:
 *   const { fetchPage } = require('./lib/scraper');
 *   const content = await fetchPage('https://example.com');
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - Bright Data API token (primary)
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (fallback)
 */

const https = require('https');
const { chromium } = require('playwright');

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

let playwright = null; // Lazy load only if needed

/**
 * Fetch page using Bright Data API (markdown output)
 */
async function fetchWithBrightData(url) {
  if (!BRIGHTDATA_TOKEN) {
    return null;
  }

  try {
    const apiUrl = `https://api.brightdata.com/request?zone=scraping_browser&url=${encodeURIComponent(url)}&format=markdown`;

    const response = await new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(apiUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`Bright Data HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });

    return {
      content: response,
      format: 'markdown',
      source: 'brightdata'
    };
  } catch (error) {
    console.error(`⚠️  Bright Data failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch page using ScrapingBee API (HTML output)
 */
async function fetchWithScrapingBee(url, options = {}) {
  if (!SCRAPINGBEE_KEY) {
    return null;
  }

  try {
    const renderJs = options.renderJs !== false;
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}`;

    const response = await new Promise((resolve, reject) => {
      https.get(apiUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }).on('error', reject);
    });

    return {
      content: response,
      format: 'html',
      source: 'scrapingbee'
    };
  } catch (error) {
    console.error(`⚠️  ScrapingBee failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch page using Playwright (browser automation)
 */
async function fetchWithPlaywright(url) {
  try {
    if (!playwright) {
      playwright = await chromium.launch({
        headless: true
      });
    }

    const page = await playwright.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const content = await page.content();
    await page.close();

    return {
      content,
      format: 'html',
      source: 'playwright'
    };
  } catch (error) {
    console.error(`⚠️  Playwright failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch a page with automatic fallback
 *
 * @param {string} url - URL to fetch
 * @param {object} options - Options
 * @param {boolean} options.renderJs - Whether to render JavaScript (default: true)
 * @param {boolean} options.preferPlaywright - Skip APIs and go straight to Playwright (e.g. for BroadwayWorld)
 * @returns {Promise<{content: string, format: 'html'|'markdown', source: string}>}
 */
async function fetchPage(url, options = {}) {
  const preferPlaywright = options.preferPlaywright || false;

  console.log(`Fetching: ${url}`);

  // Special case: BroadwayWorld often needs Playwright for complex JS rendering
  if (preferPlaywright || url.includes('broadwayworld.com')) {
    console.log('  → Using Playwright (complex site)...');
    const result = await fetchWithPlaywright(url);
    if (result) {
      console.log(`  ✅ Success (Playwright, ${result.format})`);
      return result;
    }
  }

  // Try Bright Data first (primary)
  if (BRIGHTDATA_TOKEN) {
    console.log('  → Trying Bright Data (primary)...');
    const result = await fetchWithBrightData(url);
    if (result) {
      console.log(`  ✅ Success (Bright Data, ${result.format})`);
      return result;
    }
  }

  // Fall back to ScrapingBee
  if (SCRAPINGBEE_KEY) {
    console.log('  → Trying ScrapingBee (fallback)...');
    const result = await fetchWithScrapingBee(url, options);
    if (result) {
      console.log(`  ✅ Success (ScrapingBee, ${result.format})`);
      return result;
    }
  }

  // Last resort: Playwright
  if (!preferPlaywright) {
    console.log('  → Trying Playwright (last resort)...');
    const result = await fetchWithPlaywright(url);
    if (result) {
      console.log(`  ✅ Success (Playwright, ${result.format})`);
      return result;
    }
  }

  throw new Error('All scraping methods failed');
}

/**
 * Clean up resources (call this when done with all scraping)
 */
async function cleanup() {
  if (playwright) {
    await playwright.close();
    playwright = null;
  }
}

module.exports = {
  fetchPage,
  fetchWithBrightData,
  fetchWithScrapingBee,
  fetchWithPlaywright,
  cleanup
};
