#!/usr/bin/env node
/**
 * S1-T1: API Spike — Verify OpenAI Deep Research async pattern
 * Tests the o4-mini-deep-research model to confirm:
 * 1. Correct API call pattern (sync vs polling vs background)
 * 2. Response structure
 * 3. Citation format
 * 4. Domain filtering works
 *
 * Usage: OPENAI_API_KEY=xxx node scripts/test-deep-research-api.js
 */

const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  console.log('🔬 Testing OpenAI Deep Research API...\n');

  const startTime = Date.now();

  try {
    // Try synchronous call first (simplest pattern)
    console.log('Calling o4-mini-deep-research (sync)...');
    const response = await client.responses.create({
      model: 'o4-mini-deep-research-2025-06-26',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'What was the capitalization (production budget) of the Broadway musical "Every Brilliant Thing" starring Daniel Radcliffe at the Hudson Theatre in 2026? Cite specific sources.' }]
        }
      ],
      tools: [
        {
          type: 'web_search_preview',
          search_context_size: 'medium'
        }
      ]
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Response received in ${elapsed}s`);
    console.log(`   Status: ${response.status}`);
    console.log(`   ID: ${response.id}`);
    console.log(`   Model: ${response.model}`);

    // Inspect output structure
    console.log(`\n📦 Output items: ${response.output?.length || 0}`);
    for (const item of (response.output || [])) {
      console.log(`   - type: ${item.type}, role: ${item.role || 'n/a'}`);
      if (item.content) {
        for (const c of item.content) {
          console.log(`     content type: ${c.type}`);
          if (c.type === 'output_text') {
            console.log(`     text length: ${c.text?.length || 0}`);
            console.log(`     text preview: ${(c.text || '').slice(0, 300)}...`);
            // Check citations
            const annotations = c.annotations || [];
            console.log(`\n📎 Citations: ${annotations.length}`);
            for (const ann of annotations.slice(0, 5)) {
              console.log(`     [${ann.type}] ${ann.title || 'no title'} → ${ann.url || 'no url'}`);
            }
          }
        }
      }
    }

    // Check usage/cost
    if (response.usage) {
      console.log('\n💰 Usage:');
      console.log(`   Input tokens: ${response.usage.input_tokens}`);
      console.log(`   Output tokens: ${response.usage.output_tokens}`);
      console.log(`   Total tokens: ${response.usage.total_tokens}`);

      // o4-mini pricing: $2/M input, $8/M output
      const inputCost = (response.usage.input_tokens / 1e6) * 2;
      const outputCost = (response.usage.output_tokens / 1e6) * 8;
      console.log(`   Estimated cost: $${(inputCost + outputCost).toFixed(4)}`);
    }

    console.log('\n🎯 Key findings:');
    console.log('   1. API pattern: synchronous (no polling needed)');
    console.log(`   2. Response time: ${elapsed}s`);
    console.log(`   3. Citations available: ${response.output?.slice(-1)?.[0]?.content?.[0]?.annotations?.length > 0 ? 'YES' : 'NO'}`);

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ Error after ${elapsed}s:`);
    console.error(`   Type: ${err.constructor.name}`);
    console.error(`   Message: ${err.message}`);
    console.error(`   Status: ${err.status || 'n/a'}`);
    console.error(`   Code: ${err.code || 'n/a'}`);

    // If it's a 400/404, the model name or API pattern might be wrong
    if (err.status === 404) {
      console.error('\n💡 Model not found — try different model ID');
    }
    if (err.status === 400) {
      console.error('\n💡 Bad request — API pattern may differ from standard responses');
      console.error('   Full error:', JSON.stringify(err.error || err.message, null, 2));
    }

    process.exit(1);
  }
}

main();
