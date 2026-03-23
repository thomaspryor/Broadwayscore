#!/usr/bin/env node
const fs = require('fs');
const p = require('path');
const pubDir = p.join(__dirname, '../../public/data/shows');
const imgDir = p.join(__dirname, '../../public/images/shows');
const masterPath = p.join(__dirname, '../../data/shows.json');

function getExt(id) {
  if (fs.existsSync(p.join(imgDir, id, 'poster.webp'))) return 'webp';
  if (fs.existsSync(p.join(imgDir, id, 'poster.jpg'))) return 'jpg';
  return 'none';
}

function toGrade(s) {
  if (s >= 90) return 'A+'; if (s >= 88) return 'A'; if (s >= 83) return 'A-';
  if (s >= 78) return 'B+'; if (s >= 73) return 'B'; if (s >= 68) return 'B-';
  if (s >= 63) return 'C+'; if (s >= 58) return 'C'; if (s >= 53) return 'C-';
  if (s >= 45) return 'D'; return 'F';
}

// Load master data for show metadata
const masterRaw = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
const masterShows = Array.isArray(masterRaw) ? masterRaw : (masterRaw.shows || Object.values(masterRaw));
const masterMap = {};
for (const s of masterShows) {
  if (s.id) masterMap[s.id] = s;
}

// Load public show JSONs for review/audience data
const pubFiles = fs.readdirSync(pubDir).filter(f => f.endsWith('.json') && !f.includes('west-end') && !f.includes('off-broadway'));
const outletScores = {};
const seasonScores = {};
const allShows = []; // merged data

for (const f of pubFiles) {
  try {
    const pub = JSON.parse(fs.readFileSync(p.join(pubDir, f), 'utf8'));
    const id = pub.id || f.replace('.json', '');
    const master = masterMap[id] || {};

    // Compute composite score from reviews (tier-weighted)
    let weightedSum = 0, weightTotal = 0;
    if (pub.rv) {
      for (const r of pub.rv) {
        if (typeof r.s !== 'number') continue;
        const w = { 1: 1.0, 2: 0.75, 3: 0.35 }[r.t] || 0.35;
        weightedSum += r.s * w;
        weightTotal += w;
      }
    }
    const compositeScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
    const compositeExact = weightTotal > 0 ? weightedSum / weightTotal : null;

    const show = {
      id,
      title: master.title || id,
      status: master.status,
      openingDate: master.openingDate || pub.pd,
      type: master.type,
      venue: master.venue,
      compositeScore,
      compositeExact,
      reviewCount: pub.rv ? pub.rv.length : 0,
      au: pub.au,
      rv: pub.rv,
      ext: getExt(id),
    };
    allShows.push(show);

    // Outlets
    if (pub.rv) {
      for (const r of pub.rv) {
        if (typeof r.s !== 'number' || !r.o) continue;
        if (!outletScores[r.o]) outletScores[r.o] = { sum: 0, count: 0 };
        outletScores[r.o].sum += r.s;
        outletScores[r.o].count++;
      }
    }

    // Seasons
    const od = master.openingDate || pub.pd;
    if (compositeScore && od) {
      const yr = parseInt(od.substring(0, 4)), mo = parseInt(od.substring(5, 7));
      if (yr >= 2000) {
        const sn = mo >= 8 ? yr + '-' + String(yr + 1).slice(2) : (yr - 1) + '-' + String(yr).slice(2);
        if (!seasonScores[sn]) seasonScores[sn] = { sum: 0, count: 0, shows: [] };
        seasonScores[sn].sum += compositeScore;
        seasonScores[sn].count++;
        seasonScores[sn].shows.push({ title: show.title, score: compositeScore });
      }
    }
  } catch (e) {}
}

// POST 6: Toughest and most generous outlets
console.log('=== POST 6: TOUGHEST ===');
const outs = Object.entries(outletScores)
  .filter(([, v]) => v.count >= 20)
  .map(([n, v]) => ({ name: n, avg: +(v.sum / v.count).toFixed(1), count: v.count }));
outs.sort((a, b) => a.avg - b.avg);
outs.slice(0, 5).forEach((o, i) => console.log(`${i + 1}. ${o.name} — ${o.avg} (${o.count})`));
console.log('\n=== POST 6: GENEROUS ===');
outs.sort((a, b) => b.avg - a.avg);
outs.slice(0, 5).forEach((o, i) => console.log(`${i + 1}. ${o.name} — ${o.avg} (${o.count})`));

