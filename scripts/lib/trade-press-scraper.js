#!/usr/bin/env node
/**
 * Trade Press Scraper Module
 *
 * Scrapes trade press articles with site-specific extraction and fallback chain.
 *
 * Features:
 * - Site-specific CSS selectors for article extraction
 * - Support for paywalled sites (NYT, Vulture) with optional auth
 * - Fallback chain: Primary scrape → Archive.org → return snippet
 * - Failed-fetches tracking
 *
 * Usage:
 *   const { scrapeTradeArticle, getSiteConfig, SITE_CONFIGS } = require('./trade-press-scraper');
 *   const result = await scrapeTradeArticle('https://deadline.com/...');
 *
 * CLI Test:
 *   node scripts/lib/trade-press-scraper.js --test
 *
 * Environment variables (for paywalled sites):
 *   NYT_EMAIL, NYTIMES_PASSWORD - New York Times credentials
 *   VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
 */

const https = require('https');
const { JSDOM } = require('jsdom');

// Import existing scraper utilities
let fetchPage, fetchWithPlaywright, cleanup;
try {
  const scraper = require('./scraper');
  fetchPage = scraper.fetchPage;
  fetchWithPlaywright = scraper.fetchWithPlaywright;
  cleanup = scraper.cleanup;
} catch (e) {
  // Scraper module not available - will use fallback methods
  console.warn('Warning: scraper.js not available, using built-in fetch methods');
}

// ============================================================================
// SITE CONFIGURATIONS
// ============================================================================

/**
 * Site-specific configurations for trade press outlets
 * Each config has:
 * - domain: Domain pattern to match
 * - selectors: CSS selectors for title, body, date extraction
 * - strategy: 'standard' | 'api' | 'playwright' - preferred scraping method
 * - requiresAuth: Whether site requires login for full content
 * - loginUrl: URL for login page (if requiresAuth)
 * - credentialEnvVars: Environment variable names for credentials
 */
const SITE_CONFIGS = {
  // === FREE SITES ===

  'deadline.com': {
    domain: 'deadline.com',
    selectors: {
      title: 'h1.entry-title, h1.post-title, h1[class*="title"]',
      body: '.entry-content, .post-content, article .content, .article-content',
      date: 'time[datetime], .post-date, .entry-date, meta[property="article:published_time"]',
    },
    strategy: 'standard',
    requiresAuth: false,
  },

  'variety.com': {
    domain: 'variety.com',
    selectors: {
      title: 'h1.c-title, h1.entry-title, h1[class*="title"]',
      body: '.c-content, .entry-content, .article-body, article .content',
      date: 'time[datetime], .c-timestamp, .post-date, meta[property="article:published_time"]',
    },
    strategy: 'standard',
    requiresAuth: false,
  },

  'playbill.com': {
    domain: 'playbill.com',
    selectors: {
      title: 'h1.article-title, h1[class*="title"], .article-header h1',
      body: '.article-body, .article-content, .entry-content, article .content',
      date: 'time[datetime], .article-date, .post-date, meta[property="article:published_time"]',
    },
    strategy: 'standard',
    requiresAuth: false,
  },

  'broadwayjournal.com': {
    domain: 'broadwayjournal.com',
    selectors: {
      title: 'h1.entry-title, h1.post-title, h1[class*="title"]',
      body: '.entry-content, .post-content, article .content',
      date: 'time[datetime], .post-date, .entry-date, meta[property="article:published_time"]',
    },
    strategy: 'standard',
    requiresAuth: false,
  },

  'forbes.com': {
    domain: 'forbes.com',
    selectors: {
      title: 'h1.fs-headline, h1[class*="headline"], h1.article-headline',
      body: '.article-body, .body-container, [class*="article-body"]',
      date: 'time[datetime], .content-data time, meta[property="article:published_time"]',
    },
    strategy: 'standard',
    requiresAuth: false,
  },

  // === PAYWALLED SITES ===

  'nytimes.com': {
    domain: 'nytimes.com',
    selectors: {
      title: 'h1[data-testid="headline"], h1.css-1vkm6nb, h1[class*="Headline"]',
      body: 'section[name="articleBody"], article[id="story"], .StoryBodyCompanionColumn, [class*="StoryBody"]',
      date: 'time[datetime], meta[property="article:published_time"]',
    },
    strategy: 'playwright',
    requiresAuth: true,
    loginUrl: 'https://myaccount.nytimes.com/auth/login',
    credentialEnvVars: {
      email: 'NYT_EMAIL',
      password: 'NYTIMES_PASSWORD',
    },
    loginSelectors: {
      emailInput: 'input[name="email"]',
      emailSubmit: 'button[data-testid="submit-email"]',
      passwordInput: 'input[name="password"]',
      loginSubmit: 'button[data-testid="login-button"]',
      successIndicator: '[data-testid="user-menu"]',
    },
  },

  'vulture.com': {
    domain: 'vulture.com',
    selectors: {
      title: 'h1.headline, h1[class*="headline"], h1.article-title',
      body: '.article-content, .article-body, [class*="ArticleBody"]',
      date: 'time[datetime], .article-date, meta[property="article:published_time"]',
    },
    strategy: 'playwright',
    requiresAuth: true,
    loginUrl: 'https://www.vulture.com/login',
    credentialEnvVars: {
      email: 'VULTURE_EMAIL',
      password: 'VULTURE_PASSWORD',
    },
    loginSelectors: {
      emailInput: 'input[type="email"]',
      passwordInput: 'input[type="password"]',
      loginSubmit: 'button[type="submit"]',
    },
  },
};

