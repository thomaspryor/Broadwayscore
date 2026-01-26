# Quick Testing Guide - Submit Missing Review

## Easiest Way to Test (No Setup Required!)

### Option 1: Test via GitHub Actions UI (Recommended)

This method requires **zero setup** - just use the GitHub web interface:

1. **Go to Actions tab**: https://github.com/thomaspryor/Broadwayscore/actions

2. **Select "Test Review Validation"** workflow from the left sidebar

3. **Click "Run workflow"** button (top right)

4. **Fill in the form**:
   - Review URL: `https://www.nytimes.com/2024/04/18/theater/stereophonic-review.html`
   - Show name: `Stereophonic` (optional)
   - Leave other fields blank

5. **Click "Run workflow"**

6. **Watch the results** (takes ~30 seconds):
   - Click on the workflow run that appears
   - Click on "test-validation" job
   - Expand "Run test validation" step
   - See the formatted validation output

### Option 2: Test via Real GitHub Issue

This tests the **full automation pipeline** including scraping:

1. **Create a test issue**: https://github.com/thomaspryor/Broadwayscore/issues/new?template=missing-review.yml

2. **Fill in the form** with a test review:
   ```
   Review URL: https://www.vulture.com/article/cabaret-broadway-review.html
   Show Name: Cabaret
   ```

3. **Submit** and watch the magic:
   - Within 1 minute, a comment appears with validation results
   - If approved, scraping starts automatically
   - Review is added to database
   - Issue closes when complete
   - Site auto-deploys with new review

## Test Cases to Try

### ✅ Should APPROVE

**Test 1: Recent Broadway review**
- URL: `https://www.nytimes.com/2024/04/18/theater/stereophonic-review.html`
- Show: `Stereophonic`
- Expected: ✅ Approved - valid Broadway review

**Test 2: Variety review**
- URL: `https://variety.com/2015/legit/reviews/hamilton-review-broadway-1201556666/`
- Show: `Hamilton`
- Expected: ✅ Approved - legitimate outlet

### ❌ Should REJECT

**Test 3: News article (not a review)**
- URL: `https://www.nytimes.com/2024/01/15/theater/broadway-ticket-sales.html`
- Expected: ❌ Rejected - not a review

**Test 4: Listicle/roundup**
- URL: `https://www.timeout.com/newyork/theater/best-broadway-shows`
- Expected: ❌ Rejected - aggregator page, not single review

**Test 5: Invalid URL**
- URL: `not-a-real-url`
- Expected: ❌ Rejected - invalid URL format

## What You'll See

### Approved Submission
```
✅ Submission Approved!

Extracted Information
- Show: Stereophonic
- Outlet: The New York Times
- Critic: Jesse Green

Next Steps
Our automated system will now:
1. Scrape the review content from the provided URL
2. Extract the review score and text
3. Add it to our database
4. Trigger a site rebuild
```

### Rejected Submission
```
❌ Submission Rejected

Reason: This appears to be a news article about Broadway
ticket sales, not a review of a specific show.

Validation Details
- isValidUrl: ✓
- isReview: ✗
- isBroadway: ✓
- isLegitimateOutlet: ✓
- showInDatabase: ✗
```

## Monitoring Active Submissions

**View all review submissions**:
- https://github.com/thomaspryor/Broadwayscore/issues?q=is%3Aissue+label%3Areview-submission

**Filter by status**:
- Pending validation: `label:needs-validation`
- Approved: `label:approved`
- Rejected: `label:invalid`
- Needs manual review: `label:needs-manual-review`

## What Happens After Approval

1. **Scraping** (~30 seconds)
   - Uses your subscriptions for paywalled sites (NYT, Vulture)
   - Falls back to specialized scraping tools if needed

2. **Database Update** (~5 seconds)
   - Review added to `data/review-texts/{show-id}/`
   - `data/reviews.json` updated

3. **Deployment** (~1 minute)
   - Changes pushed to main branch
   - Vercel auto-deploys
   - New review visible on site

4. **Issue Closed**
   - Success comment posted
   - Issue automatically closed

Total time: **~2 minutes** from submission to live on site!

## Troubleshooting

### "Workflow not found"
The workflow file needs to be pushed to main first. Check if `.github/workflows/test-review-validation.yml` exists in your repo.

### "No permissions to run workflow"
You need write access to the repository to manually trigger workflows.

### "Validation taking too long"
GitHub Actions can sometimes queue jobs if runners are busy. Usually resolves within 2-3 minutes.

### "Scraping failed after approval"
Some sites block scraping or require special handling. These get flagged with `scraping-failed` label for manual review.

## Next Steps

Once you've tested and it works:

1. ✅ The `/submit-review` page is live on your site
2. ✅ Anyone can submit reviews (no account required)
3. ✅ Validation and scraping happen automatically
4. ✅ You get notifications via GitHub for each submission

Share the submission page with your community:
**https://broadwayscorecard.vercel.app/submit-review**
