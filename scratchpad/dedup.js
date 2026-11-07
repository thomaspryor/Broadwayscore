const fs=require('fs');
const env=fs.readFileSync(process.env.HOME+'/Broadwayscore/.env','utf8');
const key=(env.match(/^LINEAR_API_KEY=(.*)$/m)||[])[1].trim().replace(/^["']|["']$/g,'');
(async()=>{
  for(const term of ['no-token','recover-explicit-ratings','remediation dispatch']){
    const q=`query{searchIssues(term:${JSON.stringify(term)},first:8){nodes{identifier title state{name}}}}`;
    try{
      const r=await fetch('https://api.linear.app/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:key},body:JSON.stringify({query:q})});
      const j=await r.json();
      const n=j.data&&j.data.searchIssues&&j.data.searchIssues.nodes;
      if(!n){console.log(term,'ERR',JSON.stringify(j).slice(0,200));continue;}
      console.log(`\n"${term}" -> ${n.length} match(es)`);
      n.forEach(i=>console.log(`   ${i.identifier} [${i.state.name}] ${i.title.slice(0,80)}`));
    }catch(e){console.log(term,'FETCH FAIL',e.message);}
  }
})();
