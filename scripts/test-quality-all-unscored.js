#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { assessTextQuality } = require('./lib/content-quality');

const dir = path.join(__dirname, '../data/review-texts');
const shows = fs.readdirSync(dir);
let garbage = 0, valid = 0, suspicious = 0;
let garbageList = [];

for (const s of shows) {
  const sd = path.join(dir, s);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const f of fs.readdirSync(sd).filter(x => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf-8'));
      if (d.llmScore || !d.fullText || d.fullText.length < 50) continue;
      if (d.wrongShow || d.wrongProduction || d.isMultiShowReview) continue;

      const showTitle = s.replace(/-\d{4}$/, '').replace(/-/g, ' ');
      const result = assessTextQuality(d.fullText, showTitle);

      if (result.quality === 'garbage') {
        garbage++;
        garbageList.push({ show: s, file: f, issues: result.issues.join('; ') });
      } else if (result.quality === 'suspicious') {
        suspicious++;
      } else {
        valid++;
      }
    } catch(e) {}
  }
}

console.log(`Unscored reviews with fullText: ${garbage + valid + suspicious}`);
console.log(`  Valid: ${valid}`);
console.log(`  Suspicious: ${suspicious}`);
console.log(`  Garbage (blocked): ${garbage}`);
console.log('\nGarbage details:');
for (const g of garbageList) {
  console.log(`  ${g.show}/${g.file}: ${g.issues}`);
}
