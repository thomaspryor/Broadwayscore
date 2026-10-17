#!/usr/bin/env node
/**
 * Generate all social media infographic posts (6-16) as HTML + PNG screenshots.
 * Posts 1-5 already exist. This generates 6-16 in both 1:1 (2160x2160) and 4:5 (2160x2700).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUTPUT_DIR = path.join(__dirname, '../../public/og/social');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Shared CSS/HTML fragments ──
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700;14..32,800;14..32,900&display=swap');`;

function baseCSS(height = 2160) {
  return `
  ${FONT_IMPORT}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 2160px; height: ${height}px;
    background: #0f0f14;
    font-family: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #e5e7eb; overflow: hidden; -webkit-font-smoothing: antialiased;
  }`;
}

function pageCSS(height) {
  const topPad = height === 2700 ? 120 : 96;
  const botPad = height === 2700 ? 100 : 80;
  return `.page { padding: ${topPad}px 100px ${botPad}px; height: 100%; display: flex; flex-direction: column; }`;
}

function headerCSS(titleSize = 112) {
  return `
  .header { text-align: center; margin-bottom: 72px; }
  .header h1 { font-size: ${titleSize}px; font-weight: 900; line-height: 1.05; color: #fff; letter-spacing: -0.02em; margin-bottom: 24px; }
  .header .sub { font-size: 32px; font-weight: 400; color: #9ca3af; }
  .header .sub .brand { color: #d4a574; font-weight: 700; }`;
}

function footerCSS() {
  return `
  .footer { text-align: center; margin-top: auto; }
  .footer-logo { font-size: 48px; font-weight: 900; margin-bottom: 16px; letter-spacing: -0.5px; }
  .footer-logo .white { color: #fff; }
  .footer-logo .gold { background: linear-gradient(135deg, #d4a574 0%, #b8956a 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .footer-logo .tm { font-size: 16px; font-weight: 400; vertical-align: super; margin-left: 4px; color: #9ca3af; -webkit-text-fill-color: #9ca3af; }
  .footer-meta { font-size: 24px; font-weight: 400; color: #6b7280; }`;
}

function footerHTML() {
  return `<div class="footer">
    <div class="footer-logo"><span class="white">Broadway</span><span class="gold">Scorecard</span><span class="tm">™</span></div>
    <div class="footer-meta">Updated March 2026 · 700+ shows · 18,000+ scored reviews · broadwayscorecard.com</div>
  </div>`;
}

function tierClass(score) {
  if (score >= 83) return 'gold';
  if (score >= 75) return 'recommended';
  if (score >= 65) return 'worth-seeing';
  if (score >= 55) return 'skippable';
  return 'stay-away';
}

function tierLabel(tier) {
  return { gold: 'Critical Gold', recommended: 'Recommended', 'worth-seeing': 'Worth Seeing', skippable: 'Skippable', 'stay-away': 'Critical Miss' }[tier];
}

function scoreBadgeCSS() {
  return `
  .score-badge { width: 128px; height: 128px; border-radius: 24px; display: flex; align-items: center; justify-content: center; font-size: 60px; font-weight: 700; line-height: 1; margin-bottom: 12px; position: relative; }
  .score-badge.gold { background: linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%); color: #1a1a1a; border: 4px solid #C8960E; box-shadow: 0 0 24px rgba(218,165,32,0.55), 0 0 12px rgba(255,215,0,0.4), 0 4px 12px rgba(0,0,0,0.3), inset 0 2px 0 rgba(255,255,255,0.3); }
  .score-badge.recommended { background: #22c55e; color: #fff; box-shadow: 0 2px 8px rgba(34,197,94,0.3); }
  .score-badge.worth-seeing { background: #14b8a6; color: #fff; box-shadow: 0 2px 8px rgba(20,184,166,0.3); }
  .score-badge.skippable { background: #d97706; color: #1a1a1a; box-shadow: 0 2px 8px rgba(217,119,6,0.3); }
  .score-badge.stay-away { background: #ef4444; color: #fff; box-shadow: 0 2px 8px rgba(239,68,68,0.3); }
  .tier-label { font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
  .tier-label.gold { color: #C8960E; } .tier-label.recommended { color: #22c55e; } .tier-label.worth-seeing { color: #14b8a6; } .tier-label.skippable { color: #d97706; } .tier-label.stay-away { color: #ef4444; }
  .crown-wrap { margin-bottom: -4px; position: relative; z-index: 1; }
  .reviews-label { font-size: 22px; font-weight: 400; color: #6b7280; }`;
}

function crownSVG(tier) {
  return tier === 'gold' ? `<div class="crown-wrap"><svg width="30" height="14" viewBox="0 0 24 14"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg></div>` : '';
}

// ── Post 6: Toughest & Most Generous Outlets ──
function post6HTML(height) {
  const toughest = [
    { name: 'Backstage', avg: 63.8, count: 127 },
    { name: 'TheWrap', avg: 64.2, count: 351 },
    { name: 'NorthJersey.com', avg: 64.8, count: 185 },
    { name: 'Theater News Online', avg: 65.0, count: 62 },
    { name: 'Broadway & Me', avg: 65.3, count: 22 },
  ];
  const generous = [
    { name: 'Digital Journal', avg: 83.2, count: 25 },
    { name: 'Drama Queen NYC', avg: 79.9, count: 24 },
    { name: 'Wolf Entertainment Guide', avg: 79.1, count: 50 },
    { name: 'Stu on Broadway', avg: 79.1, count: 23 },
    { name: 'Front Mezz Junkies', avg: 78.1, count: 88 },
  ];

  const gap = height === 2700 ? 28 : 20;

  function renderOutlet(o, i, color) {
    const barW = Math.round((o.avg / 100) * 100);
    return `<div class="outlet-row">
      <div class="outlet-rank" style="color:${color}">${i + 1}</div>
      <div class="outlet-info">
        <div class="outlet-name">${o.name}</div>
        <div class="outlet-meta">${o.count} reviews scored</div>
      </div>
      <div class="outlet-score-area">
        <div class="outlet-bar-bg"><div class="outlet-bar" style="width:${barW}%;background:${color}"></div></div>
        <div class="outlet-avg" style="color:${color}">${o.avg}</div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(100)}
  .section-label { font-size: 28px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 24px; padding-left: 8px; }
  .section-label.tough { color: #ef4444; }
  .section-label.generous { color: #22c55e; }
  .columns { display: flex; gap: 64px; flex: 1; padding: 0 24px; }
  .column { flex: 1; }
  .outlet-row { display: flex; align-items: center; gap: 20px; padding: 20px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .outlet-rank { font-size: 48px; font-weight: 800; opacity: 0.6; width: 60px; text-align: center; flex-shrink: 0; }
  .outlet-info { min-width: 0; flex: 1; }
  .outlet-name { font-size: 36px; font-weight: 700; color: #fff; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .outlet-meta { font-size: 22px; color: #6b7280; }
  .outlet-score-area { display: flex; align-items: center; gap: 16px; flex-shrink: 0; width: 280px; }
  .outlet-bar-bg { flex: 1; height: 12px; background: rgba(255,255,255,0.06); border-radius: 6px; overflow: hidden; }
  .outlet-bar { height: 100%; border-radius: 6px; }
  .outlet-avg { font-size: 44px; font-weight: 800; width: 80px; text-align: right; }
  .divider-v { width: 2px; background: rgba(255,255,255,0.08); }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>Broadway's Toughest &<br>Most Generous Outlets</h1>
      <div class="sub">Average <span class="brand">CriticScore™</span> across 20+ reviewed shows</div>
    </div>
    <div class="columns">
      <div class="column">
        <div class="section-label tough">Toughest Critics</div>
        ${toughest.map((o, i) => renderOutlet(o, i, '#ef4444')).join('')}
      </div>
      <div class="divider-v"></div>
      <div class="column">
        <div class="section-label generous">Most Generous</div>
        ${generous.map((o, i) => renderOutlet(o, i, '#22c55e')).join('')}
      </div>
    </div>
    ${footerHTML()}
  </div></body></html>`;
}

// ── Post 7: Best Broadway Seasons ──
function post7HTML(height) {
  const seasons = [
    { season: '2022-23', avg: 72.5, count: 43, topShow: 'Kimberly Akimbo', topScore: 88 },
    { season: '2016-17', avg: 71.7, count: 38, topShow: 'Dear Evan Hansen', topScore: 83 },
    { season: '2023-24', avg: 71.7, count: 35, topShow: 'Stereophonic', topScore: 89 },
    { season: '2017-18', avg: 71.4, count: 31, topShow: 'Angels in America', topScore: 88 },
    { season: '2014-15', avg: 71.1, count: 35, topShow: 'Hamilton', topScore: 89 },
  ];

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(112)}
  .rows { display: flex; flex-direction: column; gap: ${height === 2700 ? 44 : 32}px; align-items: center; flex: 1; }
  .season-row { background: #1a1a24; border-radius: 32px; padding: 36px 48px; display: flex; align-items: center; gap: 36px; border: 1px solid rgba(255,255,255,0.05); max-width: 1700px; width: 100%; }
  .season-rank { font-size: 128px; font-weight: 800; color: rgba(255,255,255,0.08); line-height: 1; width: 120px; text-align: center; flex-shrink: 0; }
  .season-info { flex: 1; min-width: 0; }
  .season-name { font-size: 72px; font-weight: 800; color: #fff; margin-bottom: 8px; }
  .season-meta { font-size: 28px; color: #6b7280; }
  .season-meta .highlight { color: #d4a574; font-weight: 600; }
  .season-score-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .season-score-label { font-size: 18px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 8px; }
  .season-score { width: 140px; height: 140px; border-radius: 28px; display: flex; align-items: center; justify-content: center; font-size: 60px; font-weight: 700; }
  .season-score.green { background: #22c55e; color: #fff; box-shadow: 0 2px 12px rgba(34,197,94,0.3); }
  .season-score.teal { background: #14b8a6; color: #fff; box-shadow: 0 2px 12px rgba(20,184,166,0.3); }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>Best Broadway Seasons<br>Since 2000</h1>
      <div class="sub">Average <span class="brand">CriticScore™</span> across all shows that season</div>
    </div>
    <div class="rows">
    ${seasons.map((s, i) => {
      const scoreClass = s.avg >= 73 ? 'green' : 'teal';
      return `<div class="season-row">
        <div class="season-rank">${i + 1}</div>
        <div class="season-info">
          <div class="season-name">${s.season} Season</div>
          <div class="season-meta">${s.count} shows · Top: <span class="highlight">${s.topShow}</span> (${s.topScore})</div>
        </div>
        <div class="season-score-col">
          <div class="season-score-label">Avg Score</div>
          <div class="season-score ${scoreClass}">${s.avg}</div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${footerHTML()}
  </div></body></html>`;
}

// ── Post 8: Critics Flopped, Audiences Loved ──
function post8HTML(height) {
  const shows = [
    { rank: 1, name: "Don't Dress for Dinner", year: '2012', criticScore: 53, audGrade: 'A-', posterId: 'dont-dress-for-dinner-2012', posterExt: 'jpg' },
    { rank: 2, name: 'Godspell', year: '2011', criticScore: 55, audGrade: 'A-', posterId: 'godspell-2011', posterExt: 'jpg' },
    { rank: 3, name: 'Romeo and Juliet', year: '2013', criticScore: 54, audGrade: 'B+', posterId: 'romeo-and-juliet-2013' },
    { rank: 4, name: 'Lysistrata Jones', year: '2011', criticScore: 56, audGrade: 'B+', posterId: 'lysistrata-jones-2011', posterExt: 'jpg' },
    { rank: 5, name: 'The Kite Runner', year: '2022', criticScore: 57, audGrade: 'B+', posterId: 'the-kite-runner-2022' },
  ];
  return dualScorePostHTML(height, {
    title: 'Shows Critics Panned<br>That Audiences Loved',
    subtitle: 'Low <span class="brand">CriticScore™</span>, High AudienceGrade',
    shows, yearField: 'year',
  });
}

// ── Post 4 REPLACEMENT: Critics Loved, Audiences Didn't (scores >= 75) ──
function post4HTML(height) {
  const shows = [
    { rank: 1, name: 'The Lyons', year: '2012', criticScore: 78, audGrade: 'D', posterId: 'the-lyons-2012', posterExt: 'jpg' },
    { rank: 2, name: 'The Merchant of Venice', year: '2010', criticScore: 77, audGrade: 'C-', posterId: 'the-merchant-of-venice-2010' },
    { rank: 3, name: 'Dividing the Estate', year: '2008', criticScore: 82, audGrade: 'C+', posterId: 'dividing-the-estate-2008', posterExt: 'jpg' },
    { rank: 4, name: 'Fela!', year: '2009', criticScore: 80, audGrade: 'C+', posterId: 'fela-2009', posterExt: 'jpg' },
    { rank: 5, name: 'Superior Donuts', year: '2009', criticScore: 76, audGrade: 'C+', posterId: 'superior-donuts-2009', posterExt: 'jpg' },
  ];
  return dualScorePostHTML(height, {
    title: 'Shows Critics Loved<br>That Audiences Didn\'t',
    subtitle: 'High <span class="brand">CriticScore™</span> (75+), Low AudienceGrade',
    shows, yearField: 'year',
  });
}

// ── Post 9: Hottest Tickets ──
function post9HTML(height) {
  const shows = [
    { rank: 1, name: 'Just in Time', capacity: '101.7%', gross: '$1.48M', atp: '$264', posterId: 'just-in-time-2025' },
    { rank: 2, name: 'Harry Potter and the Cursed Child', capacity: '99.9%', gross: '$2.16M', atp: '$190', posterId: 'harry-potter-2021' },
    { rank: 3, name: 'Ragtime', capacity: '98.0%', gross: '$0.99M', atp: '$120', posterId: 'ragtime-2025' },
    { rank: 4, name: 'Chicago', capacity: '97.8%', gross: '$1.18M', atp: '$160', posterId: 'chicago-1996' },
    { rank: 5, name: 'The Outsiders', capacity: '93.2%', gross: '$0.87M', atp: '$114', posterId: 'the-outsiders-2024' },
  ];

  const gap = height === 2700 ? 44 : 32;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(112)}
  .rows { display: flex; flex-direction: column; gap: ${gap}px; align-items: center; flex: 1; }
  .show-row { background: #1a1a24; border-radius: 32px; padding: 28px 32px; display: flex; align-items: center; gap: 24px; border: 1px solid rgba(255,255,255,0.05); max-width: 1600px; width: 100%; }
  .rank-num { font-size: 128px; font-weight: 800; color: rgba(255,255,255,0.08); line-height: 1; width: 120px; text-align: center; flex-shrink: 0; }
  .poster { width: 140px; height: 200px; border-radius: 12px; object-fit: cover; flex-shrink: 0; background: #2a2a38; }
  .show-info { min-width: 0; flex: 1; }
  .show-title { font-size: 50px; font-weight: 700; color: #fff; line-height: 1.2; margin-bottom: 8px; }
  .show-meta { font-size: 24px; color: #6b7280; }
  .spacer { flex: 1; }
  .cap-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .cap-label { font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
  .cap-badge { width: 160px; height: 128px; border-radius: 24px; display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: 700; line-height: 1; margin-bottom: 12px; }
  .cap-badge.hot { background: linear-gradient(135deg, #ef4444, #f97316); color: #fff; box-shadow: 0 2px 12px rgba(239,68,68,0.4); }
  .cap-badge.warm { background: #f59e0b; color: #1a1a1a; box-shadow: 0 2px 12px rgba(245,158,11,0.3); }
  .cap-sub { font-size: 22px; font-weight: 400; color: #6b7280; }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>Hottest Tickets on<br>Broadway This Week</h1>
      <div class="sub">Week of March 1, 2026 · Ranked by capacity %</div>
    </div>
    <div class="rows">
    ${shows.map(s => {
      const capClass = parseFloat(s.capacity) >= 95 ? 'hot' : 'warm';
      const ext = s.posterExt || 'webp';
      const posterUrl = `https://broadwayscorecard.com/images/shows/${s.posterId}/poster.${ext}`;
      return `<div class="show-row">
        <div class="rank-num">${s.rank}</div>
        <img class="poster" src="${posterUrl}" alt="${s.name}">
        <div class="show-info">
          <div class="show-title">${s.name}</div>
          <div class="show-meta">${s.gross} gross · ${s.atp} avg ticket</div>
        </div>
        <div class="spacer"></div>
        <div class="cap-col">
          <div class="cap-label">Capacity</div>
          <div class="cap-badge ${capClass}">${s.capacity}</div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${footerHTML()}
  </div></body></html>`;
}

// ── Post 10: Shows That Recouped ──
function post10HTML(height) {
  const shows = [
    { rank: 1, name: 'Waiting for Godot', cost: '$7.5M', designation: 'Easy Winner', weeks: '8 weeks', posterId: 'waiting-for-godot-2025' },
    { rank: 2, name: 'Othello', cost: '$9M', designation: 'Easy Winner', weeks: '9 weeks', posterId: 'othello-2025' },
    { rank: 3, name: 'Glengarry Glen Ross', cost: '$7.5M', designation: 'Easy Winner', weeks: '9 weeks', posterId: 'glengarry-glen-ross-2025' },
    { rank: 4, name: 'Hamilton', cost: '$12.5M', designation: 'Miracle', weeks: '10 weeks', posterId: 'hamilton-2015' },
    { rank: 5, name: 'Art', cost: '$6.8M', designation: 'Easy Winner', weeks: '13 weeks', posterId: 'art-2025', posterExt: 'jpg' },
  ];

  const desColors = { Miracle: '#fbbf24', Windfall: '#22c55e', 'Easy Winner': '#84cc16', Trickle: '#22d3ee' };
  const gap = height === 2700 ? 44 : 32;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(108)}
  .rows { display: flex; flex-direction: column; gap: ${gap}px; align-items: center; flex: 1; }
  .show-row { background: #1a1a24; border-radius: 32px; padding: 28px 32px; display: flex; align-items: center; gap: 24px; border: 1px solid rgba(255,255,255,0.05); max-width: 1600px; width: 100%; }
  .rank-num { font-size: 128px; font-weight: 800; color: rgba(255,255,255,0.08); line-height: 1; width: 120px; text-align: center; flex-shrink: 0; }
  .poster { width: 140px; height: 200px; border-radius: 12px; object-fit: cover; flex-shrink: 0; background: #2a2a38; }
  .show-info { min-width: 0; flex: 1; }
  .show-title { font-size: 52px; font-weight: 700; color: #fff; line-height: 1.2; margin-bottom: 8px; }
  .show-meta { font-size: 26px; color: #6b7280; }
  .spacer { flex: 1; }
  .weeks-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .weeks-label { font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
  .weeks-badge { width: 128px; height: 128px; border-radius: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #22c55e; color: #fff; box-shadow: 0 2px 12px rgba(34,197,94,0.3); }
  .weeks-num { font-size: 56px; font-weight: 800; line-height: 1; }
  .weeks-unit { font-size: 20px; font-weight: 500; opacity: 0.8; }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>Fastest Broadway Shows<br>to Recoup</h1>
      <div class="sub">Estimated weeks from opening night to recoupment · Since 2005</div>
    </div>
    <div class="rows">
    ${shows.map(s => {
      const ext = s.posterExt || 'webp';
      const posterUrl = `https://broadwayscorecard.com/images/shows/${s.posterId}/poster.${ext}`;
      const weeksNum = s.weeks.replace(' weeks', '');
      return `<div class="show-row">
        <div class="rank-num">${s.rank}</div>
        <img class="poster" src="${posterUrl}" alt="${s.name}">
        <div class="show-info">
          <div class="show-title">${s.name}</div>
          <div class="show-meta">Capitalization: ${s.cost}</div>
        </div>
        <div class="spacer"></div>
        <div class="weeks-col">
          <div class="weeks-label">Recouped</div>
          <div class="weeks-badge">
            <div class="weeks-num">${weeksNum}</div>
            <div class="weeks-unit">weeks</div>
          </div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${footerHTML().replace('Updated March 2026', 'Estimates via trade press · Updated March 2026')}
  </div></body></html>`;
}

// ── Post 11: Most Expensive Productions ──
function post11HTML(height) {
  const shows = [
    { rank: 1, name: 'King Kong', year: '2018', cost: '$36.5M', designation: 'Flop', posterId: 'king-kong-2018' },
    { rank: 2, name: 'Harry Potter and the Cursed Child', year: '2018', cost: '$35.5M', designation: 'Trickle', posterId: 'harry-potter-2021' },
    { rank: 3, name: 'Frozen', year: '2018', cost: '$35M', designation: 'Fizzle', posterId: 'frozen-2018' },
    { rank: 4, name: 'Death Becomes Her', year: '2024', cost: '$31.5M', designation: 'TBD', posterId: 'death-becomes-her-2024' },
    { rank: 5, name: 'Boop! The Musical', year: '2025', cost: '$29M', designation: 'Flop', posterId: 'boop-2025' },
  ];

  const desColors = { Miracle: '#fbbf24', Windfall: '#22c55e', Trickle: '#22d3ee', TBD: '#9ca3af', Fizzle: '#f97316', Flop: '#ef4444' };
  const gap = height === 2700 ? 44 : 32;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(108)}
  .rows { display: flex; flex-direction: column; gap: ${gap}px; align-items: center; flex: 1; }
  .show-row { background: #1a1a24; border-radius: 32px; padding: 28px 32px; display: flex; align-items: center; gap: 24px; border: 1px solid rgba(255,255,255,0.05); max-width: 1600px; width: 100%; }
  .rank-num { font-size: 128px; font-weight: 800; color: rgba(255,255,255,0.08); line-height: 1; width: 120px; text-align: center; flex-shrink: 0; }
  .poster { width: 140px; height: 200px; border-radius: 12px; object-fit: cover; flex-shrink: 0; background: #2a2a38; }
  .show-info { min-width: 0; flex: 1; }
  .show-title { font-size: 52px; font-weight: 700; color: #fff; line-height: 1.2; margin-bottom: 8px; }
  .show-meta { font-size: 26px; color: #6b7280; }
  .spacer { flex: 1; }
  .cost-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .cost-label { font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
  .cost-badge { width: 160px; height: 100px; border-radius: 20px; display: flex; align-items: center; justify-content: center; font-size: 44px; font-weight: 800; color: #fff; background: #1a1a24; border: 2px solid rgba(255,255,255,0.1); margin-bottom: 8px; }
  .des-tag { font-size: 22px; font-weight: 600; }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>The Most Expensive<br>Broadway Productions</h1>
      <div class="sub">Capitalization (production cost) from trade press</div>
    </div>
    <div class="rows">
    ${shows.map(s => {
      const color = desColors[s.designation] || '#6b7280';
      const ext = s.posterExt || 'webp';
      const posterUrl = `https://broadwayscorecard.com/images/shows/${s.posterId}/poster.${ext}`;
      return `<div class="show-row">
        <div class="rank-num">${s.rank}</div>
        <img class="poster" src="${posterUrl}" alt="${s.name}">
        <div class="show-info">
          <div class="show-title">${s.name}</div>
          <div class="show-meta">${s.year}</div>
        </div>
        <div class="spacer"></div>
        <div class="cost-col">
          <div class="cost-label">Budget</div>
          <div class="cost-badge">${s.cost}</div>
          <div class="des-tag" style="color:${color}">${s.designation}</div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${footerHTML()}
  </div></body></html>`;
}

// ── Dual-score template (used by Posts 4, 5, 8) ──
function dualScorePostHTML(height, config) {
  const gap = height === 2700 ? 44 : 32;
  const audColorMap = grade => {
    if (grade.startsWith('A')) return { bg: '#22c55e', color: '#fff' };
    if (grade === 'B+' || grade === 'B') return { bg: '#14b8a6', color: '#fff' };
    if (grade === 'B-') return { bg: '#14b8a6', color: '#fff' };
    if (grade.startsWith('C')) return { bg: '#d97706', color: '#1a1a1a' };
    return { bg: '#ef4444', color: '#fff' };
  };

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${baseCSS(height)} ${pageCSS(height)} ${headerCSS(112)}
  .rows { display: flex; flex-direction: column; gap: ${gap}px; align-items: center; flex: 1; }
  .show-row { background: #1a1a24; border-radius: 32px; padding: 28px 32px; display: flex; align-items: center; gap: 24px; border: 1px solid rgba(255,255,255,0.05); max-width: 1600px; width: 100%; }
  .rank-num { font-size: 128px; font-weight: 800; color: rgba(255,255,255,0.08); line-height: 1; width: 120px; text-align: center; flex-shrink: 0; }
  .poster { width: 140px; height: 200px; border-radius: 12px; object-fit: cover; flex-shrink: 0; background: #2a2a38; }
  .show-info { min-width: 0; flex: 1; }
  .show-title { font-size: 52px; font-weight: 700; color: #fff; line-height: 1.2; margin-bottom: 12px; }
  .show-meta { font-size: 24px; font-weight: 400; color: #6b7280; }
  .spacer { flex: 1; }
  .dual-scores { display: flex; align-items: flex-start; gap: 24px; flex-shrink: 0; }
  .score-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .score-label { font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; color: #6b7280; }
  .score-badge { width: 112px; height: 112px; border-radius: 20px; display: flex; align-items: center; justify-content: center; font-size: 52px; font-weight: 700; line-height: 1; position: relative; }
  .score-badge.gold { background: linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%); color: #1a1a1a; border: 4px solid #C8960E; box-shadow: 0 0 24px rgba(218,165,32,0.55), 0 0 12px rgba(255,215,0,0.4), 0 4px 12px rgba(0,0,0,0.3), inset 0 2px 0 rgba(255,255,255,0.3); }
  .score-badge.recommended { background: #22c55e; color: #fff; box-shadow: 0 2px 8px rgba(34,197,94,0.3); }
  .score-badge.worth-seeing { background: #14b8a6; color: #fff; box-shadow: 0 2px 8px rgba(20,184,166,0.3); }
  .score-badge.skippable { background: #d97706; color: #1a1a1a; box-shadow: 0 2px 8px rgba(217,119,6,0.3); }
  .score-badge.stay-away { background: #ef4444; color: #fff; box-shadow: 0 2px 8px rgba(239,68,68,0.3); }
  .audience-badge { width: 112px; height: 112px; border-radius: 20px; display: flex; align-items: center; justify-content: center; font-size: 46px; font-weight: 700; line-height: 1; }
  .crown-wrap { margin-bottom: -4px; position: relative; z-index: 1; }
  ${footerCSS()}
  </style></head><body><div class="page">
    <div class="header">
      <h1>${config.title}</h1>
      <div class="sub">${config.subtitle}</div>
    </div>
    <div class="rows">
    ${config.shows.map(s => {
      const tier = tierClass(s.criticScore);
      const ext = s.posterExt || 'webp';
      const posterUrl = `https://broadwayscorecard.com/images/shows/${s.posterId}/poster.${ext}`;
      const crown = tier === 'gold' ? `<div class="crown-wrap"><svg width="26" height="12" viewBox="0 0 24 14"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg></div>` : '';
      const ac = audColorMap(s.audGrade);
      const metaField = s[config.yearField || 'year'] || '';
      return `<div class="show-row">
        <div class="rank-num">${s.rank}</div>
        <img class="poster" src="${posterUrl}" alt="${s.name}">
        <div class="show-info">
          <div class="show-title">${s.name}</div>
          <div class="show-meta">${metaField}</div>
        </div>
        <div class="spacer"></div>
        <div class="dual-scores">
          <div class="score-col">
            <div class="score-label">Critics</div>
            ${crown}
            <div class="score-badge ${tier}">${s.criticScore}</div>
          </div>
          <div class="score-col">
            <div class="score-label">Audience</div>
            <div class="audience-badge" style="background:${ac.bg};color:${ac.color};box-shadow:0 2px 8px ${ac.bg}44">${s.audGrade}</div>
          </div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${footerHTML()}
  </div></body></html>`;
}

// ── Posts 12-16: Show Scorecards ──
function scorecardHTML(height, config) {
  const { title, headline, score, reviews, audGrade, audScore, opened, venue, status, posterId } = config;
  const tier = tierClass(score);
  const ext = config.posterExt || 'webp';
  const posterUrl = `https://broadwayscorecard.com/images/shows/${posterId}/poster.${ext}`;
  const posterHeight = Math.round(height * 0.58);
  const topPad = height === 2700 ? 120 : 96;
  const botPad = height === 2700 ? 100 : 80;

  const audColorMap = grade => {
    if (grade.startsWith('A')) return { bg: '#22c55e', color: '#fff' };
    if (grade === 'B+' || grade === 'B') return { bg: '#14b8a6', color: '#fff' };
    if (grade.startsWith('C')) return { bg: '#d97706', color: '#1a1a1a' };
    return { bg: '#ef4444', color: '#fff' };
  };
  const ac = audColorMap(audGrade);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700;14..32,800;14..32,900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 2160px; height: ${height}px; background: #0f0f14; font-family: 'Inter', ui-sans-serif, -apple-system, sans-serif; color: #e5e7eb; overflow: hidden; -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; }
  .poster-wrap { position: relative; height: ${posterHeight}px; flex-shrink: 0; }
  .poster-img { width: 100%; height: 100%; object-fit: cover; display: block; object-position: center top; }
  .poster-fade { position: absolute; bottom: 0; left: 0; right: 0; height: 300px; background: linear-gradient(to bottom, transparent, #0f0f14); }
  .info { flex: 1; padding: 40px 120px 72px; display: flex; flex-direction: column; gap: 40px; }
  .show-headline { font-size: 32px; font-weight: 500; color: #6b7280; }
  .show-title { font-size: 112px; font-weight: 900; color: #fff; line-height: 1.0; letter-spacing: -0.02em; }
  .show-meta { font-size: 28px; color: #6b7280; }
  .bottom-row { display: flex; align-items: center; justify-content: space-between; margin-top: auto; }
  .footer-logo { font-size: 44px; font-weight: 900; letter-spacing: -0.5px; }
  .footer-logo .white { color: #fff; }
  .footer-logo .gold { background: linear-gradient(135deg, #d4a574 0%, #b8956a 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .footer-logo .tm { font-size: 16px; font-weight: 400; vertical-align: super; margin-left: 4px; color: #6b7280; -webkit-text-fill-color: #6b7280; }
  .scores-row { display: flex; gap: 32px; }
  .score-block { display: flex; flex-direction: column; align-items: center; background: #1a1a24; border: 1px solid rgba(255,255,255,0.08); border-radius: 28px; padding: 32px 56px; }
  .score-label { font-size: 22px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 16px; }
  .score-badge { width: 176px; height: 176px; border-radius: 28px; display: flex; align-items: center; justify-content: center; font-size: 80px; font-weight: 700; }
  .score-badge.gold { background: linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%); color: #1a1a1a; border: 4px solid #C8960E; box-shadow: 0 0 32px rgba(218,165,32,0.55), 0 0 16px rgba(255,215,0,0.4), inset 0 2px 0 rgba(255,255,255,0.3); }
  .score-badge.recommended { background: #22c55e; color: #fff; box-shadow: 0 2px 16px rgba(34,197,94,0.3); }
  .score-badge.worth-seeing { background: #14b8a6; color: #fff; box-shadow: 0 2px 16px rgba(20,184,166,0.3); }
  .score-badge.skippable { background: #d97706; color: #1a1a1a; box-shadow: 0 2px 16px rgba(217,119,6,0.3); }
  .score-badge.stay-away { background: #ef4444; color: #fff; box-shadow: 0 2px 16px rgba(239,68,68,0.3); }
  .aud-badge { width: 176px; height: 176px; border-radius: 28px; display: flex; align-items: center; justify-content: center; font-size: 64px; font-weight: 700; }
  .score-sub { font-size: 20px; color: #6b7280; margin-top: 12px; }
  .crown { margin-bottom: -8px; position: relative; z-index: 1; }
  </style></head><body>
    <div class="poster-wrap">
      <img class="poster-img" src="${posterUrl}" alt="${title}">
      <div class="poster-fade"></div>
    </div>
    <div class="info">
      <div class="show-headline">${headline}</div>
      <div class="show-title">${title}</div>
      <div class="show-meta">${venue ? venue + ' · ' : ''}Opened ${opened} · ${status}</div>
      <div class="bottom-row">
        <div class="footer-logo"><span class="white">Broadway</span><span class="gold">Scorecard</span><span class="tm">™</span></div>
        <div class="scores-row">
          <div class="score-block">
            <div class="score-label">CriticScore™</div>
            ${tier === 'gold' ? '<div class="crown"><svg width="44" height="20" viewBox="0 0 24 14"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg></div>' : ''}
            <div class="score-badge ${tier}">${score}</div>
            <div class="score-sub">${reviews} reviews</div>
          </div>
          <div class="score-block">
            <div class="score-label">Audience</div>
            <div class="aud-badge" style="background:${ac.bg};color:${ac.color};box-shadow:0 2px 16px ${ac.bg}44">${audGrade}</div>
            <div class="score-sub">${audScore ? audScore + '/100' : '&nbsp;'}</div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;
}

// ── Main: Generate all posts ──
async function main() {
  const posts = {
    'post06-outlets': post6HTML,
    'post07-best-seasons': post7HTML,
    'post08-audiences-loved': post8HTML,
    'post09-hottest-tickets': post9HTML,
    'post10-recouped': post10HTML,
    'post11-most-expensive': post11HTML,
    'post04-critics-loved': post4HTML,
    'post12-hamilton': (h) => scorecardHTML(h, {
      title: 'Hamilton', headline: 'The Numbers Behind<br>Hamilton', score: 90, exact: 89.88, reviews: 42, audGrade: 'A+', audScore: 96,
      t1: { avg: 89.4, count: 12 }, t2: { avg: 89.1, count: 11 }, t3: { avg: 91.7, count: 19 },
      opened: 'August 6, 2015', venue: 'Richard Rodgers Theatre', status: 'Open', posterId: 'hamilton-2015'
    }),
    'post13-wicked': (h) => scorecardHTML(h, {
      title: 'Wicked', headline: 'Do Critics Agree<br>With Audiences on Wicked?', score: 69, exact: 69.14, reviews: 26, audGrade: 'A+', audScore: 93,
      t1: { avg: 66.3, count: 6 }, t2: { avg: 69.1, count: 15 }, t3: { avg: 79.2, count: 5 },
      opened: 'October 30, 2003', venue: 'Gershwin Theatre', status: 'Open', posterId: 'wicked-2003'
    }),
    'post14-lion-king': (h) => scorecardHTML(h, {
      title: 'The Lion King', headline: '28 Years Later:<br>The Lion King by the Numbers', score: 83, exact: 83.23, reviews: 32, audGrade: 'A+', audScore: 90,
      t1: { avg: 84.0, count: 9 }, t2: { avg: 83.8, count: 5 }, t3: { avg: 81.8, count: 18 },
      opened: 'November 13, 1997', venue: 'Minskoff Theatre', status: 'Open', posterId: 'the-lion-king-1997'
    }),
    'post15-harry-potter': (h) => scorecardHTML(h, {
      title: 'Harry Potter and the Cursed Child', headline: 'What Do 69 Critics Think<br>of Harry Potter?', score: 83, exact: 83.19, reviews: 69, audGrade: 'A-', audScore: 86,
      t1: { avg: 87.0, count: 15 }, t2: { avg: 81.0, count: 24 }, t3: { avg: 81.0, count: 30 },
      opened: 'March 16, 2018', venue: 'Lyric Theatre', status: 'Open', posterId: 'harry-potter-2021'
    }),
    'post16-ragtime': (h) => scorecardHTML(h, {
      title: 'Ragtime', headline: 'Ragtime Is Back —<br>Here\'s What Critics Think', score: 81, exact: 81.27, reviews: 30, audGrade: 'A', audScore: 93,
      t1: { avg: 77.0, count: 8 }, t2: { avg: 83.0, count: 12 }, t3: { avg: 87.0, count: 10 },
      opened: 'October 16, 2025', venue: 'Vivian Beaumont Theater', status: 'Open', posterId: 'ragtime-2025'
    }),
  };

  // Also re-screenshot posts 1-5 in 4:5 format, and re-screenshot post 2 (Fun Home fix)
  const existing1x1 = ['top5-running', 'post02-top-musicals', 'post03-top-plays', 'post04-critics-loved', 'post05-disagree'];

  const browser = await chromium.launch();

  // Generate new posts (6-16) in both sizes
  for (const [name, genFn] of Object.entries(posts)) {
    for (const [suffix, height, width] of [['', 2160, 2160], ['-4x5', 2700, 2160]]) {
      const html = genFn(height);
      const htmlPath = path.join(OUTPUT_DIR, `${name}${suffix}.html`);
      const pngPath = path.join(OUTPUT_DIR, `${name}${suffix}.png`);
      fs.writeFileSync(htmlPath, html);

      const page = await browser.newPage();
      await page.setViewportSize({ width, height });
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: pngPath, type: 'png' });
      await page.close();
      console.log(`Done: ${name}${suffix}.png`);
    }
  }

  // Generate 4:5 versions of existing posts 1-5
  for (const name of existing1x1) {
    const htmlPath = path.join(OUTPUT_DIR, `${name}.html`);
    if (!fs.existsSync(htmlPath)) { console.log(`Skip ${name}: no HTML`); continue; }
    let html = fs.readFileSync(htmlPath, 'utf8');
    // Adjust for 4:5
    html = html.replace('height: 2160px;', 'height: 2700px;');
    html = html.replace('padding: 96px 100px 80px;', 'padding: 120px 100px 100px;');
    // Increase gap
    html = html.replace(/gap: 32px;/, 'gap: 44px;');

    const pngPath = path.join(OUTPUT_DIR, `${name}-4x5.png`);
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2160, height: 2700 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.screenshot({ path: pngPath, type: 'png' });
    await page.close();
    console.log(`Done: ${name}-4x5.png`);
  }

  // Also re-screenshot post02 1:1 (Fun Home posterExt fix)
  {
    const html = fs.readFileSync(path.join(OUTPUT_DIR, 'post02-top-musicals.html'), 'utf8');
    const page = await browser.newPage();
    await page.setViewportSize({ width: 2160, height: 2160 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'post02-top-musicals.png'), type: 'png' });
    await page.close();
    console.log('Re-screenshotted: post02-top-musicals.png (Fun Home fix)');
  }

  await browser.close();
  console.log('\nAll done!');
}

main().catch(console.error);
