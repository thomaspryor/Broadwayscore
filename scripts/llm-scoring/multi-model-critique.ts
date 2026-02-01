#!/usr/bin/env npx ts-node --project /Users/tompryor/Broadwayscore/scripts/tsconfig.json
/**
 * Multi-Model Critique of LLM Scoring Proposals
 *
 * Sends proposals to Claude, GPT-4o, and Gemini for independent critique
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';

const PROPOSALS = fs.readFileSync('/Users/tompryor/Broadwayscore/data/audit/llm-scoring-proposals.md', 'utf8');

const CRITIQUE_PROMPT = `You are an expert in machine learning evaluation and ensemble methods.

Below is a proposal for scoring Broadway theater reviews using a 3-model LLM ensemble (Claude, GPT-4o, Gemini).

Please critique this methodology:

1. **Strengths**: What's working well in this approach?
2. **Weaknesses**: What are the blind spots or potential problems?
3. **Alternative Approaches**: What other methods should be considered?
4. **Specific Recommendations**: 3-5 concrete changes to improve accuracy
5. **Risk Assessment**: What could go wrong in production?

Be direct and critical. Don't just validate - challenge assumptions and propose better alternatives.

---

PROPOSALS TO CRITIQUE:

${PROPOSALS}

---

Provide your critique:`;

async function getCritique(model: string, client: any): Promise<string> {
  console.log(`\nGetting critique from ${model}...`);

  try {
    if (model === 'Claude') {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: CRITIQUE_PROMPT }]
      });
      return response.content[0].type === 'text' ? response.content[0].text : '';
    }
    else if (model === 'GPT-4o') {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [{ role: 'user', content: CRITIQUE_PROMPT }]
      });
      return response.choices[0].message.content || '';
    }
    else if (model === 'Gemini') {
      const genModel = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await genModel.generateContent(CRITIQUE_PROMPT);
      return result.response.text();
    }
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
  return '';
}

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!claudeKey || !openaiKey || !geminiKey) {
    console.error('Need all three API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: claudeKey });
  const openai = new OpenAI({ apiKey: openaiKey });
  const gemini = new GoogleGenerativeAI(geminiKey);

  console.log('=' .repeat(70));
  console.log('MULTI-MODEL CRITIQUE OF LLM SCORING PROPOSALS');
  console.log('=' .repeat(70));

  // Get critiques in parallel
  const [claudeCritique, openaiCritique, geminiCritique] = await Promise.all([
    getCritique('Claude', claude),
    getCritique('GPT-4o', openai),
    getCritique('Gemini', gemini)
  ]);

  // Output results
  console.log('\n' + '=' .repeat(70));
  console.log('CLAUDE CRITIQUE');
  console.log('=' .repeat(70));
  console.log(claudeCritique);

  console.log('\n' + '=' .repeat(70));
  console.log('GPT-4o CRITIQUE');
  console.log('=' .repeat(70));
  console.log(openaiCritique);

  console.log('\n' + '=' .repeat(70));
  console.log('GEMINI CRITIQUE');
  console.log('=' .repeat(70));
  console.log(geminiCritique);

  // Save to file
  const output = {
    timestamp: new Date().toISOString(),
    critiques: {
      claude: claudeCritique,
      openai: openaiCritique,
      gemini: geminiCritique
    }
  };

  fs.writeFileSync(
    '/Users/tompryor/Broadwayscore/data/audit/multi-model-critique.json',
    JSON.stringify(output, null, 2)
  );

  console.log('\n' + '=' .repeat(70));
  console.log('Critiques saved to: data/audit/multi-model-critique.json');
}

main().catch(console.error);
