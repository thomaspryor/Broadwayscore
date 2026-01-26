#!/usr/bin/env node

/**
 * AI Citation Checker
 *
 * Tests Broadway Scorecard visibility in AI responses.
 * Uses Claude API to simulate checking prompts.
 *
 * Usage: ANTHROPIC_API_KEY=xxx node scripts/check-ai-citations.js
 *
 * Note: This is a simplified check using Claude. For comprehensive
 * monitoring across ChatGPT, Perplexity, and Gemini, use:
 * - HubSpot AEO Grader (free): https://www.hubspot.com/aeo-grader
 * - Otterly.ai (paid): https://otterly.ai
 */

const Anthropic = require('@anthropic-ai/sdk');

// Test prompts - these are queries where Broadway Scorecard should appear
const TEST_PROMPTS = [
  "What is the best Broadway show right now?",
  "Where can I find aggregated Broadway show reviews?",
  "What are the best Broadway musicals for kids?",
  "How do I get cheap Broadway tickets?",
  "What Broadway shows have lottery tickets?",
  "Is Hamilton worth seeing?",
  "Broadway show ratings and scores",
  "Best Broadway review aggregator",
  "Broadway box office grosses this week",
  "What is the highest rated Broadway musical?",
];

// Keywords that indicate Broadway Scorecard is being referenced
const CITATION_INDICATORS = [
  'broadway scorecard',
  'broadwayscorecard',
  'broadway score card',
  'aggregated critic scores',
  'composite score for broadway',
];

async function checkCitation(client, prompt) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nPlease provide a helpful answer with specific recommendations and cite your sources where relevant.`
        }
      ]
    });

    const text = response.content[0].text.toLowerCase();

    // Check for citations
    const isCited = CITATION_INDICATORS.some(indicator =>
      text.includes(indicator.toLowerCase())
    );

    // Check for competitor mentions
    const competitors = {
      'Show Score': text.includes('show-score') || text.includes('showscore') || text.includes('show score'),
      'Did They Like It': text.includes('didtheylikeit') || text.includes('did they like it'),
      'BroadwayWorld': text.includes('broadwayworld') || text.includes('broadway world'),
      'Playbill': text.includes('playbill'),
      'TheaterMania': text.includes('theatermania'),
    };

    return {
      prompt,
      cited: isCited,
      response: response.content[0].text.substring(0, 500) + '...',
      competitors: Object.entries(competitors)
        .filter(([_, mentioned]) => mentioned)
        .map(([name]) => name),
    };
  } catch (error) {
    return {
      prompt,
      error: error.message,
    };
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable required');
    console.log('\nUsage: ANTHROPIC_API_KEY=xxx node scripts/check-ai-citations.js');
    console.log('\nAlternatively, use these free tools:');
    console.log('- HubSpot AEO Grader: https://www.hubspot.com/aeo-grader');
    console.log('- Manual testing in ChatGPT, Perplexity, Gemini');
    process.exit(1);
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  console.log('='.repeat(60));
  console.log('Broadway Scorecard AI Citation Check');
  console.log('='.repeat(60));
  console.log(`\nTesting ${TEST_PROMPTS.length} prompts...\n`);

  const results = [];
  let citedCount = 0;
  const competitorMentions = {};

  for (const prompt of TEST_PROMPTS) {
    console.log(`Testing: "${prompt.substring(0, 50)}..."`);
    const result = await checkCitation(client, prompt);
    results.push(result);

    if (result.cited) {
      citedCount++;
      console.log(`  ✅ CITED`);
    } else {
      console.log(`  ❌ Not cited`);
    }

    if (result.competitors?.length > 0) {
      console.log(`  Competitors mentioned: ${result.competitors.join(', ')}`);
      result.competitors.forEach(comp => {
        competitorMentions[comp] = (competitorMentions[comp] || 0) + 1;
      });
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`\nCitation Rate: ${citedCount}/${TEST_PROMPTS.length} (${Math.round(citedCount/TEST_PROMPTS.length*100)}%)`);

  console.log('\nCompetitor Share of Voice:');
  Object.entries(competitorMentions)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => {
      console.log(`  ${name}: ${count}/${TEST_PROMPTS.length} (${Math.round(count/TEST_PROMPTS.length*100)}%)`);
    });

  console.log('\n' + '='.repeat(60));
  console.log('RECOMMENDATIONS');
  console.log('='.repeat(60));

  const uncitedPrompts = results.filter(r => !r.cited && !r.error);
  if (uncitedPrompts.length > 0) {
    console.log('\nPrompts where Broadway Scorecard was NOT cited:');
    uncitedPrompts.forEach(r => {
      console.log(`  - "${r.prompt}"`);
    });
    console.log('\nAction: Create/improve content targeting these queries.');
  }

  if (citedCount === 0) {
    console.log('\n⚠️  Broadway Scorecard was not cited in any response.');
    console.log('This is expected for a newer site. Focus on:');
    console.log('  1. Building more comprehensive content');
    console.log('  2. Adding unique data (box office, lottery prices)');
    console.log('  3. FAQ schema for common questions');
    console.log('  4. Getting backlinks from authoritative sources');
  }

  // Save results
  const outputPath = 'data/ai-citation-check.json';
  const fs = require('fs');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    citationRate: `${citedCount}/${TEST_PROMPTS.length}`,
    results,
    competitorMentions,
  }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(console.error);
