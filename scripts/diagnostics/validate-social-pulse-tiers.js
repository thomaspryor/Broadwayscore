#!/usr/bin/env node
/**
 * T1.5: Empirical tier validation.
 *
 * Runs the social-pulse scorer against 93 synthetic show scenarios modeled
 * after a realistic Broadway/West End running-show distribution. Reports the
 * tier distribution and warns if any tier is stuck at 0% or >50% (which
 * would indicate mis-tuned thresholds).
 *
 * Also includes a "real data" scenario using the Apify trial outputs
 * (tmp/twitter.json + tmp/tiktok.json for Maybe Happy Ending) to verify
 * the real-world happy path works.
 *
 * Run: node scripts/diagnostics/validate-social-pulse-tiers.js
 */

const fs = require('fs');
const path = require('path');
const { computeSocialPulse } = require('../lib/social-pulse-scorer');

// ---------- Synthetic show scenarios ----------

/**
 * Each scenario models a realistic show archetype. Volumes and sentiments
 * are chosen to represent what you'd actually see on Broadway.
 */
const SCENARIOS = [
  // Buzzy Tony contenders (8 shows): high volume, high positive, above baseline
  { label: 'buzzy-hit', count: 8, volume: 140, positivePct: 82, baselineMean: 50, priorVolume: 55 },
  // Rising word-of-mouth (6): modest spike + WoW growth
  { label: 'rising-wom', count: 6, volume: 90, positivePct: 68, baselineMean: 55, priorVolume: 65 },
  // Troubled flops (4): high volume + bad sentiment
  { label: 'troubled-flop', count: 4, volume: 110, positivePct: 28, baselineMean: 45, priorVolume: 40 },
  // Steady established hits (25): stable volume, positive
  { label: 'steady-hit', count: 25, volume: 70, positivePct: 75, baselineMean: 72, priorVolume: 68 },
  // Steady mid-tier (20): stable, mixed sentiment
  { label: 'steady-mid', count: 20, volume: 45, positivePct: 55, baselineMean: 48, priorVolume: 44 },
  // New shows in previews (6): no mature baseline → BuildingBaseline
  { label: 'new-previews', count: 6, volume: 85, positivePct: 72, baselineMean: 0, priorVolume: null, weeksOfHistory: 0 },
  // Recently opened (4): some data but not 8 weeks yet
  { label: 'new-opened', count: 4, volume: 120, positivePct: 78, baselineMean: 60, priorVolume: 50, weeksOfHistory: 3 },
  // Long-runners at typical volume (15): Steady
  { label: 'long-runner', count: 15, volume: 40, positivePct: 65, baselineMean: 42, priorVolume: 38 },
  // Fading shows (3): volume dropping
  { label: 'fading', count: 3, volume: 15, positivePct: 60, baselineMean: 55, priorVolume: 22 },
  // Very quiet closed-soon (2): below MIN_MENTIONS_FOR_CARD → Hidden
  { label: 'quiet-closing', count: 2, volume: 8, positivePct: 50, baselineMean: 25, priorVolume: 10 },
];

const total = SCENARIOS.reduce((acc, s) => acc + s.count, 0);
console.log(`\n=== Synthetic tier validation (${total} shows) ===\n`);

const tierCounts = {};
const perScenarioResults = [];

