#!/usr/bin/env node
/**
 * Advisory Profitability Scorecard season share-card audit (BRO-6159).
 * Usage: node scripts/lib/audit-biz-og-coverage.js
 * Read-only: lists missing PNGs and the renderer command; always exits 0.
 * Also runs in the daily health check as a warning row.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { seasonsWithData, seasonCard } = require('./biz-og-cards');
const { exitOnHelp } = require('./cli-help');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECK_NAME = 'Commercial: season share cards';
const RENDER_HINT = 'Run node scripts/generate-biz-og-images.js (requires Chromium) and commit the missing season PNGs.';

function auditBizOgCoverage(root = ROOT) {
  const shows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const commercial = JSON.parse(fs.readFileSync(path.join(root, 'data', 'commercial.json'), 'utf8'));
  const seasons = seasonsWithData(shows, commercial);
  const missing = seasons.filter(season => {
    try {
      return !fs.statSync(path.join(root, 'public', 'og', 'biz', `${seasonCard(season).slug}.png`)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  });
  return { seasons, missing };
}

function checkBizOgCoverage(root = ROOT) {
  try {
    const { seasons, missing } = auditBizOgCoverage(root);
    return {
      name: CHECK_NAME,
      status: missing.length ? 'warn' : 'pass',
      message: missing.length
        ? `Missing custom share cards for ${missing.length}/${seasons.length} commercial seasons: ${missing.map(season => `season-${season}.png`).join(', ')}`
        : `All ${seasons.length} commercial seasons have custom share cards`,
      ...(missing.length ? { hint: RENDER_HINT } : {}),
    };
  } catch (error) {
    return { name: CHECK_NAME, status: 'warn', message: `Could not audit season share cards: ${error.message}`, hint: RENDER_HINT };
  }
}

module.exports = { auditBizOgCoverage, checkBizOgCoverage, CHECK_NAME, RENDER_HINT };

if (require.main === module) {
  exitOnHelp(module);
  const row = checkBizOgCoverage();
  console.log(`${row.status === 'warn' ? '::warning::' : ''}${row.name}: ${row.message}`);
  if (row.hint) console.log(row.hint);
}
