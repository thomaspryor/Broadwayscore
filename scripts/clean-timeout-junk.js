#!/usr/bin/env node
/**
 * One-time: Clean remaining Time Out junk from all timeout review files.
 * Uses centralized cleanText() which has all Time Out patterns.
 */
const fs = require('fs');
const path = require('path');
const { cleanText } = require('./lib/text-cleaning');
const { classifyContentTier } = require('./lib/content-quality');

const dir = path.join(__dirname, '..', 'data', 'review-texts');
const showDirs = fs.readdirSync(dir).filter(d => {
  try { return fs.statSync(path.join(dir, d)).isDirectory(); }
  catch (e) { return false; }
});

let fixed = 0;
for (const showDir of showDirs) {
  const files = fs.readdirSync(path.join(dir, showDir))
    .filter(f => f.startsWith('timeout--') && f.endsWith('.json'));

  for (const file of files) {
    const fp = path.join(dir, showDir, file);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!data.fullText) continue;

    const cleaned = cleanText(data.fullText);
    const diff = data.fullText.length - cleaned.length;
    if (diff < 50) continue;

    data.fullText = cleaned;
    const wc = cleaned.split(/\s+/).filter(w => w).length;
    data.wordCount = wc;
    data.textWordCount = wc;

    const tier = classifyContentTier(data);
    const oldTier = data.contentTier;
    data.contentTier = tier.contentTier;
    data.tierReason = tier.tierReason || null;
    data.isFullReview = wc >= 300;

    fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
    console.log(`${showDir}/${file}: ${oldTier}→${tier.contentTier} (-${diff} chars, ${wc} words)`);
    fixed++;
  }
}
console.log(`\nFixed: ${fixed} files`);
