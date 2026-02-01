#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../data/review-texts');
const shows = fs.readdirSync(dir);
let unscored = [];
for (const s of shows) {
  const sd = path.join(dir, s);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const f of fs.readdirSync(sd).filter(x => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf-8'));
      const hasText = (d.fullText && d.fullText.length > 50) ||
                      (d.dtliExcerpt && d.dtliExcerpt.length > 30) ||
                      (d.showScoreExcerpt && d.showScoreExcerpt.length > 30);
      const hasLlm = d.llmScore && d.llmScore.score;
      if (hasText && !hasLlm && !d.wrongShow && !d.wrongProduction && !d.isMultiShowReview) {
        unscored.push({
          showId: s, file: f,
          textLen: d.fullText ? d.fullText.length : 0,
          outlet: d.outlet || d.outletId,
          excerptLen: Math.max(
            (d.dtliExcerpt || '').length,
            (d.showScoreExcerpt || '').length,
            (d.bwwExcerpt || '').length
          )
        });
      }
    } catch(e) {}
  }
}
console.log('Unscored reviews with text:', unscored.length);
for (const u of unscored) {
  console.log(`  ${u.showId}/${u.file} — fullText=${u.textLen}, excerpt=${u.excerptLen}, outlet=${u.outlet}`);
}
