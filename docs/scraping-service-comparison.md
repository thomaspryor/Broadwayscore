# Broadway Scraping Service Comparison
**Test Date:** January 25, 2026

## Executive Summary

**Winner: Playwright MCP** - Successfully scraped both Broadway listing pages with full data extraction. ScrapingBee failed on both URLs with 431 (Request Header Fields Too Large) errors.

---

## Test URLs

1. **Broadway.org** - https://www.broadway.org/shows/ (Official Broadway League listings)
2. **Playbill.com** - https://playbill.com/productions?t=broadway (Industry standard listings)

---

## Results

### ScrapingBee MCP (via MCP Server)
**Status:** ❌ FAILED

Both URLs returned identical errors:
```
Error 431: Request Header Fields Too Large
Error parsing headers: 'limit request headers fields size'
```

**Analysis:**
- ScrapingBee's MCP implementation appears to send oversized headers
- This is a known issue when MCP servers add authentication tokens and metadata
- Not usable for these critical Broadway listing pages

---

### Playwright MCP
**Status:** ✅ SUCCESS

#### Broadway.org Results
```json
{
  "source": "Broadway.org",
  "total": 47,
  "withClosingDates": 22,
  "withOpeningDates": 16,
  "sample": [
    {
      "title": "Aladdin"
    },
    {
      "title": "All Out: Comedy About Ambition",
      "closingDate": "Mar 8, 2026"
    },
    {
      "title": "& Juliet"
    },
    {
      "title": "The Balusters",
      "openingDate": "Mar 31, 2026",
      "closingDate": "May 24, 2026"
    },
    {
      "title": "Beaches, A New Musical",
      "openingDate": "Mar 27, 2026",
      "closingDate": "Sep 6, 2026"
    }
  ]
}
```

#### Playbill.com Results
```json
{
  "source": "Playbill.com",
  "total": 32,
  "withClosingDates": 6,
  "sample": [
    {
      "title": "& Juliet"
    },
    {
      "title": "Aladdin"
    },
    {
      "title": "All Out: Comedy About Ambition",
      "closingDate": "Mar 8, 2026"
    },
    {
      "title": "Buena Vista Social Club"
    }
  ]
}
```

**Performance:**
- Pages loaded in ~1-2 seconds each
- JavaScript executed correctly
- Clean data extraction via DOM queries
- No blocking or rate limiting issues

---

## Recommendations

### 1. Use Playwright for GitHub Actions Scripts

Update the following scripts to use Playwright instead of ScrapingBee:

- `scripts/discover-new-shows.js` - Show discovery from Broadway.org
- `scripts/check-closing-dates.js` - Monitoring closing date changes
- Any script fetching Broadway.org or Playbill.com

### 2. Keep ScrapingBee for Specific Use Cases

ScrapingBee is still useful for:
- Review aggregator sites (DTLI, Show-Score, BWW) when they block Playwright
- Sites with aggressive bot detection
- Fallback option when Playwright is blocked

**Note:** Direct ScrapingBee API calls (not via MCP) may work better than the MCP server implementation.

### 3. Hybrid Approach

```javascript
// Recommended pattern for scripts
try {
  // Try Playwright first (faster, cheaper, more reliable)
  const data = await scrapeWithPlaywright(url);
} catch (error) {
  // Fall back to ScrapingBee if needed
  const data = await scrapeWithScrapingBee(url);
}
```

---

## Implementation Notes

### Broadway.org Data Structure
- **47 total shows** listed (mix of open + upcoming)
- **22 shows** have closing dates (limited runs)
- **16 shows** have opening dates (in previews/upcoming)
- Date format: "Mar 8, 2026", "Jun 14, 2026", etc.
- Shows without dates are open-ended runs

### Playbill.com Data Structure
- **32 currently running shows** (excludes some upcoming)
- **6 shows** display closing dates explicitly
- Format: "Closes Mar 8, 2026"
- More conservative about displaying closing dates

### Data Quality Notes
- Broadway.org is more comprehensive (includes more upcoming shows)
- Playbill.com is more conservative (only lists confirmed open shows)
- **Recommendation:** Use Broadway.org as primary source for show discovery

---

## Next Steps

1. ✅ **Document findings** (this file)
2. 🔄 **Update GitHub Actions workflows** to use Playwright
3. 🔄 **Rewrite show discovery scripts** with Playwright
4. 🔄 **Test Bright Data MCP** (requires new Claude session to load)
5. 📋 **Create fallback logic** for when Playwright fails

---

## Technical Details

### Playwright Extraction Code (Broadway.org)
```javascript
const shows = [];
const titles = document.querySelectorAll('main h4');

titles.forEach(h4 => {
  const title = h4.textContent.trim();
  let container = h4.closest('div').parentElement;
  if (!container) return;

  const show = { title };

  const allDivs = container.querySelectorAll('div');
  allDivs.forEach(div => {
    const text = div.textContent.trim();
    if (text.startsWith('Through:')) {
      show.closingDate = text.replace('Through:', '').trim();
    }
    if (text.startsWith('Begins:')) {
      show.openingDate = text.replace('Begins:', '').trim();
    }
  });

  shows.push(show);
});
```

### Playwright Extraction Code (Playbill.com)
```javascript
const shows = [];
const showContainers = document.querySelectorAll('[href*="/production/"]');
const seenTitles = new Set();

showContainers.forEach(link => {
  const container = link.closest('div').parentElement;
  if (!container) return;

  const titleLink = container.querySelector('a[href*="/production/"]:not([href*="maps.google"])');
  if (!titleLink) return;

  const title = titleLink.textContent.trim();
  if (seenTitles.has(title)) return;
  seenTitles.add(title);

  const show = { title };
  const containerText = container.textContent;
  const closesMatch = containerText.match(/Closes\s+([A-Za-z]+\s+\d+,\s+\d{4})/);
  if (closesMatch) {
    show.closingDate = closesMatch[1];
  }

  shows.push(show);
});
```

---

## Cost Comparison

### Playwright MCP
- **Cost:** FREE (runs locally)
- **Rate limits:** None
- **Credits:** N/A

### ScrapingBee
- **Cost:** 1 credit per request
- **Free tier:** 1,000 credits
- **Rate limits:** API-dependent
- **Current issue:** MCP 431 errors make it unusable for these URLs

**Savings:** Using Playwright saves 100% of scraping costs for Broadway.org and Playbill.com.
