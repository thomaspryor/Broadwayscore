#!/usr/bin/env node
/**
 * Export detailed weekly recoupment waterfall for one or more shows.
 * Produces a CSV that shows every calculation step per week —
 * designed for a Broadway investor to audit in a spreadsheet.
 *
 * Usage:
 *   node scripts/export-model-detail.js --show=hamilton
 *   node scripts/export-model-detail.js --show=hamilton --output=~/Desktop/
 *   node scripts/export-model-detail.js --all --output=~/Desktop/model-export/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  calculateRecoupment, calculateLifetimeRecoupment,
  classifyShow, getBaseVariableRate, estimateWeeklyNut,
  calcWeeklyProfit, calcTheaterOverage,
  SCENARIO_MULTIPLIERS, PREVIEW_DEFAULTS, RESERVE_FUND_WEEKS,
} = require('./lib/recoupment-model');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const GROSSES_HISTORY_PATH = path.join(DATA_DIR, 'grosses-history.json');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA_DIR, 'commercial.json'))
  ? path.join(DATA_DIR, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');

const args = process.argv.slice(2);
const SHOW_SLUG = args.find(a => a.startsWith('--show='))?.split('=')[1];
const OUTPUT_DIR = args.find(a => a.startsWith('--output='))?.split('=')[1]?.replace('~', os.homedir()) || path.join(os.homedir(), 'Documents', 'claude-outputs');
// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Load data
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const allShows = Object.values(showsData.shows);
const grosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));
const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
let grossesHistory = { weeks: {} };
try { grossesHistory = JSON.parse(fs.readFileSync(GROSSES_HISTORY_PATH, 'utf8')); } catch {}

// Slug resolution (same as merge script)
const weeklyHistorySlugs = new Set();
for (const s of Object.values(grossesHistory.weeks || {})) for (const k of Object.keys(s)) weeklyHistorySlugs.add(k);

function getWeeklyData(slug, showId) {
  const candidates = [slug, showId, slug.replace(/-\d{4}$/, ''), showId?.replace(/-\d{4}$/, '')].filter(Boolean);
  let resolved = null;
  for (const c of candidates) { if (weeklyHistorySlugs.has(c)) { resolved = c; break; } }
  if (!resolved) for (const s of weeklyHistorySlugs) {
    const base = slug.replace(/-\d{4}$/, '');
    if (s.startsWith(base + '-') || s === base) { resolved = s; break; }
  }
  if (!resolved) return null;
  const weekly = {};
  for (const [d, shows] of Object.entries(grossesHistory.weeks)) { if (shows[resolved]) weekly[d] = shows[resolved]; }
  return Object.keys(weekly).length > 0 ? weekly : null;
}

function getGrossesAllTime(slug, showId) {
  const base = slug.replace(/-\d{4}$/, '');
  return grosses.shows?.[slug]?.allTime || grosses.shows?.[showId]?.allTime || grosses.shows?.[base]?.allTime || null;
}

function exportShow(slug) {
  const show = allShows.find(s => s.slug === slug || s.id === slug)
    || allShows.find(s => s.slug === slug.replace(/-\d{4}$/, ''));
  if (!show) { console.log('Show not found:', slug); return; }

  const comm = commercial.shows[slug] || commercial.shows[show.slug] || {};
  if (!comm.capitalization) { console.log('No capitalization for:', slug); return; }

  const category = classifyShow(show);
  const baseVarRate = getBaseVariableRate(category);
  const weeklyNut = comm.weeklyRunningCost || estimateWeeklyNut(show, comm);
  const nutSource = comm.weeklyRunningCost ? 'reported' : 'estimated';

  // Build the same schedule the model uses
  const grossAllTime = getGrossesAllTime(slug, show.id);
  const weeklyData = getWeeklyData(slug, show.id);

  // Get full model result for summary
  const result = calculateRecoupment(show, comm, grossAllTime, weeklyData);
  if (result.error) { console.log('Model error for', slug, ':', result.error); return; }

  // --- Build CSV ---
  const lines = [];

  // Header section: model assumptions
  lines.push('BROADWAY RECOUPMENT MODEL — DETAILED WEEKLY WATERFALL');
  lines.push('');
  lines.push('SHOW,' + show.title);
  lines.push('SLUG,' + slug);
  lines.push('TYPE,' + (show.type || 'unknown'));
  lines.push('CATEGORY,' + category);
  lines.push('STATUS,' + (show.status || 'unknown'));
  lines.push('OPENED,' + (show.openingDate || ''));
  lines.push('CLOSED,' + (show.closingDate || 'still running'));
  lines.push('VENUE,' + (show.venue || ''));
  lines.push('');

  lines.push('=== MODEL INPUTS ===');
  lines.push('Capitalization (reported),' + comm.capitalization);
  lines.push('SVOG Grant,' + (result.svogGrant || 0));
  lines.push('Tax Credit,' + (result.taxCreditAmount || 0));
  lines.push('Reserve Fund,' + (result.reserveFund || 0));
  lines.push('Effective Capitalization,' + result.effectiveCapitalization);
  lines.push('');
  lines.push('Weekly Nut (' + nutSource + '),' + weeklyNut);
  lines.push('Base Variable Cost Rate,' + (baseVarRate * 100).toFixed(1) + '%');
  lines.push('Theater Rent in Nut (12%),' + Math.round(weeklyNut * 0.12));
  lines.push('Theater Gross Pct (7%),' + '7%');
  lines.push('Weekly Breakeven,' + result.weeklyBreakeven);
  lines.push('');

  lines.push('=== MODEL ASSUMPTIONS ===');
  lines.push('Variable costs include,CC fees (2.5%) + group sales commission (1.5%) + author royalty (' + (show.type === 'play' ? '5.5' : '4.5') + '%) + director (1.5%) + other (1%)');
  lines.push('Post-recoup change,Author royalty removed from variable rate; 35% royalty pool deducted from operating profit');
  lines.push('Theater overage,max(0 gross*7% - rent_in_nut) — only the excess above fixed rent already in nut');
  lines.push('Cost phases,Weeks 1-52: full nut | Weeks 53-104: nut*0.93 | Weeks 105+: nut*0.88');
  lines.push('Preview costs,Nut * 1.25 (overtime/tech)');
  lines.push('Preview gross ramp,Week 1: 45% | Week 2: 60% | Week 3: 75% | Week 4+: 85% of stabilized');
  lines.push('Marketing surcharge (opening),First 8 weeks: +$' + (category.includes('musical') ? '150' : '75') + 'K/wk above nut');
  lines.push('Closing costs,' + (show.closingDate ? 'Applied (show closed)' : 'N/A (still running)'));
  lines.push('');

  lines.push('=== RESULTS SUMMARY ===');
  lines.push('Recoup % (Pessimistic),' + result.recoupmentPctLow);
  lines.push('Recoup % (Central),' + result.recoupmentPctCentral);
  lines.push('Recoup % (Optimistic),' + result.recoupmentPctHigh);
  lines.push('Model Says Recouped,' + (result.modelRecouped ? 'YES' : 'NO'));
  lines.push('Known Recouped,' + (comm.recouped === true ? 'YES' : comm.recouped === false ? 'NO' : 'UNKNOWN'));
  lines.push('Designation,' + (comm.designation || 'TBD'));
  lines.push('Data Quality,' + result.dataQuality);
  lines.push('Gross Data Source,' + result.grossDataSource);
  if (result.warnings?.length) lines.push('Warnings,"' + result.warnings.join('; ') + '"');
  lines.push('');
  lines.push('');

  // Weekly waterfall (central scenario)
  lines.push('=== WEEKLY WATERFALL (CENTRAL SCENARIO) ===');
  lines.push([
    'Week', 'Phase', 'Weekly Gross', 'Variable Costs', 'Variable Rate',
    'Theater Overage', 'Fixed Costs (nut)', 'Marketing Surcharge',
    'Star Deal Cost', 'Operating Profit', 'Royalty Pool (post-recoup)',
    'Net Profit', 'Cumulative Profit', 'Recoup %', 'Recouped?'
  ].join(','));

  // Rebuild the weekly schedule
  const weeklyScheduleData = weeklyData || {};
  const weekDates = Object.keys(weeklyScheduleData).sort();
  const hasWeekly = weekDates.length > 0;

  // Get preview weeks
  let previewWeeks = 0;
  if (show.previewsStartDate && show.openingDate) {
    previewWeeks = Math.min(Math.max(Math.round((new Date(show.openingDate) - new Date(show.previewsStartDate)) / (7*86400000)), 0), 8);
  }

  // Build gross schedule
  const schedule = [];
  if (hasWeekly) {
    const avgGross = weekDates.reduce((s,d) => s + (weeklyScheduleData[d]?.gross||0), 0) / weekDates.length;
    for (let pw = 1; pw <= previewWeeks; pw++) {
      const mult = pw <= 1 ? 0.45 : pw <= 2 ? 0.60 : pw <= 3 ? 0.75 : 0.85;
      schedule.push({ gross: avgGross * mult, isPreview: true, source: 'preview-est' });
    }
    const gapWeeks = Math.max(result.totalRunWeeks - previewWeeks - weekDates.length, 0);
    for (let w = 0; w < gapWeeks; w++) schedule.push({ gross: avgGross, isPreview: false, source: 'gap-est' });
    for (const d of weekDates) schedule.push({ gross: weeklyScheduleData[d].gross, isPreview: false, source: 'actual' });
  }

  // Simulate
  const mult = SCENARIO_MULTIPLIERS.central;
  let cumProfit = 0;
  let isPostRecoup = false;
  const authorRate = show.type === 'play' ? 0.055 : 0.045;

  // Star deal
  const KNOWN_STAR_DEALS = {
    'the-music-man-2022': { weeklyPremium: 350000, grossPct: 0.08, grossThreshold: 1200000 },
    'hells-kitchen': { weeklyPremium: 75000, grossPct: 0.03, grossThreshold: 1000000 },
    'gypsy-2024': { weeklyPremium: 100000, grossPct: 0.02, grossThreshold: 1200000 },
  };
  const starDeal = KNOWN_STAR_DEALS[slug] || null;

  const effectiveCap = result.effectiveCapitalization;
  const isClosed = show.closingDate && new Date(show.closingDate) < new Date();
  const maxWeeks = Math.min(schedule.length, 520);

  for (let i = 0; i < maxWeeks; i++) {
    const week = schedule[i];
    const weekNum = i + 1;
    const adjGross = week.gross * mult.grossAdj;

    // Variable costs
    let effVarRate = baseVarRate;
    if (isPostRecoup) effVarRate = baseVarRate - authorRate;
    const varCosts = adjGross * effVarRate * mult.variableCost;

    // Theater overage
    const rentInNut = weeklyNut * 0.12;
    const theaterOverage = Math.max(0, adjGross * 0.07 - rentInNut);

    // Fixed costs
    let fixedCosts = weeklyNut * mult.fixedCost;
    if (weekNum > 104) fixedCosts *= 0.88;
    else if (weekNum > 52) fixedCosts *= 0.93;
    if (week.isPreview) fixedCosts *= 1.25;

    // Marketing
    const mktgKey = category.includes('Spectacle') ? 'musicalSpectacle' : category;
    const mktgAmounts = { musicalSpectacle: 200000, musical: 150000, play: 75000, playStar: 75000, special: 50000 };
    const marketingSurcharge = weekNum <= 8 ? (mktgAmounts[category] || 75000) : 0;

    // Star deal
    let starCost = 0;
    if (starDeal) {
      starCost = starDeal.weeklyPremium + Math.max(0, adjGross - starDeal.grossThreshold) * starDeal.grossPct;
    }

    // Operating profit
    let opProfit = adjGross - varCosts - theaterOverage - fixedCosts - marketingSurcharge;

    // Royalty pool
    let royaltyPool = 0;
    if (isPostRecoup && opProfit > 0) {
      royaltyPool = opProfit * 0.35;
      opProfit -= royaltyPool;
    }

    const netProfit = opProfit - starCost;
    cumProfit += netProfit;

    const recoupPct = (cumProfit / effectiveCap * 100).toFixed(1);
    const phase = week.isPreview ? 'Preview' : (weekNum <= 52 ? 'Year 1' : weekNum <= 104 ? 'Year 2' : 'Year 3+');

    if (!isPostRecoup && cumProfit >= effectiveCap) isPostRecoup = true;

    lines.push([
      weekNum, phase,
      Math.round(adjGross), Math.round(varCosts), (effVarRate * 100).toFixed(1) + '%',
      Math.round(theaterOverage), Math.round(fixedCosts), marketingSurcharge,
      Math.round(starCost), Math.round(opProfit + royaltyPool), Math.round(royaltyPool),
      Math.round(netProfit), Math.round(cumProfit), recoupPct,
      cumProfit >= effectiveCap ? 'YES' : 'no'
    ].join(','));
  }

  // Tax credit at end for closed shows
  if (isClosed && result.taxCreditAmount) {
    cumProfit += result.taxCreditAmount;
    lines.push(['TAX CREDIT', '', '', '', '', '', '', '', '', '', '', result.taxCreditAmount, Math.round(cumProfit), (cumProfit / effectiveCap * 100).toFixed(1), cumProfit >= effectiveCap ? 'YES' : 'no'].join(','));
  }

  // Write file
  const filename = slug + '-recoupment-model.csv';
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, lines.join('\n'));
  console.log('Exported:', filepath, '(' + schedule.length + ' weeks)');
}

if (!SHOW_SLUG) {
  console.log('Usage: node scripts/export-model-detail.js --show=SLUG [--output=DIR]');
  console.log('Example: node scripts/export-model-detail.js --show=hamilton');
  process.exit(1);
}

exportShow(SHOW_SLUG);
