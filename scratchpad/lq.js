const fs=require('fs');
const env=fs.readFileSync(process.env.HOME+'/Broadwayscore/.env','utf8');
const key=(env.match(/^LINEAR_API_KEY=(.*)$/m)||[])[1].trim().replace(/^["']|["']$/g,'');
(async()=>{for(const id of process.argv.slice(2)){
 const q=`query{issue(id:"${id}"){identifier title state{name} description}}`;
 const r=await fetch('https://api.linear.app/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:key},body:JSON.stringify({query:q})});
 const j=await r.json(); const i=j.data&&j.data.issue;
 console.log(i?`=== ${i.identifier} [${i.state.name}]\n${i.title}\n${(i.description||'').slice(0,1200)}`:id+' ERR');}})();
