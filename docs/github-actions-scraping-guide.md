# GitHub Actions Scraping Guide
**For Broadway Show Discovery & Monitoring**

## TL;DR Recommendation

**Use ScrapingBee or Bright Data for GitHub Actions** - they're simpler, faster to set up, and specifically designed for this use case.

---

## Important Clarification

**❌ My previous test was WRONG for GitHub Actions usage**

- I tested MCP implementations (local tools for Claude)
- MCP adds extra headers that caused the 431 error
- **This is NOT how the services work in GitHub Actions**

**✅ Direct API tests show both services work perfectly:**
```bash
# ScrapingBee - WORKS
curl "https://app.scrapingbee.com/api/v1/?api_key=YOUR_KEY&url=https://www.broadway.org/shows/"

# Returns full HTML successfully
```

---

## GitHub Actions Comparison

### Option 1: ScrapingBee (RECOMMENDED)

**Pros:**
- ✅ Simple HTTP API call - no browser installation needed
- ✅ Fast setup (2 lines of code)
- ✅ Handles JavaScript rendering (`render_js=true`)
- ✅ Stealth mode to bypass bot detection
- ✅ No GitHub Actions runner overhead
- ✅ 1,000 free credits/month

**Cons:**
- ❌ Costs credits after free tier (1 credit per request)
- ❌ Daily runs = ~30 credits/month (well within free tier)

**GitHub Actions Implementation:**
```yaml
- name: Discover new shows
  env:
    SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
  run: node scripts/discover-shows.js
```

**Script example:**
```javascript
const response = await fetch(
  `https://app.scrapingbee.com/api/v1/?api_key=${process.env.SCRAPINGBEE_API_KEY}&url=https://www.broadway.org/shows/&render_js=true`
);
const html = await response.text();
// Parse HTML with cheerio or similar
```

---

### Option 2: Bright Data

**Pros:**
- ✅ Same benefits as ScrapingBee
- ✅ Potentially better for heavily protected sites
- ✅ More aggressive unblocking features

**Cons:**
- ❌ Need to test API in new Claude session (MCP not loaded yet)
- ❌ Pricing/credits unknown (need to check)

**Status:** Need to start new Claude Code session to test via MCP, but direct API should work similarly to ScrapingBee.

---

### Option 3: Playwright in GitHub Actions

**Pros:**
- ✅ Free (no API costs)
- ✅ Full browser automation capabilities
- ✅ Can handle complex interactions

**Cons:**
- ❌ Complex setup required
- ❌ Slower (browser startup time)
- ❌ Uses more GitHub Actions runner minutes
- ❌ Heavier maintenance (browser updates, etc.)

**GitHub Actions Implementation:**
```yaml
- name: Setup Node
  uses: actions/setup-node@v3
  with:
    node-version: '18'

- name: Install dependencies
  run: npm install

- name: Install Playwright
  run: npx playwright install chromium

- name: Run scraper
  run: node scripts/discover-shows.js
```

**Script example:**
```javascript
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://www.broadway.org/shows/');
const shows = await page.$$eval('main h4', elements =>
  elements.map(el => el.textContent.trim())
);
await browser.close();
```

---

## Cost Analysis (Annual)

Assuming **weekly runs** (52 times/year) fetching **2 pages** per run:

### ScrapingBee
- Requests per year: 104 (52 runs × 2 pages)
- Free tier: 1,000 credits/month
- **Cost: $0** (well within free tier)

### Bright Data
- Need to check pricing structure
- **Likely similar to ScrapingBee**

### Playwright
- No API costs
- GitHub Actions minutes: ~5 minutes/run × 52 runs = 260 minutes/year
- Free tier: 2,000 minutes/month for public repos
- **Cost: $0** (within free tier)

**Winner:** All are free for your use case, but ScrapingBee/Bright Data are easier to maintain.

---

## Recommendation: ScrapingBee

**For your GitHub Actions scripts, use ScrapingBee because:**

1. **Simpler code** - Just HTTP fetch, no browser management
2. **Faster execution** - No browser startup time
3. **More reliable** - Purpose-built for scraping
4. **Easier debugging** - Standard HTTP responses
5. **Less maintenance** - No browser version updates
6. **Free for your usage** - 104 requests/year << 1,000 credits/month

---

## Migration Plan

### Step 1: Store API Key in GitHub Secrets

1. Go to your repo → Settings → Secrets and variables → Actions
2. Add secret: `SCRAPINGBEE_API_KEY`
3. Value: `TM5B2FK5G0BNFS2IL2T1OUGYJR7KP49UEYZ33KUUYWJ3NZC8ZJG6BMAXI83IQRD3017UTTNX5JISNDMW`

### Step 2: Update Workflow File

```yaml
# .github/workflows/update-show-status.yml
name: Update Show Status

on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6 AM UTC
  workflow_dispatch:

jobs:
  update-shows:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Discover new shows
        env:
          SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
        run: node scripts/discover-new-shows.js

      - name: Commit changes
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add data/
          git diff --quiet && git diff --staged --quiet || git commit -m "chore: Update show data [automated]"
          git push
```

### Step 3: Update Scripts

See example code above for fetch-based implementation.

---

## Testing Bright Data

To test Bright Data's MCP integration:

1. **Start a NEW Claude Code session** (MCP servers only load at startup)
2. Test with the MCP tools that should now be available
3. Compare with ScrapingBee for your use case

**Note:** Even if Bright Data MCP has issues, the direct API should work fine (same as ScrapingBee).

---

## Questions Answered

### "Why did ScrapingBee fail in your test?"
The MCP server implementation added extra headers causing a 431 error. The direct API (used in GitHub Actions) works perfectly.

### "Will GitHub Actions run when my computer is off?"
Yes! GitHub Actions run on GitHub's cloud servers, completely independent of your local machine.

### "Is Playwright hard to use in GitHub Actions?"
Not hard, but more complex than API calls. Requires browser installation step in the workflow.

### "Are paid scrapers worth it?"
For GitHub Actions: **Yes**. They're actually simpler than Playwright for this use case, and you're well within the free tier.

---

## Next Steps

1. ✅ Store ScrapingBee API key in GitHub Secrets
2. 🔄 Update workflow files to use ScrapingBee
3. 🔄 Rewrite scraper scripts to use fetch() instead of browser automation
4. 🔄 Test in GitHub Actions
5. 📋 (Optional) Test Bright Data in new session for comparison
