#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { assessTextQuality } = require('./lib/content-quality');

const testFiles = [
  'data/review-texts/aladdin/nysr--elysa-gardner.json',
  'data/review-texts/hells-kitchen/variety-aramide-tinubu--aramide-tinubu.json',
  'data/review-texts/the-outsiders/variety-naveen-kumar--naveen-kumar.json',
  'data/review-texts/buena-vista-social-club/the-daily-beast-tim-teeman--tim-teeman.json',
  'data/review-texts/marjorie-prime/new-york-magazinevulture-sara-holdren--sara-holdren.json',
];

for (const f of testFiles) {
  const fp = path.join(__dirname, '..', f);
  if (!fs.existsSync(fp)) { console.log(`NOT FOUND: ${f}`); continue; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const text = data.fullText || '';
  const showTitle = data.showId ? data.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
  const result = assessTextQuality(text, showTitle);
  console.log(`${f.split('/').pop()}:`);
  console.log(`  quality=${result.quality}, confidence=${result.confidence}`);
  console.log(`  textLen=${text.length}, issues=${result.issues.join(', ') || 'none'}`);
  console.log(`  hasLlmScore=${!!data.llmScore}`);
  console.log();
}
