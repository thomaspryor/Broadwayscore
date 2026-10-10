---
name: Opening Night Pipeline Workarounds
description: "Cancel CI → local rebuild → push data repo → deploy. Full commands inside."
type: reference
originSessionId: 26113e5f-4a32-4e70-b3a7-709f84a7cbc3
archived: true
---
## The Problem
Opening night pollers trigger rebuilds every 20 min. Each new rebuild cancels the pending one. CI rebuilds check out review-texts at startup, so they often have stale data. Result: 30-60 min from scored reviews to live site.

## Workarounds (in order of use)

### 1. Cancel competing CI jobs before deploying
```bash
for id in $(gh run list --workflow=rebuild-reviews.yml --limit=5 --json databaseId,status -q '.[] | select(.status=="in_progress" or .status=="pending") | .databaseId'); do
  gh run cancel $id
done
# Also cancel scoring runs that would trigger more rebuilds
for id in $(gh run list --workflow=llm-ensemble-score.yml --limit=5 --json databaseId,status -q '.[] | select(.status=="in_progress" or .status=="pending") | .databaseId'); do
  gh run cancel $id
done
gh workflow run rebuild-fast.yml -f reason="opening night"
```

### 2. Rebuild locally + push reviews.json directly
```bash
node scripts/rebuild-all-reviews.js
node -e "require('fs').writeFileSync('/Users/tompryor/broadway-scorecard-data/reviews.json', require('fs').readFileSync('data/reviews.json'))"
git -C /Users/tompryor/broadway-scorecard-data add reviews.json && git commit -m "local rebuild" && git push origin main
gh workflow run vercel-deploy.yml
```

### 3. Score locally (single-model, fast)
```bash
source .env && export $(grep ANTHROPIC_API_KEY .env) && export $(grep OPENAI_API_KEY .env) && export $(grep GEMINI_API_KEY .env)
npx ts-node scripts/llm-scoring/index.ts --show=SHOW_ID --unscoredOnly --limit=20
```

### 4. Collect text locally when CI collection fails
Clear blockers first, then collect:
```bash
# Clear incompleteReason + wrongProduction
node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(FILE,'utf8')); delete d.incompleteReason; delete d.wrongProduction; fs.writeFileSync(FILE,JSON.stringify(d,null,2)+'\n')"
# Collect
source .env && SHOW_FILTER=show-id MAX_REVIEWS=5 node scripts/collect-review-texts.js --aggressive
```
For Guardian: BD returns empty, use ScrapingBee directly.

### 5. humanReviewScore for instant corrections
```bash
node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(FILE,'utf8')); d.humanReviewScore=70; d.humanReviewNote='reason'; fs.writeFileSync(FILE,JSON.stringify(d,null,2)+'\n')"
```

### 6. Push order matters
review-texts repo FIRST → then data repo → then deploy. If data repo first, CI rebuild overwrites it.

### 7. Safe sync pattern — NEVER reset + rsync
When push to `~/broadway-review-texts` or `~/broadway-scorecard-data` is rejected, **do NOT** run `git reset --hard origin/main && rsync`. That wipes CI-added fields (llmScore, ensembleData, pullQuote, etc.) that landed between pulls. Wiped 5 fresh LLM scores on 2026-04-22 Beaches opening.

Use the canonical helper instead:
```bash
# From the Broadwayscore repo:
bash scripts/lib/safe-sync-review-texts.sh ~/broadway-review-texts
bash scripts/lib/safe-sync-review-texts.sh ~/broadway-scorecard-data
```
It pulls with `git rebase -X theirs`, runs `restore-protected-fields.js` against `origin/main` to restore anything the rebase dropped, then pushes. Refuses to proceed on unresolvable conflicts — resolve per-file, don't reset.

## Root Causes to Fix
- rebuild-reviews and rebuild-fast share concurrency group → need separate groups
- Pipeline is 4 sequential workflows → need single opening-night-express.yml
- restore-protected-fields overwrites fresh text with old wrongProd content
- incompleteReason blocks re-collection even after wrongProd cleared
