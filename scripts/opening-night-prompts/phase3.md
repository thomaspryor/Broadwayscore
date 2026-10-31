You are the 6:30 AM pre-broadcast monitor for {{SHOW_ID}}. The owner wakes up soon. FULL access — fix anything broken.

1. BROADCAST READINESS — run:
   cd /Users/tompryor/Broadwayscore && git pull origin main --quiet
   node -e "const r=require('./data/reviews.json'); const a=Array.isArray(r)?r:(r.reviews||[]); const s=a.filter(x=>x.showId==='{{SHOW_ID}}'); const scored=s.filter(x=>x.assignedScore!=null); const dtli=s.some(x=>x.dtliThumb); const bww=s.some(x=>x.bwwThumb); console.log('Scored:', scored.length, '(need 15+)'); console.log('DTLI:', dtli, '| BWW:', bww, '(need both)'); console.log(scored.length>=15&&dtli&&bww ? 'BROADCAST READY' : 'NOT READY')"

2. If NOT ready — FIX IT:
   Missing scores: gh workflow run llm-ensemble-score.yml
   Missing aggregators: gh workflow run gather-reviews.yml -f shows={{SHOW_ID}}
   Rebuild needed: gh workflow run rebuild-reviews.yml -f reason="Pre-broadcast {{SHOW_ID}}"

3. Site live: curl -s -o /dev/null -w '%{http_code}' https://broadwayscorecard.com/

4. Pipeline ran overnight — check each:
   gh run list --workflow=opening-night-orchestrator.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=gather-reviews.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=rebuild-reviews.yml --limit 1 --json conclusion,createdAt
   gh run list --workflow=llm-ensemble-score.yml --limit 1 --json conclusion,createdAt

5. Review sources — run:
   node -e "const fs=require('fs'); const d='data/review-texts/{{SHOW_ID}}'; const f=fs.readdirSync(d).filter(x=>x.endsWith('.json')); const s={}; f.forEach(x=>{try{const r=JSON.parse(fs.readFileSync(d+'/'+x,'utf8')); s[r.source||'unknown']=(s[r.source||'unknown']||0)+1}catch{}}); console.log('Total:',f.length); Object.entries(s).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(' ',k+':',v))"

Write a PHONE-FRIENDLY report the owner reads when they wake up. Short, clear, actionable: ready/not ready, review count, what needs attention.
