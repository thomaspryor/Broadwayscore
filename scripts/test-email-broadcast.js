#!/usr/bin/env node
/**
 * Tests for scripts/lib/email-templates.js — broadcast email rendering.
 *
 * Covers the Apr 2026 bugs where:
 *   1. rave count was dropped from the data pipeline (stats.rave not forwarded)
 *   2. Zero-count buckets were rendered (e.g. "0 Negative" when negative=0)
 *   3. Color swatches were missing from the label row
 *   4. Two independent label row instances got out of sync
 *
 * Run: node scripts/test-email-broadcast.js
 */

const { buildBroadcastOpeningNightHtml } = require('./lib/email-templates');

// Minimal show fixture matching the interface from send-opening-night-broadcast.js
function makeShow(overrides = {}) {
  return {
    showTitle: 'Test Show',
    score: 75,
    reviewCount: 12,
    rave: 4,
    positive: 5,
    mixed: 3,
    negative: 0,
    consensusText: 'A strong production.',
    showType: 'Play',
    venue: 'Test Theatre',
    showUrl: 'https://broadwayscorecard.com/show/test-show-2026',
    imageUrl: null,
    showId: 'test-show-2026',
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

console.log('\n── buildBroadcastOpeningNightHtml ──\n');

// ─── Zero-bucket filtering ───────────────────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 8, positive: 4, mixed: 7, negative: 0 })], null, 'broadway');
  assert('renders Rave label when rave > 0', html.includes('>8</span> Rave'));
  assert('renders Positive label when positive > 0', html.includes('>4</span> Positive'));
  assert('renders Mixed label when mixed > 0', html.includes('>7</span> Mixed'));
  assert('omits Negative label when negative === 0', !html.includes('Negative'), 'found "Negative" in output');
}

{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 0, positive: 3, mixed: 2, negative: 1 })], null, 'broadway');
  assert('omits Rave label when rave === 0', !html.includes('Rave'), 'found "Rave" in output');
  assert('renders Negative label when negative > 0', html.includes('>1</span> Negative'));
}

// ─── Color swatches ───────────────────────────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 5, positive: 3, mixed: 2, negative: 0 })], null, 'broadway');
  assert('rave swatch uses gold color', html.includes('background-color:#FFD700'));
  assert('positive swatch uses green color', html.includes('background-color:#22c55e'));
  assert('mixed swatch uses amber color', html.includes('background-color:#d97706'));
  assert('negative swatch absent when negative === 0', !html.includes('background-color:#ef4444'), 'red swatch rendered but negative=0');
  assert('swatch is an 8px square span', html.includes('width:8px;height:8px;border-radius:2px'));
}

{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 0, positive: 0, mixed: 0, negative: 2 })], null, 'broadway');
  assert('negative swatch uses red color', html.includes('background-color:#ef4444'));
  assert('gold swatch absent when rave=0', !html.includes('background-color:#FFD700'), 'gold swatch rendered but rave=0');
}

// ─── All-zero breakdown → no bar rendered ────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 0, positive: 0, mixed: 0, negative: 0, reviewCount: 0 })], null, 'broadway');
  assert('no bar segment when all counts are zero', !html.includes('height:8px;background-color'), 'bar segment rendered with all-zero breakdown');
  assert('no label row when all counts are zero', !html.includes('Rave') && !html.includes('Positive') && !html.includes('Mixed') && !html.includes('Negative'));
}

// ─── Critics' Take ───────────────────────────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ consensusText: 'Riveting theatre.' })], null, 'broadway');
  assert("renders Critics' Take when consensusText present", html.includes("Critics&#39; Take") || html.includes("Critics' Take"));
  assert('renders consensus text content', html.includes('Riveting theatre.'));
}

{
  const html = buildBroadcastOpeningNightHtml([makeShow({ consensusText: null })], null, 'broadway');
  assert("omits Critics' Take when consensusText is null", !html.includes("Critics"), "Critics' Take section rendered without consensus");
}

// ─── Multi-show (broadcast coalescing) ───────────────────────────────────────
{
  const shows = [
    makeShow({ showTitle: 'Show A', rave: 5, positive: 2, mixed: 1, negative: 0, showId: 'show-a-2026' }),
    makeShow({ showTitle: 'Show B', rave: 0, positive: 1, mixed: 3, negative: 2, showId: 'show-b-2026' }),
  ];
  const html = buildBroadcastOpeningNightHtml(shows, null, 'broadway');
  assert('multi-show: Show A rave label present', html.includes('>5</span> Rave'));
  assert('multi-show: Show B negative label present', html.includes('>2</span> Negative'));
  assert('multi-show: Show A has no Negative label', (() => {
    // Negative for Show A should not appear — check that "Negative" only appears once (for Show B)
    const count = (html.match(/\bNegative\b/g) || []).length;
    return count === 1;
  })(), 'Negative appeared more than once — Show A (negative=0) may have rendered it');
}

// ─── West End market ─────────────────────────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 3, positive: 4, mixed: 0, negative: 0 })], null, 'west-end');
  assert('West End: pink brand color used', html.includes('#f472b6'));
  assert('West End: Mixed label absent when mixed === 0', !html.includes('Mixed'), 'Mixed rendered but mixed=0');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