// POST 7: Best seasons
console.log('\n=== POST 7: BEST SEASONS ===');
const seasonList = Object.entries(seasonScores)
  .filter(([, v]) => v.count >= 10)
  .map(([s, v]) => ({ season: s, avg: +(v.sum / v.count).toFixed(1), count: v.count, topShow: v.shows.sort((a, b) => b.score - a.score)[0] }))
  .sort((a, b) => b.avg - a.avg);
seasonList.slice(0, 5).forEach((s, i) => console.log(`${i + 1}. ${s.season} — ${s.avg} (${s.count} shows, top: ${s.topShow.title} ${s.topShow.score})`));

// POST 8: Critics low, audiences loved
console.log('\n=== POST 8: CRITICS LOW, AUDIENCES HIGH ===');
const audLoved = allShows
  .filter(s => s.compositeScore && s.au && typeof s.au.score === 'number' && s.reviewCount >= 5)
  .filter(s => s.compositeScore < 60 && s.au.score >= 78)
  .map(s => ({ ...s, grade: toGrade(s.au.score), gap: s.au.score - s.compositeScore, year: s.id.match(/-(\d{4})$/)?.[1] || '' }))
  .sort((a, b) => b.gap - a.gap);
audLoved.slice(0, 8).forEach((s, i) =>
  console.log(`${i + 1}. ${s.title} (${s.year}) — Critics: ${s.compositeScore}, Aud: ${s.grade} (${s.au.score}), Gap: ${s.gap}, ext: ${s.ext}, id: ${s.id}`)
);

// POST 9: Grosses
console.log('\n=== POST 9: GROSSES ===');
const grossHistPath = p.join(__dirname, '../../data/grosses-history.json');
if (fs.existsSync(grossHistPath)) {
  const g = JSON.parse(fs.readFileSync(grossHistPath, 'utf8'));
  if (Array.isArray(g)) {
    // Sort by most recent week, find capacity data
    const withCap = g.filter(x => x.capacityPct || x.capacity || x.avgCapacity || x.pctCapacity);
    console.log(`Entries: ${g.length}, with capacity: ${withCap.length}`);
    if (g.length > 0) {
      console.log('Sample keys:', Object.keys(g[0]).join(', '));
      console.log('Sample:', JSON.stringify(g[0]).substring(0, 500));
    }
  } else {
    // Object keyed by show
    const keys = Object.keys(g);
    console.log(`Shows: ${keys.length}`);
    if (keys.length > 0) {
      const sample = g[keys[0]];
      if (Array.isArray(sample)) {
        console.log(`${keys[0]} has ${sample.length} weeks`);
        const latest = sample[sample.length - 1];
        console.log('Latest week keys:', Object.keys(latest).join(', '));
        console.log('Latest week:', JSON.stringify(latest).substring(0, 500));
      } else {
        console.log('Sample keys:', Object.keys(sample).join(', '));
        console.log('Sample:', JSON.stringify(sample).substring(0, 400));
      }
    }
  }
} else {
  console.log('No grosses-history.json');
}

