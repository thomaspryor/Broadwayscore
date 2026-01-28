# Review Collection Guide

**Last Updated:** January 27, 2026

This document captures everything learned about collecting Broadway show reviews, including common pitfalls and the correct workflows.

---

## Table of Contents

1. [Overview](#overview)
2. [The Three Aggregator Sources](#the-three-aggregator-sources)
3. [Critical: Show Score Carousel Issue](#critical-show-score-carousel-issue)
4. [Correct Workflow for Adding Shows](#correct-workflow-for-adding-shows)
5. [Common Pitfalls & Fixes](#common-pitfalls--fixes)
6. [Sanity Checks](#sanity-checks)
7. [Full Pipeline Script](#full-pipeline-script)
8. [Adding Historical Seasons](#adding-historical-seasons)

---

## Overview

We collect critic reviews from three aggregator sources, then deduplicate and score them:

| Source | Typical Reviews/Show | Best For |
|--------|---------------------|----------|
| **Show Score** | 19-20 avg (highest) | Recent shows, most comprehensive |
| **DTLI** | 16 avg | Historical shows, thumb ratings |
| **BWW Roundups** | 13 avg (lowest) | Supplementary coverage |

**Key Insight:** Show Score typically has the MOST reviews per show. If DTLI or BWW has more for a specific show, something is likely wrong with the Show Score collection.

---

## The Three Aggregator Sources

### 1. Show Score (show-score.com)
- **URL Pattern:** `show-score.com/broadway-shows/{slug}-broadway`
- **Data Provided:** Critic reviews with excerpts, audience scores
- **Critical Issue:** Uses a **carousel** that only shows 8 reviews initially
- **Solution:** Must use Playwright to scroll through ALL reviews

### 2. DTLI - Did They Like It (didtheylikeit.com)
- **URL Pattern:** `didtheylikeit.com/shows/{show-name}/`
- **Data Provided:** Critic reviews with excerpts, thumbs (Up/Down/Meh)
- **Coverage:** Excellent historical data back to ~2000s

### 3. BWW Review Roundups (BroadwayWorld)
- **URL Pattern:** `broadwayworld.com/article/...Reviews-{SHOW-NAME}...`
- **Data Provided:** Review roundups with excerpts, sometimes thumbs
- **Thumb Detection:** Check BOTH `alt="Thumbs Up"` AND image URL (`like-button-icon.png`)

---

## Critical: Show Score Carousel Issue

### The Problem

Show Score displays critic reviews in a **carousel/slider** that initially shows only 8 reviews. HTML archives only capture these first 8. A show with 44 reviews on Show Score would only yield 8 from the archive.

### The Solution

The `gather-reviews.yml` workflow uses **Playwright** to:
1. Navigate to the Show Score page
2. Scroll through the carousel to load ALL reviews
3. Extract every review

### How to Verify It's Working

Check the workflow log for lines like:
```
Show Score reports 44 critic reviews
Captured all 44 reviews (expected 44)
```

If you see a mismatch (e.g., "Captured 8 reviews (expected 44)"), the carousel scrolling failed.

### When This Goes Wrong

Reviews collected from HTML archives (without Playwright) will only have the first 8. Signs of this:
- Show Score source count much lower than DTLI/BWW
- `source: "show-score"` (archive) instead of `source: "show-score-playwright"`

---

## Correct Workflow for Adding Shows

### Step 1: Discover Shows

For new/upcoming shows:
```bash
# Runs daily automatically, or trigger manually:
gh workflow run "Update Show Status"
```

For historical seasons:
```bash
gh workflow run "Discover Historical Shows" --field seasons="2023-2024"
```

### Step 2: Gather Reviews (WITH CAROUSEL FIX)

**Critical:** Run `gather-reviews.yml` for EACH show individually to ensure carousel scrolling:

```bash
# For a single show:
gh workflow run "Gather Review Data" --field shows="show-id-2024"

# For multiple shows (one workflow each for parallel processing):
for show in show1 show2 show3; do
  gh workflow run "Gather Review Data" --field shows="$show"
done
```

**Do NOT** rely on HTML archives alone for Show Score data.

### Step 3: Wait for Workflows to Complete

```bash
# Check status:
gh run list --workflow="gather-reviews.yml" --limit 20

# Wait for all to complete:
while [ $(gh run list --workflow="gather-reviews.yml" --json status | grep -c '"in_progress"') -gt 0 ]; do
  echo "Waiting..."
  sleep 60
done
```

### Step 4: Pull and Verify

```bash
git pull origin main

# Check for gaps:
node /tmp/find-all-gaps.js  # Or use the sanity check script below
```

### Step 5: Deduplicate

```bash
node scripts/build-master-review-list.js
```

Expected dedup rate: ~35% (reviews appear on multiple aggregators)

### Step 6: Rebuild reviews.json

```bash
node scripts/rebuild-all-reviews.js
```

### Step 7: Validate

```bash
node scripts/validate-data.js
```

### Step 8: Commit and Push

```bash
git add data/
git commit -m "chore: Add reviews for [shows]"
git push origin main
```

### Step 9: Score Reviews

```bash
# Get shows needing scoring:
node /tmp/shows-needing-scoring.js

# Trigger scoring (one workflow per show for parallelism):
gh workflow run "LLM Ensemble Score Reviews" --field show="show-id"
```

---

## Common Pitfalls & Fixes

### Pitfall 1: Show Score Only Captures 8 Reviews

**Symptom:** Show Score source count is 8 or fewer for shows that should have 20+

**Cause:** Reviews collected from HTML archive, not via Playwright carousel scrolling

**Fix:** Re-run `gather-reviews.yml` for the affected shows:
```bash
gh workflow run "Gather Review Data" --field shows="affected-show-id"
```

### Pitfall 2: Duplicate Review Files

**Symptom:** Multiple files for same critic/outlet with different IDs:
- `thr--david-rooney.json`
- `hollywood-reporter--david.json`
- `hollywoodreporter-com--unknown.json`

**Cause:** Different sources use different outlet naming conventions

**Impact:** Deduplication handles this, but it inflates raw file counts

**Note:** This is expected behavior - the dedup process merges these

### Pitfall 3: Excerpt Saved as fullText

**Symptom:** `fullText` field contains short excerpt (<500 chars) with "Read more"

**Cause:** `gather-reviews.js` saves excerpt to fullText for newly discovered reviews

**Impact:** Low - these reviews still get scored, and real fullText exists in duplicate files

**Verification:**
```javascript
// Check for short fullTexts
const fs = require('fs');
// Reviews with fullText < 500 chars are likely excerpts
```

### Pitfall 4: BWW Thumbs Not Extracted

**Symptom:** BWW-sourced reviews missing `bwwThumb`

**Cause:** Older BWW archives (pre-2023) don't have thumb icons

**Also Check:** Thumb detection needs BOTH:
- `alt="Thumbs Up/Down/Sideways"` attribute
- Image URL containing `like-button-icon.png`, `midlike-button-icon.png`, `dislike-button-icon.png`

### Pitfall 5: Show Score URL Redirects

**Symptom:** Wrong show data collected (e.g., Off-Broadway show instead of Broadway)

**Cause:** URLs like `/broadway-shows/redwood` can redirect to `/off-off-broadway-shows/redwood`

**Fix:** The gather-reviews script checks for these redirects and rejects them

### Pitfall 6: Workflow Timeouts

**Symptom:** Workflows running 30+ minutes without completing

**Cause:** Shows with very large carousels (50+ reviews) or network issues

**Fix:**
1. Cancel stuck workflow: `gh run cancel <run-id>`
2. Re-run for that show individually

---

## Sanity Checks

### Check 1: Show Score vs Expected

Compare what Show Score reports vs what we collected:

```javascript
// /tmp/find-all-gaps.js
const fs = require('fs');
const path = require('path');

const archiveDir = 'data/aggregator-archive/show-score';
const reviewDir = 'data/review-texts';

fs.readdirSync(archiveDir)
  .filter(f => f.endsWith('.html'))
  .forEach(file => {
    const show = file.replace('.html', '');
    const html = fs.readFileSync(path.join(archiveDir, file), 'utf8');
    const match = html.match(/Critic Reviews \((\d+)\)/);
    if (!match) return;

    const ssReports = parseInt(match[1]);
    const dir = path.join(reviewDir, show);
    let weHave = 0;

    if (fs.existsSync(dir)) {
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
        .forEach(f => {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f)));
          if (d.source && d.source.includes('show-score')) weHave++;
        });
    }

    const gap = ssReports - weHave;
    if (gap > 0) {
      console.log(`${show}: SS=${ssReports}, we have=${weHave}, MISSING ${gap}`);
    }
  });
```

### Check 2: Average Reviews by Source

Show Score should have the highest average:

```javascript
// Expected averages:
// Show Score: ~19-20 per show (highest)
// DTLI: ~16 per show
// BWW: ~13 per show (lowest)
```

### Check 3: Coverage Stats

```javascript
// /tmp/coverage.js
const fs = require('fs');
const path = require('path');
const dir = 'data/review-texts';

let total = 0, withText = 0, withExcerptOnly = 0;

fs.readdirSync(dir).forEach(showDir => {
  const showPath = path.join(dir, showDir);
  if (!fs.statSync(showPath).isDirectory()) return;

  fs.readdirSync(showPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
    .forEach(f => {
      const d = JSON.parse(fs.readFileSync(path.join(showPath, f)));
      total++;
      if (d.fullText && d.fullText.length > 100) withText++;
      else if (d.dtliExcerpt || d.bwwExcerpt || d.showScoreExcerpt) withExcerptOnly++;
    });
});

console.log('Total reviews:', total);
console.log('With fullText:', withText, '(' + Math.round(100*withText/total) + '%)');
console.log('With excerpt only:', withExcerptOnly);
```

---

## Full Pipeline Script

Save as `/tmp/full-pipeline.sh` for automated processing:

```bash
#!/bin/bash
set -e

echo "=== FULL REVIEW COLLECTION PIPELINE ==="

# Step 1: Wait for any running gather-reviews to complete
echo "Step 1: Waiting for gather-reviews to complete..."
while [ $(gh run list --workflow="gather-reviews.yml" --json status | grep -c '"in_progress"') -gt 0 ]; do
  sleep 60
done

# Step 2: Pull latest data
echo "Step 2: Pulling latest data..."
git pull origin main

# Step 3: Run deduplication
echo "Step 3: Running deduplication..."
node scripts/build-master-review-list.js

# Step 4: Rebuild reviews.json
echo "Step 4: Rebuilding reviews.json..."
node scripts/rebuild-all-reviews.js

# Step 5: Validate
echo "Step 5: Validating..."
node scripts/validate-data.js

# Step 6: Commit
echo "Step 6: Committing..."
git add data/
git commit -m "chore: Rebuild reviews" || echo "No changes"
git push origin main

# Step 7: Trigger scoring
echo "Step 7: Triggering LLM scoring..."
# (Add scoring logic here)

echo "=== DONE ==="
```

---

## Adding Historical Seasons

### Recommended Approach

1. **One season at a time** - Start with most recent closed season
2. **Verify before moving on** - Run sanity checks after each season

### Step-by-Step

```bash
# 1. Discover shows from a historical season
gh workflow run "Discover Historical Shows" --field seasons="2023-2024"

# 2. Wait for discovery to complete
gh run list --workflow="discover-historical-shows.yml"

# 3. The workflow auto-triggers gather-reviews, but verify:
gh run list --workflow="gather-reviews.yml" --limit 50

# 4. After all complete, run sanity checks
git pull origin main
node /tmp/find-all-gaps.js

# 5. Re-run any shows with gaps
for show in $(node /tmp/find-all-gaps.js 2>/dev/null | grep "MISSING" | cut -d: -f1); do
  gh workflow run "Gather Review Data" --field shows="$show"
done

# 6. Run full pipeline (dedup, rebuild, score)
/tmp/full-pipeline.sh
```

### Expected Volume Per Season

- ~40-60 shows per season
- ~15-25 reviews per show average
- ~600-1,500 new reviews per season

### Seasons to Add (in order)

1. 2023-2024 (most recent closed)
2. 2022-2023
3. 2021-2022
4. 2020-2021 (limited - COVID)
5. 2019-2020 (partial - COVID shutdown)
6. Continue backwards as desired

---

## Key Metrics to Track

| Metric | Target | How to Check |
|--------|--------|--------------|
| Show Score coverage | 95%+ of reported | `node /tmp/find-all-gaps.js` |
| Dedup rate | ~35% | Output of `build-master-review-list.js` |
| Reviews with fullText | 70%+ | `node /tmp/coverage.js` |
| Reviews with score | 95%+ | `node /tmp/count-scoring.js` |

---

## Troubleshooting Commands

```bash
# Check workflow status
gh run list --workflow="gather-reviews.yml" --limit 20

# Check specific workflow log
gh run view <run-id> --log | grep -E "Show Score|carousel|Captured"

# Cancel stuck workflow
gh run cancel <run-id>

# Re-run failed workflow
gh workflow run "Gather Review Data" --field shows="show-id"

# Check which shows need scoring
node /tmp/shows-needing-scoring.js

# Check Show Score gap for specific show
grep "Critic Reviews" data/aggregator-archive/show-score/show-id.html
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `scripts/gather-reviews.js` | Main review collection script |
| `scripts/build-master-review-list.js` | Deduplication |
| `scripts/rebuild-all-reviews.js` | Rebuild reviews.json |
| `scripts/validate-data.js` | Data validation |
| `.github/workflows/gather-reviews.yml` | GitHub Action for collection |
| `.github/workflows/discover-historical-shows.yml` | Historical show discovery |
| `data/aggregator-archive/show-score/` | Show Score HTML archives |
| `data/review-texts/` | Individual review JSON files |