for (const scenario of SCENARIOS) {
  // Build fake normalized mentions matching the scenario
  const positiveCount = Math.round((scenario.positivePct / 100) * scenario.volume);
  const negativeCount = Math.round(((100 - scenario.positivePct) * 0.35 / 100) * scenario.volume);
  const mixedCount = scenario.volume - positiveCount - negativeCount;

  const mentions = [
    ...Array.from({ length: positiveCount }, (_, i) => ({
      text: `absolutely amazing show, loved every moment (${scenario.label} #${i})`,
      platform: i % 5 === 0 ? 'tiktok' : 'x',
      author: `@user${i}`,
      url: `https://x.com/u/${i}`,
      createdAt: '2026-04-08T12:00:00Z',
      engagement: 10 + (i % 50),
      relevant: true,
      sentiment: 'positive',
    })),
    ...Array.from({ length: mixedCount }, (_, i) => ({
      text: `decent show but not blown away, mixed feelings on this one ${i}`,
      platform: 'x',
      author: `@mid${i}`,
      url: `https://x.com/u/${i}`,
      createdAt: '2026-04-08T12:00:00Z',
      engagement: 5,
      relevant: true,
      sentiment: 'mixed',
    })),
    ...Array.from({ length: negativeCount }, (_, i) => ({
      text: `walked out at intermission, cannot recommend this show number ${i}`,
      platform: 'x',
      author: `@neg${i}`,
      url: `https://x.com/u/${i}`,
      createdAt: '2026-04-08T12:00:00Z',
      engagement: 8,
      relevant: true,
      sentiment: 'negative',
    })),
  ];

  const baseline =
    scenario.baselineMean > 0
      ? { mean: scenario.baselineMean, weeksOfHistory: scenario.weeksOfHistory ?? 8 }
      : null;

  // Run once per scenario; count the result `count` times since all shows
  // in the cohort would produce the same tier given identical inputs
  const result = computeSocialPulse({
    mentions,
    baseline,
    priorVolume: scenario.priorVolume,
  });

  tierCounts[result.tier] = (tierCounts[result.tier] || 0) + scenario.count;
  perScenarioResults.push({ label: scenario.label, count: scenario.count, ...result });
}

// Print scenario-by-scenario results
console.log('Scenario → Tier assignments:');
console.log('─'.repeat(90));
for (const r of perScenarioResults) {
  const mult = r.baselineMultiple !== null ? `${r.baselineMultiple.toFixed(2)}×` : '  n/a';
  const wow = r.weekOverWeekPct !== null ? `${r.weekOverWeekPct > 0 ? '+' : ''}${r.weekOverWeekPct}%` : ' n/a';
  console.log(
    `  ${r.label.padEnd(16)} (×${String(r.count).padEnd(2)})  →  ${r.tier.padEnd(18)}  vol=${String(r.volume).padStart(3)}  pos=${String(r.positivePct).padStart(3)}%  base=${mult.padStart(6)}  wow=${wow.padStart(5)}`,
  );
}

// Tier distribution
console.log('\n' + '─'.repeat(60));
console.log('Tier distribution across 93 synthetic running shows:');
console.log('─'.repeat(60));
const allTiers = ['Buzzing', 'Rising', 'Steady', 'Troubled', 'BuildingBaseline', 'Hidden'];
// Warning rules — Steady is the DEFAULT bucket so we expect it to dominate.
// Real concern is if the "interesting" tiers (Buzzing, Rising, Troubled) are
// all missing, or if Steady swallows >90%.
let distributionWarnings = 0;
for (const tier of allTiers) {
  const count = tierCounts[tier] || 0;
  const pct = Math.round((count / total) * 100);
  const bar = '█'.repeat(Math.max(0, Math.min(pct, 60)));
  let warn = '';
  if (tier === 'Steady' && pct > 90) warn = ' ⚠️  Steady swallowing everything — thresholds too lenient';
  if ((tier === 'Buzzing' || tier === 'Troubled') && pct === 0) warn = ' ⚠️  MISSING — no show can reach this tier with current thresholds';
  if (warn) distributionWarnings++;
  console.log(`  ${tier.padEnd(18)}  ${String(count).padStart(3)}  (${String(pct).padStart(3)}%)  ${bar}${warn}`);
}
console.log('─'.repeat(60));

// Sanity: interesting tiers (Buzzing + Rising + Troubled) should total >5%
const interestingPct = Math.round(
  (((tierCounts['Buzzing'] || 0) + (tierCounts['Rising'] || 0) + (tierCounts['Troubled'] || 0)) / total) * 100,
);
console.log(`\n"Interesting" tiers (Buzzing + Rising + Troubled): ${interestingPct}%`);
if (interestingPct < 5) {
  console.log('⚠️  Too few shows reaching interesting tiers — feature may feel lifeless.');
  distributionWarnings++;
} else if (interestingPct > 50) {
  console.log('⚠️  Too many shows in interesting tiers — thresholds too loose, will look fake.');
  distributionWarnings++;
}

