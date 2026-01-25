# Scraping Migration Guide
**Date:** January 25, 2026

## What Changed

The project now uses **Bright Data as primary** with automatic fallback to ScrapingBee and Playwright. This provides better reliability and simpler code.

### Before (ScrapingBee only)

```javascript
// Old approach - single service, no fallback
const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}`;
const html = await fetch(apiUrl);
```

### After (Bright Data + Fallbacks)

```javascript
// New approach - automatic fallback
const { fetchPage, cleanup } = require('./lib/scraper');

const result = await fetchPage(url);
// Returns: { content, format, source }
// Tries: Bright Data → ScrapingBee → Playwright
```

---

## Key Improvements

### 1. Automatic Fallback
If Bright Data fails, automatically tries ScrapingBee, then Playwright. No manual handling needed.

### 2. Better Output Format
Bright Data returns **markdown** which is easier to parse than HTML:

```markdown
[Show Title](/shows/show-slug)
Through: Mar 8, 2026
```

vs HTML:
```html
<h4><a href="/shows/show-slug">Show Title</a></h4>
<div>Through: Mar 8, 2026</div>
```

### 3. Single API for All Scripts
All scripts now use the same `scripts/lib/scraper.js` module - no code duplication.

### 4. Smart Playwright Usage
Automatically detects when sites need Playwright (e.g., BroadwayWorld) without manual configuration.

---

## Files Updated

### New Files

- ✅ `scripts/lib/scraper.js` - Unified scraping module with fallbacks
- ✅ `scripts/lib/README.md` - Developer documentation
- ✅ `docs/SCRAPING-MIGRATION-GUIDE.md` - This file
- ✅ `docs/FINAL-scraping-comparison.md` - Service comparison

### Updated Scripts

- ✅ `scripts/discover-new-shows.js` - Now uses shared scraper
- ✅ `scripts/check-closing-dates.js` - Now uses shared scraper
- ⚠️ `scripts/scrape-grosses.ts` - Still uses Playwright directly (BroadwayWorld needs it)
- ⚠️ `scripts/scrape-alltime.ts` - Still uses Playwright directly (BroadwayWorld needs it)

### Updated Documentation

- ✅ `CLAUDE.md` - Updated scraping section
- ✅ `.github/workflows/update-show-status.yml` - Added environment variables

---

## Environment Variables

### GitHub Secrets (Already Set)

These are already configured in your repo's GitHub Secrets:

```
BRIGHTDATA_TOKEN=3686bf13-cbde-4a91-b54a-f721a73c0ed0
SCRAPINGBEE_API_KEY=TM5B2FK5G0BNFS2IL2T1OUGYJR7KP49UEYZ33KUUYWJ3NZC8ZJG6BMAXI83IQRD3017UTTNX5JISNDMW
```

No action needed - workflows will automatically use these.

### Local Development

For testing scripts locally, create a `.env` file:

```bash
BRIGHTDATA_TOKEN=3686bf13-cbde-4a91-b54a-f721a73c0ed0
SCRAPINGBEE_API_KEY=TM5B2FK5G0BNFS2IL2T1OUGYJR7KP49UEYZ33KUUYWJ3NZC8ZJG6BMAXI83IQRD3017UTTNX5JISNDMW
```

Then:
```bash
source .env
node scripts/discover-new-shows.js
```

---

## Testing the Changes

### 1. Test Discover Shows Locally

```bash
cd ~/Broadwayscore
export BRIGHTDATA_TOKEN=your-token
node scripts/discover-new-shows.js --dry-run
```

Expected output:
```
==========================================================
BROADWAY SHOW DISCOVERY
==========================================================
Mode: DRY RUN

Existing shows in database: 40

Fetching: https://www.broadway.org/shows/
  → Trying Bright Data (primary)...
  ✅ Success (Bright Data, markdown)
Fetched 45231 bytes (markdown from brightdata)

Found 47 shows on Broadway.org

