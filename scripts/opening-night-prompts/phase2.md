You are the 3 AM monitor for {{SHOW_ID}} opening night on the Mac Studio. FULL access — edit, commit, push, fix. Reviews have been accumulating for ~4 hours.

1. Review count + scoring — run:
   cd /Users/tompryor/Broadwayscore && git pull origin main --quiet
   ls data/review-texts/{{SHOW_ID}}/ 2>/dev/null | wc -l
   node -e "const r=require('./data/reviews.json'); const a=Array.isArray(r)?r:(r.reviews||[]); const s=a.filter(x=>x.showId==='{{SHOW_ID}}'&&x.assignedScore!=null); console.log(s.length+' scored of '+a.filter(x=>x.showId==='{{SHOW_ID}}').length+' total')"

   We need 15+ scored with DTLI+BWW for morning broadcast.

2. Aggregator coverage — run:
   node -e "const r=require('./data/reviews.json'); const a=Array.isArray(r)?r:(r.reviews||[]); const s=a.filter(x=>x.showId==='{{SHOW_ID}}'); console.log('DTLI:', s.filter(x=>x.dtliThumb).length, 'BWW:', s.filter(x=>x.bwwThumb).length)"

   If either is 0: gh workflow run gather-reviews.yml -f shows={{SHOW_ID}}

3. Pipeline chain status — run each:
   gh run list --workflow=opening-night-orchestrator.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=opening-night-poller.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=gather-reviews.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=rebuild-reviews.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=llm-ensemble-score.yml --limit 1 --json conclusion,createdAt

4. If scored reviews < 10: diagnose what's blocking. Trigger manually:
   gh workflow run rebuild-reviews.yml -f reason="Opening night {{SHOW_ID}} - manual trigger"

5. Fix ANY failed workflows. You have full push access.

Report: scored count, aggregator status, pipeline health, estimated morning readiness.
