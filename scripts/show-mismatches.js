#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const shows = ['chess-2025', 'mamma-mia-2025', 'two-strangers-bway-2025', 'wicked-2003'];

for (const showId of shows) {
  const dir = path.join('data/review-texts', showId);
  if (!fs.existsSync(dir)) {
    console.log('\n=== ' + showId + ' === (no review files)');
    continue;
  }

  console.log('\n=== ' + showId + ' ===');

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const reviews = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f)));
    return {
      outlet: data.outlet,
      critic: data.criticName,
      score: data.assignedScore,
      bucket: data.bucket,
      dtliThumb: data.dtliThumb,
      hasFullText: !!data.fullText
    };
  });

  // Sort by score descending
  reviews.sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const r of reviews) {
    // Determine our thumb based on bucket or score
    let thumb;
    if (r.bucket) {
      thumb = ['Rave', 'Positive'].includes(r.bucket) ? 'Up' :
              ['Mixed', 'Mixed-Positive'].includes(r.bucket) ? 'Flat' : 'Down';
    } else if (r.score !== null && r.score !== undefined) {
      thumb = r.score >= 70 ? 'Up' : r.score >= 50 ? 'Flat' : 'Down';
    } else {
      thumb = '??';
    }

    const flag = (thumb === 'Down') ? '⚠️ ' : '   ';
    const scoreStr = (r.score !== null && r.score !== undefined) ? r.score.toString().padStart(2) : '??';
    const outletStr = (r.outlet || 'Unknown').substring(0, 25).padEnd(26);
    const criticStr = r.critic || 'unknown';

    console.log('  ' + scoreStr + ' ' + thumb.padEnd(4) + flag + outletStr + criticStr);
  }
}
