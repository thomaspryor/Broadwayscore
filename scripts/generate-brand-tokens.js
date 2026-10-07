#!/usr/bin/env node
/**
 * generate-brand-tokens.js
 *
 * Generates public/brand-tokens.json from scripts/lib/brand-colors.js.
 * This makes the design system machine-readable at
 * https://broadwayscorecard.com/brand-tokens.json
 *
 * Consumers: Figma plugins, Canva (manual copy-paste), Zapier, Apple Shortcuts,
 * anyone who wants programmatic access to the palette.
 *
 * Run: node scripts/generate-brand-tokens.js
 * Also runs automatically via "prebuild" in package.json.
 */

const fs = require('fs');
const path = require('path');
const BRAND = require('./lib/brand-colors');

const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'brand-tokens.json');

const tokens = {
  name: 'Broadway Scorecard Brand Tokens',
  version: '1.0.0',
  description: 'Canonical design system values for Broadway Scorecard. Suitable for Figma, Canva, email templates, and any tool that needs brand colors.',
  updated: new Date().toISOString().slice(0, 10),
  site: 'https://broadwayscorecard.com',
  brand: BRAND.brand,
  surface: BRAND.surface,
  market: BRAND.market,
  scores: BRAND.scores,
  accents: BRAND.accents,
  text: BRAND.text,
  status: BRAND.status,
  font: BRAND.font,
  gradients: BRAND.gradients,
  assets: {
    logoMain: 'https://broadwayscorecard.com/images/logo-white.png',
    logoFantasy: 'https://broadwayscorecard.com/images/fantasy/bfl-logo.png',
    paletteSvg: 'https://broadwayscorecard.com/brand-kit/palette.svg',
    ogImage: 'https://broadwayscorecard.com/og/home.png',
  },
  canva: {
    instructions: 'https://broadwayscorecard.com/brand#canva',
    brandKitColors: [
      { name: 'BWSC Gold', hex: BRAND.brand.gold },
      { name: 'BWSC Gold Hover', hex: BRAND.brand.goldHover },
      { name: 'BWSC Surface', hex: BRAND.surface.default },
      { name: 'BWSC Surface Raised', hex: BRAND.surface.raised },
      { name: 'West End Pink', hex: BRAND.market.westEnd },
      { name: 'Score: Must See', hex: BRAND.scores.mustSee.solid },
      { name: 'Score: Recommended', hex: BRAND.scores.great.solid },
      { name: 'Score: Worth Seeing', hex: BRAND.scores.good.solid },
      { name: 'Score: Skippable', hex: BRAND.scores.tepid.solid },
      { name: 'Score: Critical Miss', hex: BRAND.scores.skip.solid },
    ],
  },
};

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(tokens, null, 2) + '\n');

const sizeKb = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);
console.log(`✓ Generated public/brand-tokens.json (${sizeKb} KB)`);
console.log(`  URL: https://broadwayscorecard.com/brand-tokens.json`);