// ============================================================================
// FAILED FETCHES TRACKING
// ============================================================================

const failedFetches = [];

/**
 * Track a failed fetch attempt
 * @param {string} url - The URL that failed
 * @param {string} reason - Reason for failure
 * @param {string} domain - Domain of the URL
 */
function trackFailedFetch(url, reason, domain) {
  failedFetches.push({
    url,
    reason,
    domain,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get all failed fetches
 * @returns {Array} Array of failed fetch records
 */
function getFailedFetches() {
  return [...failedFetches];
}

/**
 * Clear failed fetches tracking
 */
function clearFailedFetches() {
  failedFetches.length = 0;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get site config for a URL
 * @param {string} url - URL to get config for
 * @returns {object|null} Site config or null if not found
 */
function getSiteConfig(url) {
  const urlLower = url.toLowerCase();
  for (const [key, config] of Object.entries(SITE_CONFIGS)) {
    if (urlLower.includes(config.domain)) {
      return { key, ...config };
    }
  }
  return null;
}

/**
 * Extract domain from URL
 * @param {string} url - URL to extract domain from
 * @returns {string} Domain
 */
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Parse HTML and extract content using selectors
 * @param {string} html - HTML content
 * @param {object} selectors - CSS selectors for extraction
 * @returns {object} Extracted content
 */
function extractContent(html, selectors) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const result = {
    title: null,
    body: null,
    publishDate: null,
  };

  // Extract title
  if (selectors.title) {
    const titleSelectors = selectors.title.split(',').map(s => s.trim());
    for (const sel of titleSelectors) {
      try {
        const el = doc.querySelector(sel);
        if (el && el.textContent) {
          result.title = el.textContent.trim();
          break;
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }
  }

  // Extract body
  if (selectors.body) {
    const bodySelectors = selectors.body.split(',').map(s => s.trim());
    for (const sel of bodySelectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) {
          // Get all paragraphs within the body
          const paragraphs = el.querySelectorAll('p');
          if (paragraphs.length > 0) {
            result.body = Array.from(paragraphs)
              .map(p => p.textContent.trim())
              .filter(t => t.length > 30)
              .join('\n\n');
          } else {
            result.body = el.textContent.trim();
          }
          if (result.body && result.body.length > 100) {
            break;
          }
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }
  }

  // Extract date
  if (selectors.date) {
    const dateSelectors = selectors.date.split(',').map(s => s.trim());
    for (const sel of dateSelectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) {
          // Check for datetime attribute first
          if (el.hasAttribute('datetime')) {
            result.publishDate = el.getAttribute('datetime');
            break;
          }
          // Check for content attribute (meta tags)
          if (el.hasAttribute('content')) {
            result.publishDate = el.getAttribute('content');
            break;
          }
          // Fall back to text content
          if (el.textContent) {
            result.publishDate = el.textContent.trim();
            break;
          }
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }
  }

  // Clean up body text
  if (result.body) {
    result.body = result.body
      .replace(/\s+/g, ' ')
      .replace(/Subscribe to our newsletter[^.]*\./gi, '')
      .replace(/Sign up for[^.]*\./gi, '')
      .replace(/Advertisement/gi, '')
      .trim();
  }

  return result;
}

/**
 * Fetch from Archive.org Wayback Machine
 * @param {string} url - URL to fetch
 * @returns {Promise<{html: string, archiveUrl: string, archiveTimestamp: string}>}
 */
async function fetchFromArchive(url) {
  // Check if snapshots exist
  const availabilityUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`;

  const availability = await new Promise((resolve, reject) => {
    https.get(availabilityUrl.replace('http:', 'https:'), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Archive.org response'));
        }
      });
    }).on('error', reject);
  });

  const snapshot = availability?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.url) {
    throw new Error('No archive snapshot available');
  }

  // Fetch the archived version
  const archiveResponse = await new Promise((resolve, reject) => {
    https.get(snapshot.url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Archive.org HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });

  return {
    html: archiveResponse,
    archiveUrl: snapshot.url,
    archiveTimestamp: snapshot.timestamp,
  };
}

/**
 * Simple HTTP fetch for HTML content
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} HTML content
 */
async function simpleFetch(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    protocol.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        simpleFetch(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ============================================================================
// MAIN SCRAPING FUNCTION
// ============================================================================

/**
 * Scrape a trade press article
 *
 * @param {string} url - Article URL to scrape
 * @param {object} options - Options
 * @param {string} options.snippet - Original snippet to return as fallback
 * @param {boolean} options.skipAuth - Skip authentication even if credentials available
 * @returns {Promise<{fullText: string|null, title: string|null, publishDate: string|null, source: string, url: string, fallbackUsed: string|null, error: string|null}>}
 */
async function scrapeTradeArticle(url, options = {}) {
  const domain = extractDomain(url);
  const config = getSiteConfig(url);

  const result = {
    fullText: null,
    title: null,
    publishDate: null,
    source: domain,
    url,
    fallbackUsed: null,
    error: null,
  };

  // Use generic selectors if no site-specific config
  const selectors = config?.selectors || {
    title: 'h1',
    body: 'article, .article-content, .entry-content, main',
    date: 'time[datetime], meta[property="article:published_time"]',
  };

  // === TRY PRIMARY SCRAPE ===
  try {
    let html;

    // Check if auth is required and credentials available
    const needsAuth = config?.requiresAuth && !options.skipAuth;
    const hasCredentials = needsAuth && config.credentialEnvVars &&
      process.env[config.credentialEnvVars.email] &&
      process.env[config.credentialEnvVars.password];

    if (needsAuth && !hasCredentials) {
      // Skip to fallback if auth required but no credentials
      throw new Error('Authentication required but credentials not available');
    }

    // Use fetchPage from scraper.js if available, otherwise simple fetch
    if (fetchPage) {
      const response = await fetchPage(url, {
        preferPlaywright: config?.strategy === 'playwright',
      });
      html = response.content;
    } else {
      html = await simpleFetch(url);
    }

    // Extract content
    const extracted = extractContent(html, selectors);

    if (extracted.body && extracted.body.length > 500) {
      result.fullText = extracted.body;
      result.title = extracted.title;
      result.publishDate = extracted.publishDate;
      result.fallbackUsed = 'none';
      return result;
    }

    throw new Error(`Insufficient content extracted: ${extracted.body?.length || 0} chars`);

  } catch (primaryError) {
    console.log(`  Primary scrape failed: ${primaryError.message}`);

    // === TRY ARCHIVE.ORG FALLBACK ===
    try {
      console.log('  Trying Archive.org fallback...');
      const archiveResult = await fetchFromArchive(url);

      const extracted = extractContent(archiveResult.html, selectors);

      if (extracted.body && extracted.body.length > 500) {
        result.fullText = extracted.body;
        result.title = extracted.title;
        result.publishDate = extracted.publishDate;
        result.fallbackUsed = 'archive';
        result.archiveUrl = archiveResult.archiveUrl;
        result.archiveTimestamp = archiveResult.archiveTimestamp;
        return result;
      }

      throw new Error(`Insufficient content in archive: ${extracted.body?.length || 0} chars`);

    } catch (archiveError) {
      console.log(`  Archive.org fallback failed: ${archiveError.message}`);

      // === RETURN SNIPPET AS LAST RESORT ===
      if (options.snippet) {
        result.fullText = options.snippet;
        result.fallbackUsed = 'snippet';
        result.error = `Primary: ${primaryError.message}; Archive: ${archiveError.message}`;
        trackFailedFetch(url, result.error, domain);
        return result;
      }

      // No fallback available
      result.fallbackUsed = 'none';
      result.error = `Primary: ${primaryError.message}; Archive: ${archiveError.message}`;
      trackFailedFetch(url, result.error, domain);
      return result;
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  scrapeTradeArticle,
  getSiteConfig,
  getFailedFetches,
  clearFailedFetches,
  SITE_CONFIGS,
  extractContent,
  fetchFromArchive,
};

// ============================================================================
// CLI TEST MODE
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--test') || args.includes('-t')) {
    // Test mode: scrape a sample article
    (async () => {
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║  TRADE PRESS SCRAPER - TEST MODE                           ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');

      // Test URLs for different outlets
      const testUrls = [
        'https://deadline.com/2024/01/broadway-grosses-week-ending-january-14/',
        'https://playbill.com/article/broadway-grosses-week-ending-january-14-2024',
      ];

      // Use provided URL or default test URL
      const testUrl = args.find(a => a.startsWith('http')) || testUrls[0];

      console.log(`Testing URL: ${testUrl}\n`);

      // Show site config
      const config = getSiteConfig(testUrl);
      if (config) {
        console.log(`Site Config: ${config.key}`);
        console.log(`  Strategy: ${config.strategy}`);
        console.log(`  Requires Auth: ${config.requiresAuth}`);
        console.log('');
      } else {
        console.log('No site-specific config found, using generic selectors\n');
      }

      try {
        const result = await scrapeTradeArticle(testUrl, {
          snippet: 'Test snippet fallback text...',
        });

        console.log('─'.repeat(60));
        console.log('RESULT:');
        console.log('─'.repeat(60));
        console.log(`Title: ${result.title || '(not extracted)'}`);
        console.log(`Date: ${result.publishDate || '(not extracted)'}`);
        console.log(`Source: ${result.source}`);
        console.log(`Fallback Used: ${result.fallbackUsed || 'none'}`);
        console.log(`Error: ${result.error || 'none'}`);
        console.log('');

        if (result.fullText) {
          console.log(`Full Text (${result.fullText.length} chars):`);
          console.log('─'.repeat(60));
          console.log(result.fullText.substring(0, 500) + '...');
        } else {
          console.log('No full text extracted');
        }

        // Show failed fetches if any
        const failed = getFailedFetches();
        if (failed.length > 0) {
          console.log('\n─'.repeat(60));
          console.log('FAILED FETCHES:');
          failed.forEach(f => {
            console.log(`  ${f.url}: ${f.reason}`);
          });
        }

      } catch (error) {
        console.error('Test failed:', error.message);
        process.exit(1);
      }

      // Cleanup if using playwright
      if (cleanup) {
        await cleanup();
      }
    })();
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Trade Press Scraper - Scrape trade press articles with fallback chain

Usage:
  node scripts/lib/trade-press-scraper.js --test [URL]
  node scripts/lib/trade-press-scraper.js --help

Options:
  --test, -t    Run test mode with a sample URL
  --help, -h    Show this help message

Supported Sites:
${Object.keys(SITE_CONFIGS).map(k => `  - ${k}`).join('\n')}

Environment Variables (for paywalled sites):
  NYT_EMAIL, NYTIMES_PASSWORD    - New York Times credentials
  VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
`);
  } else {
    console.log('Run with --test to test the scraper, or --help for usage info');
  }
}
