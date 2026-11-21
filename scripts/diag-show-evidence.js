#!/usr/bin/env node
'use strict';
// BRO-7519: read-only. Show fields + review-text file METADATA (never text). --show=ID[,ID] [--file=substr]
const fs = require('fs'), path = require('path');
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const D = path.join(__dirname, '..', 'data');
const sj = JSON.parse(fs.readFileSync(path.join(D, 'shows.json'), 'utf8'));
const K = ['id', 'venue', 'category', 'status', 'previewsStartDate', 'openingDate', 'closingDate', 'openingDateSource', 'todaytixId'];
for (const id of (arg('show') || '').split(',').filter(Boolean)) {
  const s = (Array.isArray(sj) ? sj : sj.shows).find(x => x.id === id);
  console.log('==', id, JSON.stringify(s && Object.fromEntries(K.map(k => [k, s[k]]))));
  const dir = path.join(D, 'review-texts', id);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.includes(arg('file') || '')) : []) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const flags = Object.keys(j).filter(k => /^(wrong|is[A-Z]|needsRescore|duplicateOf)/.test(k) && j[k]);
    console.log(JSON.stringify({ f, date: j.publishDate || j.date, url: String(j.url || '').slice(0, 90), q: j.textQuality, stars: j.originalRating, score: j.assignedScore, flags }));
  }
}
