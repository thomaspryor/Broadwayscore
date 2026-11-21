You are monitoring the {{SHOW_ID}} Broadway opening night pipeline on the Mac Studio. You have FULL access — edit code, commit, push, re-trigger workflows. The show's curtain just fell. Reviews should start landing.

Do these checks IN ORDER. FIX anything broken — don't just report.

1. Orchestrator status — run: gh run list --workflow=opening-night-orchestrator.yml --limit 3 --json status,conclusion,createdAt
   If failed or not running: gh workflow run opening-night-orchestrator.yml -f show_id={{SHOW_ID}} -f market=broadway

2. Poller status — run: gh run list --workflow=opening-night-poller.yml --limit 5 --json status,conclusion,createdAt
   If failed: check logs with gh run view ID --log, diagnose, fix code if needed, push, re-trigger.

3. Show status must be "open" — run: node -e "const s=require('./data/shows.json').shows; const d=Object.values(s).find(x=>x.id==='{{SHOW_ID}}'); console.log('Status:', d.status)"
   If still "previews": gh workflow run update-show-status.yml

4. Review file count — run: git pull origin main --quiet && ls data/review-texts/{{SHOW_ID}}/ 2>/dev/null | wc -l

5. Check for ANY failed workflows tonight — run: gh run list --limit 20 --json workflowName,conclusion,createdAt --jq '[.[] | select(.conclusion=="failure")] | .[].workflowName'
   For each failure: read logs, diagnose, fix if opening-night-related.

Write a brief report: review count, orchestrator status, failures fixed.