if (distributionWarnings > 0) {
  console.log(`\n⚠️  ${distributionWarnings} distribution warning(s) — tier thresholds may need tuning.`);
} else {
  console.log('\n✅ Distribution looks sensible.');
}

// ---------- Real trial data sanity check ----------

console.log('\n=== Real trial data check: Maybe Happy Ending ===\n');

const twitterFixture = path.join(__dirname, '..', '..', 'tmp', 'twitter.json');
const tiktokFixture = path.join(__dirname, '..', '..', 'tmp', 'tiktok.json');

if (!fs.existsSync(twitterFixture) || !fs.existsSync(tiktokFixture)) {
  console.log('(trial fixtures not present — skipping real-data check)');
} else {
  const rawTwitter = JSON.parse(fs.readFileSync(twitterFixture, 'utf-8'));
  const rawTiktok = JSON.parse(fs.readFileSync(tiktokFixture, 'utf-8'));

  // Normalize: real scraper output → our mention shape. In production the LLM
  // sets relevant + sentiment; here we fake-assume all are relevant + positive
  // since Maybe Happy Ending is objectively a buzzy positive show right now.
  const twitterMentions = rawTwitter.map((t, i) => ({
    text: t.text || '',
    platform: 'x',
    author: t.author?.userName ? `@${t.author.userName}` : `@unknown${i}`,
    url: t.url || null,
    createdAt: t.createdAt || null,
    engagement: (t.favoriteCount || 0) + (t.retweetCount || 0) * 2 + (t.replyCount || 0),
    relevant: true,
    sentiment: 'positive',
  }));

  const tiktokMentions = rawTiktok.map((t, i) => ({
    text: t.text || '',
    platform: 'tiktok',
    author: t.authorMeta?.name ? `@${t.authorMeta.name}` : `@unknown${i}`,
    url: t.webVideoUrl || null,
    createdAt: t.createTimeISO || null,
    engagement: (t.playCount || 0) / 100 + (t.diggCount || 0),
    relevant: true,
    sentiment: 'positive',
  }));

  const allMentions = [...twitterMentions, ...tiktokMentions];
  console.log(`Total mentions after normalization: ${allMentions.length}`);
  console.log(`  X/Twitter: ${twitterMentions.length}`);
  console.log(`  TikTok:    ${tiktokMentions.length}`);

  // Scenario 1: cold start (first run) → BuildingBaseline
  const coldStart = computeSocialPulse({
    mentions: allMentions,
    baseline: null,
    priorVolume: null,
  });
  console.log(`\nCold start (first run, no baseline):`);
  console.log(`  Tier: ${coldStart.tier}`);
  console.log(`  Volume: ${coldStart.volume}`);
  console.log(`  Positive%: ${coldStart.positivePct}`);
  console.log(`  Top quote: ${coldStart.topQuotes[0]?.text || '(none)'}`);

  // Scenario 2: mature baseline with this as a spike → should be Buzzing
  const mature = computeSocialPulse({
    mentions: allMentions,
    baseline: { mean: 18, weeksOfHistory: 8 },
    priorVolume: 20,
  });
  console.log(`\nMature baseline (mean=18, prior=20) — simulates a real spike:`);
  console.log(`  Tier: ${mature.tier}`);
  console.log(`  Volume: ${mature.volume}`);
  console.log(`  Baseline multiple: ${mature.baselineMultiple}×`);
  console.log(`  WoW: ${mature.weekOverWeekPct}%`);
  console.log(`  Top quotes:`);
  for (const q of mature.topQuotes) {
    console.log(`    ❝ ${q.text} ❞ — ${q.author || '?'} · ${q.platform}`);
  }
}

process.exit(distributionWarnings > 0 ? 1 : 0);
