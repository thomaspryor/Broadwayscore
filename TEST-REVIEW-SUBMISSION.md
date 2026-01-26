# Testing the Submit Missing Review Feature

This guide shows you how to test the review submission validation system locally.

## Setup

The test script requires the Anthropic API key. Make sure it's set in your GitHub Secrets:
- `ANTHROPIC_API_KEY` - Already configured in your repository

## Test Script

Use the test script to validate review URLs without creating real GitHub issues:

```bash
node scripts/test-review-submission.js <review-url> [show-name] [outlet-name] [critic-name]
```

## Test Cases

### ✅ Valid Submissions (Should Approve)

#### 1. Recent NYT Review of Stereophonic
```bash
node scripts/test-review-submission.js \
  "https://www.nytimes.com/2024/04/18/theater/stereophonic-review.html" \
  "Stereophonic"
```

#### 2. Variety Review of Hamilton
```bash
node scripts/test-review-submission.js \
  "https://variety.com/2015/legit/reviews/hamilton-review-broadway-1201556666/" \
  "Hamilton" \
  "Variety"
```

#### 3. Vulture Review of Cabaret
```bash
node scripts/test-review-submission.js \
  "https://www.vulture.com/article/cabaret-broadway-review.html" \
  "Cabaret" \
  "Vulture"
```

### ❌ Invalid Submissions (Should Reject)

#### 4. Duplicate Review (Already in Database)
```bash
# Test with a review that's already in your database
# Check data/reviews.json for an existing URL and try it
node scripts/test-review-submission.js \
  "<url-from-reviews.json>"
```

#### 5. Not a Review (News Article)
```bash
node scripts/test-review-submission.js \
  "https://www.nytimes.com/2024/01/15/theater/broadway-ticket-sales.html"
```

#### 6. Off-Broadway Show (Not in Database)
```bash
node scripts/test-review-submission.js \
  "https://www.nytimes.com/2024/03/10/theater/some-off-broadway-show-review.html" \
  "Some Off-Broadway Show"
```

#### 7. Invalid URL
```bash
node scripts/test-review-submission.js \
  "not-a-valid-url"
```

#### 8. Listicle/Roundup (Not a Single Review)
```bash
node scripts/test-review-submission.js \
  "https://www.timeout.com/newyork/theater/best-broadway-shows"
```

## Test via GitHub Issues (Real Workflow)

To test the full automation pipeline:

1. **Go to GitHub Issues**: https://github.com/thomaspryor/Broadwayscore/issues/new/choose

2. **Select "Submit Missing Review"** template

3. **Fill in the form** with test data:
   - Review URL: Use one of the test cases above
   - Show Name: Optional
   - Outlet Name: Optional

4. **Submit** and watch the automation:
   - Within ~1 minute, you'll see a comment with validation results
   - Labels will be added automatically (`validated`, `approved`, or `invalid`)
   - If approved, scraping starts automatically
   - Issue closes when complete

5. **Check the results**:
   - Approved reviews are added to `data/review-texts/{show-id}/`
   - `data/reviews.json` is updated
   - Vercel auto-deploys the updated site

## What the Validation Checks

The AI validator checks:

1. ✓ **Valid URL** - Is it a properly formatted, accessible URL?
2. ✓ **Is a Review** - Not a news article, listicle, or aggregator page
3. ✓ **Broadway Show** - Not Off-Broadway, regional, touring, or international
4. ✓ **Show in Database** - Can match the show to our database
5. ✓ **Legitimate Outlet** - Recognized theater publication or major media
6. ✓ **Not Duplicate** - Doesn't already exist in our database

## Expected Output

The test script outputs:

```
╔══════════════════════════════════════════════════════════════╗
║                    VALIDATION RESULT                         ║
╚══════════════════════════════════════════════════════════════╝

📊 Recommendation: APPROVE

💭 Reasoning: This is a professional critic review from The New York Times...

🔍 Validation Details:
   ✅ isValidUrl: true
   ✅ isReview: true
   ✅ isBroadway: true
   ✅ showInDatabase: true
   ✅ isLegitimateOutlet: true

📝 Extracted Data:
   Show Title: Stereophonic
   Show ID: stereophonic-2024
   Outlet: The New York Times
   Outlet ID: nytimes
   Critic: Jesse Green

🎭 Matched Show: Stereophonic (stereophonic-2024)
```

## Troubleshooting

### "ANTHROPIC_API_KEY not set"
The API key is only available in GitHub Actions. To test locally, you'd need to temporarily set it as an environment variable (not recommended for security).

### "Could not parse Claude response"
The AI response wasn't in the expected JSON format. This usually means the API had an issue. Try again.

### "No duplicates found" but review exists
The duplicate checker looks in:
- `data/reviews.json` (by URL)
- `data/review-texts/{show-id}/` (by URL in individual files)

If a review exists but isn't detected, check if the URL format matches exactly.

## Next Steps

Once you've tested and verified the system works:

1. **Share the submission page** with your users: https://broadwayscorecard.vercel.app/submit-review
2. **Monitor GitHub Issues** for new submissions
3. **Review rejections** - Some might need manual approval
4. **Celebrate contributions!** - Users are helping grow your database

## Notes

- The test script runs the exact same validation logic as the GitHub Action
- Test cases help verify edge cases before real users submit
- The AI is quite good at detecting non-review content (news, listicles, etc.)
- Duplicate detection is strict - even different URL formats for the same review will be caught
