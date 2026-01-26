# Shared Scraping Library

## Overview

The `scraper.js` module provides unified web scraping with automatic fallback across multiple services:

1. **Bright Data** (primary) - Clean markdown output, best reliability
2. **ScrapingBee** (fallback) - HTML output, good for most sites
3. **Playwright** (last resort) - Full browser automation, slowest but most reliable

## Usage

### Basic Usage

```javascript
const { fetchPage, cleanup } = require('./lib/scraper');

async function scrapeExample() {
  try {
    // Fetch page - automatic fallback if primary fails
    const result = await fetchPage('https://www.broadway.org/shows/');

    console.log(result.content);  // Page content
    console.log(result.format);   // 'html' or 'markdown'
    console.log(result.source);   // 'brightdata', 'scrapingbee', or 'playwright'

  } catch (error) {
    console.error('All scraping methods failed:', error);
  } finally {
    // Always cleanup at the end
    await cleanup();
  }
}
```

### Options

```javascript
// Disable JavaScript rendering (faster, for static sites)
const result = await fetchPage(url, { renderJs: false });

// Force Playwright for complex sites (BroadwayWorld auto-detects)
const result = await fetchPage(url, { preferPlaywright: true });
```

### When to Use Each Method

**Bright Data (automatic first choice):**
- ✅ Broadway.org
- ✅ Playbill.com
- ✅ Most Broadway sites
- ✅ Review aggregators (DTLI, Show Score, BWW)

**ScrapingBee (automatic fallback):**
- ✅ Backup when Bright Data fails
- ✅ Sites with moderate JavaScript

**Playwright (automatic last resort or explicit):**
- ✅ BroadwayWorld (complex JavaScript)
- ✅ Sites requiring browser behavior
- ✅ Sites with aggressive bot detection

## Environment Variables

Set these in GitHub Secrets for Actions, or in `.env` for local development:

```bash
# Primary scraping service
BRIGHTDATA_TOKEN=your-token-here

# Fallback scraping service
SCRAPINGBEE_API_KEY=your-key-here
```

**Note:** Playwright requires no API keys, but is slower and requires npm package installation.

## Return Format

All methods return:

```typescript
{
  content: string,           // Page content (HTML or markdown)
  format: 'html' | 'markdown',  // Content format
  source: string             // Which service was used
}
```

### Handling Different Formats

**Markdown (from Bright Data):**
```javascript
const result = await fetchPage(url);
if (result.format === 'markdown') {
  // Extract titles using markdown syntax
  const titles = result.content.match(/\[([^\]]+)\]\([^)]+\)/g);
}
```

**HTML (from ScrapingBee or Playwright):**
```javascript
const result = await fetchPage(url);
if (result.format === 'html') {
  // Extract titles using regex or JSDOM
  const titles = result.content.match(/<h2[^>]*>([^<]+)<\/h2>/g);
}
```

## Error Handling

The module tries all available methods before failing:

```javascript
try {
  const result = await fetchPage(url);
  // Success - result contains page data
} catch (error) {
  // All methods failed
  console.error('Scraping failed:', error.message);
  // Possible reasons:
  // - No API keys configured
  // - Site is blocking all methods
  // - Network error
}
```

## Cleanup

**Always call `cleanup()` when done:**

```javascript
const { fetchPage, cleanup } = require('./lib/scraper');

async function main() {
  try {
    // Your scraping code
    await fetchPage(url1);
    await fetchPage(url2);
  } finally {
    // Close Playwright browser if it was used
    await cleanup();
  }
}
```

This prevents zombie browser processes.

## Examples

### Discover Shows Script

```javascript
const { fetchPage, cleanup } = require('./lib/scraper');

async function discoverShows() {
  try {
    // Fetch Broadway.org listings
    const result = await fetchPage('https://www.broadway.org/shows/');

    // Parse shows (works with both HTML and markdown)
    const shows = parseShows(result.content);

    return shows;
  } finally {
    await cleanup();
  }
}
```

### Check Closing Dates Script

```javascript
const { fetchPage, cleanup } = require('./lib/scraper');

async function checkClosingDates() {
  try {
    // Fetch page without JS rendering (faster)
    const result = await fetchPage(
      'https://www.broadway.org/shows/',
      { renderJs: false }
    );

    // Extract closing dates
    const dates = extractClosingDates(result.content);

    return dates;
  } finally {
    await cleanup();
  }
}
```

### BroadwayWorld Grosses (Force Playwright)

```javascript
const { fetchPage, cleanup } = require('./lib/scraper');

async function scrapeGrosses() {
  try {
    // BroadwayWorld auto-detects need for Playwright
    const result = await fetchPage('https://www.broadwayworld.com/grosses.cfm');

    // Or force it explicitly
    const result2 = await fetchPage(
      'https://www.broadwayworld.com/grosses.cfm',
      { preferPlaywright: true }
    );

    return parseGrosses(result.content);
  } finally {
    await cleanup();
  }
}
```

## Troubleshooting

### "All scraping methods failed"

1. Check environment variables are set
2. Check API keys are valid
3. Try forcing Playwright: `{ preferPlaywright: true }`

### "Bright Data returns error"

- Fallback to ScrapingBee happens automatically
- Check if BRIGHTDATA_TOKEN is valid

### "ScrapingBee returns 431 error"

- This is a known MCP issue, doesn't affect GitHub Actions
- Script will fall back to Playwright automatically

### Page content is incomplete

- Some sites need JavaScript: try without `{ renderJs: false }`
- Try forcing Playwright for complex sites

## Cost Tracking

| Service | Free Tier | Cost Per Request | Your Usage |
|---------|-----------|------------------|------------|
| Bright Data | TBD | TBD | ~100 requests/year |
| ScrapingBee | 1,000/month | 1 credit | Fallback only |
| Playwright | Unlimited | $0 | Last resort |

All services are free for your current usage volume.

## GitHub Actions Integration

The scraper works seamlessly in GitHub Actions:

```yaml
- name: Discover new shows
  env:
    BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}
    SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
  run: node scripts/discover-new-shows.js
```

No special setup needed - the module handles everything.