// POST 10-11: Commercial data
console.log('\n=== POST 10-11: COMMERCIAL ===');
const ctsPath = p.join(__dirname, '../../src/config/commercial.ts');
if (fs.existsSync(ctsPath)) {
  const cts = fs.readFileSync(ctsPath, 'utf8');
  // Extract recouped shows
  const recoupRegex = /['"]([^'"]+)['"]\s*:\s*\{[^}]*recouped:\s*true/g;
  let match;
  const recouped = [];
  while ((match = recoupRegex.exec(cts)) !== null) {
    recouped.push(match[1]);
  }
  console.log(`Recouped shows from commercial.ts: ${recouped.length}`);
  recouped.forEach(s => console.log(`  ${s}`));

  // Extract capitalization amounts
  const capRegex = /['"]([^'"]+)['"]\s*:\s*\{[^}]*capitalization:\s*['"]\$?([\d.,]+\s*[mMbB]?)/g;
  const expensive = [];
  while ((match = capRegex.exec(cts)) !== null) {
    expensive.push({ id: match[1], cost: match[2] });
  }
  expensive.sort((a, b) => {
    const parse = s => { const m = s.match(/([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
    return parse(b.cost) - parse(a.cost);
  });
  console.log(`\nMost expensive (from commercial.ts):`);
  expensive.slice(0, 8).forEach((s, i) => console.log(`${i + 1}. ${s.id}: $${s.cost}`));
} else {
  console.log('No commercial.ts');
}

// POSTS 12-14: Scorecards
console.log('\n=== POSTS 12-14: SCORECARDS ===');
for (const sid of ['hamilton-2015', 'wicked-2003', 'the-lion-king-1997']) {
  const show = allShows.find(s => s.id === sid);
  if (!show) { console.log(`${sid}: NOT FOUND`); continue; }
  const tiers = { 1: [], 2: [], 3: [] };
  if (show.rv) for (const r of show.rv) {
    if (typeof r.s === 'number' && r.t) {
      if (!tiers[r.t]) tiers[r.t] = [];
      tiers[r.t].push(r.s);
    }
  }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 'n/a';
  const audGrade = show.au ? toGrade(show.au.score) : 'n/a';
  console.log(`\n${show.title}: score=${show.compositeScore} (exact: ${show.compositeExact?.toFixed(2)}), reviews=${show.reviewCount}, audGrade=${audGrade} (${show.au?.score})`);
  console.log(`  T1: ${tiers[1].length} @ ${avg(tiers[1])}, T2: ${tiers[2].length} @ ${avg(tiers[2])}, T3: ${tiers[3].length} @ ${avg(tiers[3])}`);
  console.log(`  Opened: ${show.openingDate}, Status: ${show.status}, Ext: ${show.ext}`);
}

// POSTS 15-16: Running shows
console.log('\n=== POSTS 15-16: TOP RUNNING ===');
const used = new Set(['hamilton-2015', 'maybe-happy-ending-2024', 'oh-mary-2024', 'book-of-mormon-2011', 'the-lion-king-1997', 'wicked-2003']);
const running = allShows.filter(s => s.status === 'running' && s.compositeScore).sort((a, b) => (b.compositeExact || 0) - (a.compositeExact || 0));
running.slice(0, 15).forEach((s, i) => console.log(`${i + 1}. ${s.title} (${s.id}) — ${s.compositeScore} (${s.compositeExact?.toFixed(2)}) ext:${s.ext}${used.has(s.id) ? ' [USED]' : ''}`));

const p15 = running.find(s => !used.has(s.id));
if (p15) {
  console.log(`\nPost 15 pick: ${p15.title} (${p15.id}) — ${p15.compositeScore}, ext: ${p15.ext}`);
  // Get scorecard data
  const tiers = { 1: [], 2: [], 3: [] };
  if (p15.rv) for (const r of p15.rv) { if (typeof r.s === 'number' && r.t) { if (!tiers[r.t]) tiers[r.t] = []; tiers[r.t].push(r.s); } }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 'n/a';
  const audGrade = p15.au ? toGrade(p15.au.score) : 'n/a';
  console.log(`  audGrade=${audGrade} (${p15.au?.score}), T1: ${tiers[1].length} @ ${avg(tiers[1])}, T2: ${tiers[2].length} @ ${avg(tiers[2])}, T3: ${tiers[3].length} @ ${avg(tiers[3])}`);
}

// Post 16: newest big opening
const recent = allShows
  .filter(s => (s.status === 'running' || s.status === 'previews') && s.compositeScore && s.openingDate && s.openingDate >= '2025-01-01')
  .filter(s => !used.has(s.id) && s.id !== p15?.id)
  .sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0));
console.log('\nRecent 2025+ openings:');
recent.slice(0, 10).forEach((s, i) => console.log(`${i + 1}. ${s.title} (${s.id}) — score: ${s.compositeScore}, reviews: ${s.reviewCount}, opened: ${s.openingDate}, ext: ${s.ext}`));

if (recent.length > 0) {
  const p16 = recent[0];
  console.log(`\nPost 16 pick: ${p16.title} (${p16.id}) — ${p16.compositeScore}, ext: ${p16.ext}`);
  const tiers = { 1: [], 2: [], 3: [] };
  if (p16.rv) for (const r of p16.rv) { if (typeof r.s === 'number' && r.t) { if (!tiers[r.t]) tiers[r.t] = []; tiers[r.t].push(r.s); } }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 'n/a';
  const audGrade = p16.au ? toGrade(p16.au.score) : 'n/a';
  console.log(`  audGrade=${audGrade} (${p16.au?.score}), T1: ${tiers[1].length} @ ${avg(tiers[1])}, T2: ${tiers[2].length} @ ${avg(tiers[2])}, T3: ${tiers[3].length} @ ${avg(tiers[3])}`);
}
