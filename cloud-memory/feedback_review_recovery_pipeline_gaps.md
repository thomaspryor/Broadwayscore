---
name: Review recovery pipeline has silent failure modes
description: "Run verify-review-recovery.js; 5 steps silently fail independently."
type: feedback
originSessionId: 6f6ec6e9-314d-4991-b964-0e4933c915b2
---
When freeing a review to be scored/collected/go live, the pipeline has 5 steps that
each silently fail independently:

1. **Fix the review-text file** (clear flag, create stub, update URL)
2. **Push to review-texts repo** (fails silently if parallel session creates conflicts)
3. **Collect/scrape content** (collect-review-texts fills fullText)
4. **LLM score the review** (LLM Ensemble Score Reviews workflow)
5. **Rebuild reviews.json + deploy** (Refresh Review Data → Deploy to Vercel)

**Failure modes observed (Mamma Mia WE, 2026-04-12):**
- Step 2: `git stash pop` left conflict markers in 5 JSON files. They pushed to
  remote as broken JSON. The LLM scoring workflow silently skipped them (invalid
  JSON parse) — no error reported, just fewer reviews scored.
- Step 4: Two scoring runs shared a concurrency group — first was cancelled by
  the second. Had to retrigger manually.
- Step 5: Refresh ran before scoring finished → deployed stale data. Had to
  retrigger refresh after scoring completed.

**Why:** Each step is a separate workflow/script with no end-to-end verification.
There's no "did the review actually make it to production?" check.

**How to apply:** After any manual review recovery, run this verification chain:
```bash
# 1. Verify review-text file is valid JSON
node -e "JSON.parse(require('fs').readFileSync('FILE'))"

# 2. Verify no conflict markers
grep -l "<<<<<<" data/review-texts/SHOW_ID/*.json

# 3. After scoring: verify assignedScore or llmScore exists
node -e "const d=JSON.parse(require('fs').readFileSync('FILE')); console.log('scored:', !!d.llmScore)"

# 4. After rebuild: verify review appears in reviews.json
node -e "const r=require('./data/reviews.json').reviews.filter(x=>x.showId==='SHOW_ID'); console.log(r.length, 'reviews')"

# 5. After deploy: verify on production
curl -sL "https://broadwayscorecard.com/show/SLUG" | grep -oE '"reviewCount":[0-9]+'
```

**Ideal fix:** A `scripts/verify-review-recovery.js --show=SHOW_ID` script that runs
all 5 checks and reports which step failed. Would save 30+ min of debugging per recovery.
