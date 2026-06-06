#!/usr/bin/env node
/**
 * Extract publishDate from review text using Claude Haiku.
 *
 * Two modes:
 *   1. Extract dates from reviews with no publishDate (multi-date texts
 *      where regex can't determine which is the publish date)
 *   2. Cross-check existing text-regex dates (--verify flag)
 *
 * Usage:
 *   node scripts/backfill-llm-dates.js --limit 10              # dry run, 10 samples
 *   node scripts/backfill-llm-dates.js --limit 10 --apply      # write dates
 *   node scripts/backfill-llm-dates.js --verify --limit 20     # cross-check regex dates
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { CLAUDE_HAIKU } = require('./lib/models');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = !process.argv.includes('--apply');
const VERIFY_MODE = process.argv.includes('--verify');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]
  || (process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : '10'), 10);
const HEADER_CHARS = 600;

const client = new Anthropic();

async function extractDateWithLLM(headerText, outlet, showTitle) {
  const response = await client.messages.create({
    model: CLAUDE_HAIKU,
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Below is the beginning of a theater review from "${outlet}" about the show "${showTitle}". What is the publish date of this review? Reply with ONLY the date in YYYY-MM-DD format, or "NONE" if you cannot determine the publish date.

Do NOT return dates of performances, show runs, closing dates, or dates mentioned in the review content — only the date the review was published.

---
${headerText}
---`
    }],
  });

  const text = response.content[0].text.trim();
  // Validate response is a date
  const match = text.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;

  const [y, m, d] = match[1].split('-').map(Number);
  if (y < 1970 || y > 2027 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;

  return match[1];
}

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required. Run: source .env');
    process.exit(1);
  }

  const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const showMap = {};
  Object.values(showsData.shows).forEach(s => { showMap[s.id] = s; });

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  // Collect candidates
  const candidates = [];
  for (const showDir of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, showDir)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(REVIEW_TEXTS_DIR, showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (data.wrongProduction || data.wrongShow) continue;
      if (!data.fullText || data.fullText.length < 100) continue;

      if (VERIFY_MODE) {
        // Cross-check existing text-regex dates
        if (data.dateSource !== 'text-regex') continue;
      } else {
        // Extract new dates
        if (data.publishDate) continue;
      }

      candidates.push({ showDir, file, filePath, data });
    }
  }

  console.log(`Mode: ${VERIFY_MODE ? 'VERIFY text-regex dates' : 'EXTRACT new dates'}`);
  console.log(`Candidates: ${candidates.length}, Limit: ${LIMIT}`);
  console.log();

  const batch = candidates.slice(0, LIMIT);
  let extracted = 0, failed = 0, agreed = 0, disagreed = 0;
  const disagreements = [];

  for (let i = 0; i < batch.length; i++) {
    const { showDir, file, filePath, data } = batch[i];
    const show = showMap[showDir];
    const showTitle = show?.title || showDir;
    const header = data.fullText.substring(0, HEADER_CHARS);

    try {
      const llmDate = await extractDateWithLLM(header, data.outlet, showTitle);
      const prefix = `[${i + 1}/${batch.length}]`;

      if (VERIFY_MODE) {
        if (!llmDate) {
          console.log(`${prefix} ${data.outlet.padEnd(25)} ${showDir}: LLM=NONE, regex=${data.publishDate} ← CAN'T VERIFY`);
          failed++;
        } else if (llmDate === data.publishDate) {
          console.log(`${prefix} ${data.outlet.padEnd(25)} ${showDir}: AGREE ${llmDate}`);
          agreed++;
        } else {
          console.log(`${prefix} ${data.outlet.padEnd(25)} ${showDir}: DISAGREE regex=${data.publishDate} llm=${llmDate}`);
          disagreed++;
          disagreements.push({ showDir, file, outlet: data.outlet, regex: data.publishDate, llm: llmDate });
        }
      } else {
        if (!llmDate) {
          console.log(`${prefix} ${data.outlet.padEnd(25)} ${showDir}: NONE`);
          failed++;
        } else {
          console.log(`${prefix} ${data.outlet.padEnd(25)} ${showDir}: ${llmDate}`);
          extracted++;

          if (!DRY_RUN) {
            data.publishDate = llmDate;
            data.dateSource = 'text-llm';
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
          }
        }
      }
    } catch (err) {
      console.log(`[${i + 1}/${batch.length}] ${data.outlet.padEnd(25)} ${showDir}: ERROR ${err.message.substring(0, 60)}`);
      failed++;
    }

    // Rate limit: ~1 req/sec for Haiku
    if (i < batch.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n--- Summary ---`);
  if (VERIFY_MODE) {
    console.log(`Agreed:     ${agreed}`);
    console.log(`Disagreed:  ${disagreed}`);
    console.log(`Can't verify: ${failed}`);
    if (disagreements.length > 0) {
      console.log(`\nDisagreements:`);
      disagreements.forEach(d => console.log(`  ${d.outlet.padEnd(25)} ${d.showDir}: regex=${d.regex} llm=${d.llm}`));
    }
  } else {
    console.log(`${DRY_RUN ? 'Would extract' : 'Extracted'}: ${extracted}`);
    console.log(`No date found:  ${failed}`);
  }
}

run().catch(console.error);
