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

const { buildBroadcastOpeningNightHtml, buildBroadcastSubjectLine } = require('./lib/email-templates');

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
  // Check for the section wrapper string rather than the word "Critics" which could appear elsewhere
  assert("omits Critics' Take when consensusText is null", !html.includes('text-transform:uppercase;letter-spacing:0.8px'), "Critics' Take section wrapper rendered without consensus");
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
  assert('multi-show: Show A has no Negative bar segment', (() => {
    // Bar segments use `height:8px;background-color:COLOR` — checking specifically for the
    // bar context (not score badges or label swatches which also use these colors).
    // Show B has negative=2 → exactly 1 red bar segment. Show A has negative=0 → 0.
    const count = (html.match(/height:8px;background-color:#ef4444/g) || []).length;
    return count === 1;
  })(), 'red bar segment appeared != 1 time — Show A (negative=0) may have rendered one');
}

// ─── All-Rave (Critical Gold) ─────────────────────────────────────────────────
// Most important broadcast scenario — a full-rave show is the highest-stakes email.
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 12, positive: 0, mixed: 0, negative: 0, reviewCount: 12 })], null, 'broadway');
  assert('all-Rave: Rave label rendered', html.includes('>12</span> Rave'));
  assert('all-Rave: no other labels', !html.includes('Positive') && !html.includes('Mixed') && !html.includes('Negative'));
  assert('all-Rave: only gold bar segment', (() => {
    // Use `height:8px;background-color:` to target only bar segments (not score badges or swatches)
    return html.includes('height:8px;background-color:#FFD700') &&
           !html.includes('height:8px;background-color:#22c55e') &&
           !html.includes('height:8px;background-color:#d97706') &&
           !html.includes('height:8px;background-color:#ef4444');
  })(), 'non-gold bar segment appeared in all-Rave show');
}

// ─── Percentage rounding: bar and label must stay in sync ─────────────────────
// Regression for the bug where large buckets rounding up pushed a small bucket's
// bar width to 0 while the label row still showed the non-zero count.
{
  // rave=50, positive=1, mixed=1, negative=49: rave+negative round up → posW historically hit 0
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 50, positive: 1, mixed: 1, negative: 49 })], null, 'broadway');
  assert('rounding: Positive bar segment present when positive > 0', html.includes('background-color:#22c55e'));
  assert('rounding: Mixed bar segment present when mixed > 0', html.includes('background-color:#d97706'));
  assert('rounding: Positive label present', html.includes('Positive'));
}

// ─── West End market ─────────────────────────────────────────────────────────
{
  const html = buildBroadcastOpeningNightHtml([makeShow({ rave: 3, positive: 4, mixed: 0, negative: 0 })], null, 'west-end');
  assert('West End: pink brand color used', html.includes('#f472b6'));
  assert('West End: Mixed label absent when mixed === 0', !html.includes('Mixed'), 'Mixed rendered but mixed=0');
}

// ─── Unsubscribe link ────────────────────────────────────────────────────────
console.log('\n── Unsubscribe link ──\n');

{
  // Broadcast draft (email=null) must use Resend's template variable — not a hardcoded URL.
  // If this is wrong, the Resend editor will show a broken unsubscribe link and CAN-SPAM fails.
  const html = buildBroadcastOpeningNightHtml([makeShow()], null, 'broadway');
  assert('broadcast draft: uses Resend unsubscribe variable', html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));
  assert('broadcast draft: no hardcoded email in unsubscribe href', !html.includes('unsubscribe?email='));
}

{
  // Preview send (email provided) must use custom URL, not the Resend variable.
  const html = buildBroadcastOpeningNightHtml([makeShow()], 'test@example.com', 'broadway');
  assert('preview: uses custom unsubscribe URL', html.includes('unsubscribe?email=test%40example.com'));
  assert('preview: no Resend unsubscribe variable', !html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));
}

{
  // West End unsubscribe URL includes market param so WE subscribers land on correct page.
  const html = buildBroadcastOpeningNightHtml([makeShow()], 'we@example.com', 'west-end');
  assert('West End preview: unsubscribe URL includes market=west-end', html.includes('market=west-end'));
}

// ─── Subject line ────────────────────────────────────────────────────────────
console.log('\n── Subject line ──\n');

{
  const single = [makeShow({ showTitle: 'Proof' })];
  assert('single-show: mentions show title', buildBroadcastSubjectLine(single).includes('Proof'));
  assert('single-show: no count prefix', !buildBroadcastSubjectLine(single).match(/^\d/));
  assert('single-show: same for broadway and west-end',
    buildBroadcastSubjectLine(single, 'broadway') === buildBroadcastSubjectLine(single, 'west-end'));
}

{
  const two = [makeShow({ showTitle: 'Show A' }), makeShow({ showTitle: 'Show B' })];
  assert('multi-show broadway: says "on Broadway"', buildBroadcastSubjectLine(two, 'broadway').includes('on Broadway'));
  assert('multi-show west-end: says "in the West End"', buildBroadcastSubjectLine(two, 'west-end').includes('in the West End'));
  assert('multi-show: includes show count', buildBroadcastSubjectLine(two, 'broadway').includes('2'));
  assert('multi-show: does not include individual show names', !buildBroadcastSubjectLine(two, 'broadway').includes('Show A'));
}

{
  // Subject must never contain words that trigger the FORBIDDEN_SUBJECT_WORDS safety abort.
  // See send-opening-night-broadcast.js FORBIDDEN_SUBJECT_WORDS check.
  const FORBIDDEN = ['test', 'ignore', 'debug', 'tracking'];
  const show = makeShow({ showTitle: 'The Outsiders' });
  const sub = buildBroadcastSubjectLine([show]);
  const hit = FORBIDDEN.find(w => sub.toLowerCase().includes(w));
  assert('subject: no forbidden words for normal show title', !hit, `found forbidden word "${hit}" in: ${sub}`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
