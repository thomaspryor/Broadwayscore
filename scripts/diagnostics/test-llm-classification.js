#!/usr/bin/env node
/**
 * Runs the GPT-4o-mini classifier against the saved Apify trial fixtures
 * (tmp/twitter.json + tmp/tiktok.json for Maybe Happy Ending) so we can
 * iterate on the prompt without burning more Apify runs.
 *
 * Usage: node scripts/diagnostics/test-llm-classification.js
 */

const fs = require('fs');
const path = require('path');
const { classifyMentions } = require('../lib/social-pulse-llm');
const { normalizeTweet, normalizeTikTok } = require('../lib/apify-fetchers');

const TWITTER_FILE = path.join(__dirname, '..', '..', 'tmp', 'twitter.json');
const TIKTOK_FILE = path.join(__dirname, '..', '..', 'tmp', 'tiktok.json');

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY required');
    process.exit(1);
  }

  const tweets = JSON.parse(fs.readFileSync(TWITTER_FILE, 'utf-8')).map(normalizeTweet).filter(Boolean);
  const tiktoks = JSON.parse(fs.readFileSync(TIKTOK_FILE, 'utf-8')).map(normalizeTikTok).filter(Boolean);
  const mentions = [...tweets, ...tiktoks];

  console.log(`Classifying ${mentions.length} mentions (${tweets.length} X + ${tiktoks.length} TikTok)...\n`);

  const classified = await classifyMentions({
    mentions,
    showTitle: 'Maybe Happy Ending',
    marketLabel: 'Broadway',
    openaiApiKey: process.env.OPENAI_API_KEY,
  });

  const byStatus = { relevant: 0, irrelevant: 0 };
  const bySentiment = { positive: 0, mixed: 0, negative: 0 };
  const examples = { positive: [], mixed: [], negative: [], irrelevant: [] };

  for (const m of classified) {
    if (!m.relevant) {
      byStatus.irrelevant++;
      if (examples.irrelevant.length < 3) examples.irrelevant.push(m);
    } else {
      byStatus.relevant++;
      bySentiment[m.sentiment]++;
      if (examples[m.sentiment].length < 3) examples[m.sentiment].push(m);
    }
  }

  console.log(`Relevance: ${byStatus.relevant} relevant, ${byStatus.irrelevant} irrelevant\n`);
  console.log(`Sentiment (relevant only):`);
  const total = byStatus.relevant;
  for (const [k, v] of Object.entries(bySentiment)) {
    const pct = total === 0 ? 0 : Math.round((v / total) * 100);
    console.log(`  ${k.padEnd(10)}: ${String(v).padStart(2)}  (${pct}%)`);
  }

  console.log('\n=== Examples by classification ===\n');
  for (const [label, items] of Object.entries(examples)) {
    if (items.length === 0) continue;
    console.log(`--- ${label.toUpperCase()} ---`);
    for (const m of items) {
      const snippet = m.text.replace(/\s+/g, ' ').slice(0, 140);
      console.log(`  [${m.platform}] ${m.author || '?'}: ${snippet}${m.text.length > 140 ? '…' : ''}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