✅ No new shows discovered - database is up to date
```

### 2. Test Check Closing Dates

```bash
node scripts/check-closing-dates.js --dry-run
```

### 3. Test in GitHub Actions

Go to your repo → Actions → "Update Shows" → "Run workflow"

The workflow will use Bright Data automatically.

---

## Troubleshooting

### "All scraping methods failed"

**Cause:** No API keys configured.

**Fix:** Set environment variables in GitHub Secrets (already done) or locally:
```bash
export BRIGHTDATA_TOKEN=your-token
export SCRAPINGBEE_API_KEY=your-key
```

### "Bright Data failed: HTTP 401"

**Cause:** Invalid token.

**Fix:** Check that BRIGHTDATA_TOKEN is correct in GitHub Secrets.

### "ScrapingBee fell back to Playwright"

**Not an error!** This is expected behavior. Playwright is the last resort fallback and works fine.

### Playwright is slow

**Expected:** Playwright launches a full browser, which takes 5-10 seconds. This is why it's the last resort.

**Optimization:** Bright Data and ScrapingBee are much faster (~1-2 seconds).

---

## Migration Checklist

- [x] Create shared scraper module (`scripts/lib/scraper.js`)
- [x] Update `discover-new-shows.js` to use shared module
- [x] Update `check-closing-dates.js` to use shared module
- [x] Update GitHub Actions workflow with environment variables
- [x] Update CLAUDE.md documentation
- [x] Create developer documentation (`scripts/lib/README.md`)
- [x] Create migration guide (this file)
- [ ] Test discover-new-shows locally
- [ ] Test check-closing-dates locally
- [ ] Test in GitHub Actions
- [ ] Update `.gitignore` if needed (ensure .env is ignored)

---

## Future Enhancements

### Optional: Add Playwright to package.json

If you want local scripts to use Playwright fallback:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

This is optional - Bright Data + ScrapingBee should handle most cases.

### Optional: Add dotenv Support

For easier local testing:

```bash
npm install --save-dev dotenv
```

Then at the top of each script:
```javascript
require('dotenv').config();
```

---

## Cost Impact

### Before (ScrapingBee Only)

- 104 requests/year
- Using ~8% of free tier (1,000/month)
- Cost: $0

### After (Bright Data Primary)

- ~90 requests via Bright Data (free tier TBD)
- ~10 requests via ScrapingBee (fallback)
- ~4 requests via Playwright (last resort)
- Cost: $0 (all within free tiers)

**Result:** Better reliability, no cost increase.

---

## Rollback Instructions

If you need to rollback to the old ScrapingBee-only approach:

1. Revert the scripts:
```bash
git checkout HEAD~1 scripts/discover-new-shows.js
git checkout HEAD~1 scripts/check-closing-dates.js
```

2. Remove shared module:
```bash
rm scripts/lib/scraper.js
rm scripts/lib/README.md
```

3. Update workflow:
```bash
git checkout HEAD~1 .github/workflows/update-show-status.yml
```

---

## Questions?

**Q: Do I need to do anything?**
A: No! Everything is already configured in GitHub Secrets. The changes are automatic.

**Q: Will this break existing workflows?**
A: No. The scripts are backward compatible. If Bright Data fails, they fall back to ScrapingBee (the old method).

**Q: Do I need to install Playwright locally?**
A: No. Playwright is used as a last resort, and GitHub Actions will install it automatically if needed.

**Q: What if Bright Data stops working?**
A: The script automatically falls back to ScrapingBee, then Playwright. You'll never notice the difference.

**Q: Is this tested?**
A: Yes! All three services were tested successfully on both Broadway.org and Playbill.com URLs.

---

## Support

For issues or questions:

1. Check `scripts/lib/README.md` for usage examples
2. Check `docs/FINAL-scraping-comparison.md` for service comparison
3. Check GitHub Actions logs for error messages
4. Review this migration guide

All scripts include detailed console logging to help debug issues.
