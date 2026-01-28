#!/usr/bin/env node
/**
 * Get feedback on the /biz section plan from Claude and GPT
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx OPENAI_API_KEY=xxx node scripts/get-ai-feedback.js
 *
 * Or set the keys in your environment first.
 */

const fs = require('fs');
const path = require('path');

const PLAN_PATH = path.join(__dirname, '../docs/biz-section-plan.md');

const PROMPT = `You are reviewing a product plan. Please provide concise, actionable feedback.

The owner says: "The data itself is the value proposition. I don't need bells and whistles - just the right presentation."

## Plan Document

${fs.readFileSync(PLAN_PATH, 'utf-8')}

## Your Task

Answer these questions directly (total response under 400 words):

1. **Recommendation**: Option A, B, or C? Why?
2. **Cut**: What should be removed from the plan?
3. **Missing**: What high-value/low-effort feature is missing?
4. **Red flags**: Any UX or technical concerns?

Be direct and opinionated. No hedging.`;

async function askClaude() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('\n❌ ANTHROPIC_API_KEY not set - skipping Claude\n');
    return null;
  }

  console.log('🔵 Asking Claude...\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.log(`❌ Claude API error: ${error}\n`);
    return null;
  }

  const data = await response.json();
  return data.content[0].text;
}

async function askGPT() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('\n❌ OPENAI_API_KEY not set - skipping GPT\n');
    return null;
  }

  console.log('🟢 Asking GPT-4...\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.log(`❌ GPT API error: ${error}\n`);
    return null;
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Getting AI feedback on /biz section plan');
  console.log('='.repeat(60));

  const [claudeResponse, gptResponse] = await Promise.all([
    askClaude(),
    askGPT(),
  ]);

  if (claudeResponse) {
    console.log('\n' + '='.repeat(60));
    console.log('CLAUDE FEEDBACK');
    console.log('='.repeat(60) + '\n');
    console.log(claudeResponse);
  }

  if (gptResponse) {
    console.log('\n' + '='.repeat(60));
    console.log('GPT-4 FEEDBACK');
    console.log('='.repeat(60) + '\n');
    console.log(gptResponse);
  }

  if (!claudeResponse && !gptResponse) {
    console.log('\n⚠️  No API keys found. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY\n');
    console.log('Example:');
    console.log('  ANTHROPIC_API_KEY=sk-ant-xxx OPENAI_API_KEY=sk-xxx node scripts/get-ai-feedback.js\n');
  }
}

main().catch(console.error);
