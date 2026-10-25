// Prototype (BRO-6250): download full-resolution square key art. Reuses the idea in
// scripts/social-autopost/art.js (unlanded): strip Contentful params, take the original.
const fs = require('fs'), path = require('path');
const ids = process.argv.slice(2);
const src = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/image-sources.json'), 'utf8'));
(async () => {
  for (const id of ids) {
    const s = src[id] || {};
    const url = s.thumbnail || s.poster;
    if (!url) { console.log(id, 'NO SOURCE'); continue; }
    const u = new URL(url); const clean = u.origin + u.pathname;
    const res = await fetch(clean, { headers: { 'User-Agent': 'BroadwayScorecard-video-proto/1.0' } });
    if (!res.ok) { console.log(id, 'HTTP', res.status); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(__dirname, 'art', id + '.img'), buf);
    console.log(id, buf.length, clean.slice(-50));
  }
})();
