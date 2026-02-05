#!/usr/bin/env node

/**
 * Diagnoses bug reports from user feedback by investigating the codebase and data.
 *
 * Keyword-matches bug descriptions to relevant file categories, loads code/data
 * within a token budget, and calls Claude Sonnet for a structured diagnosis.
 *
 * Usage:
 *   Imported by process-feedback.js:
 *     import { diagnoseBug } from './diagnose-feedback-bug.js';
 *     const result = await diagnoseBug(message, showName, category);
 *
 *   CLI:
 *     node scripts/diagnose-feedback-bug.js --message "score seems wrong" --show "Hamilton"
 *
 * Env vars:
 *   ANTHROPIC_API_KEY - Claude API key
 */

import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// Token budget: ~30K tokens ≈ ~120K chars
const MAX_CONTEXT_CHARS = 120_000;

// Bug category → keywords + files to load
const BUG_CATEGORIES = {
  scoring: {
    keywords: ['score', 'rating', 'grade', 'wrong score', 'too high', 'too low', 'composite', 'letter grade', 'grading'],
    files: ['src/lib/engine.ts', 'src/config/scoring.ts'],
  },
  showData: {
    keywords: ['wrong info', 'incorrect', 'dates', 'venue', 'opening', 'closing', 'cast', 'creative team', 'synopsis', 'runtime'],
    files: [], // Uses show-specific data instead
  },
  display: {
    keywords: ['layout', 'broken', 'page', 'mobile', "doesn't show", 'not showing', 'blank', 'missing on page', 'css', 'style', 'font', 'color'],
    files: ['src/app/page.tsx', 'src/app/show/[slug]/page.tsx'],
  },
  images: {
    keywords: ['image', 'photo', 'picture', 'thumbnail', 'poster', 'wrong image', 'no image', 'broken image'],
    files: ['src/components/ShowImage.tsx'],
  },
  boxOffice: {
    keywords: ['gross', 'box office', 'revenue', 'attendance', 'capacity', 'weekly gross'],
    files: ['src/components/BoxOfficeStats.tsx', 'src/lib/data-grosses.ts'],
  },
  audience: {
    keywords: ['audience', 'buzz', 'show score', 'reddit', 'mezzanine', 'audience score', 'user rating'],
    files: ['src/lib/data-audience.ts', 'src/components/AudienceBuzzCard.tsx'],
  },
  reviews: {
    keywords: ['review', 'critic', 'missing review', 'wrong review', 'outlet', 'reviewer'],
    files: ['src/components/ReviewsList.tsx'],
  },
  lottery: {
    keywords: ['lottery', 'rush', 'standing room', 'sro', 'cheap tickets', 'digital lottery', 'rush tickets'],
    files: ['src/components/LotteryRushCard.tsx', 'src/lib/data-lottery.ts'],
  },
  biz: {
    keywords: ['recoup', 'investment', 'commercial', 'biz', 'capitalization', 'running cost', 'profit'],
    files: ['src/lib/data-commercial.ts', 'src/config/commercial.ts'],
  },
};

// Default files for unclassifiable bugs
const DEFAULT_FILES = ['src/lib/engine.ts', 'src/config/scoring.ts', 'src/app/page.tsx'];

/**
 * Match bug description to file categories via keyword matching
 */
function classifyBugCategories(message) {
  const lower = message.toLowerCase();
  const matched = [];

  for (const [category, { keywords }] of Object.entries(BUG_CATEGORIES)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(category);
        break;
      }
    }
  }

  return matched.length > 0 ? matched : ['scoring', 'display']; // Default guess
}

/**
 * Load a file's contents, respecting the character budget
 */
function loadFile(relPath, budgetRemaining) {
  const fullPath = path.join(ROOT, relPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.length > budgetRemaining) {
      // Truncate large files, keeping the first portion
      return {
        content: content.slice(0, budgetRemaining) + '\n... [truncated]',
        chars: budgetRemaining,
      };
    }
    return { content, chars: content.length };
  } catch {
    return { content: null, chars: 0 };
  }
}

/**
 * Load show-specific data for content error investigation
 */
function loadShowData(showName) {
  // Load shows
  let shows;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
    shows = raw.shows || raw;
  } catch {
    return null;
  }

  // Simple show matching (case-insensitive title or slug)
  const lower = showName.toLowerCase().trim();
  const show = shows.find(s =>
    s.title.toLowerCase() === lower ||
    s.slug === lower ||
    s.slug === lower.replace(/\s+/g, '-') ||
    s.title.toLowerCase().includes(lower) ||
    lower.includes(s.title.toLowerCase())
  );

  if (!show) return null;

  const result = {
    show: {
      id: show.id,
      title: show.title,
      slug: show.slug,
      status: show.status,
      venue: show.venue,
      openingDate: show.openingDate,
      closingDate: show.closingDate,
    },
    reviews: [],
    audienceBuzz: null,
    commercial: null,
  };

  // Load reviews for this show (scores only, not full text)
  try {
    const reviewsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
    const allReviews = reviewsRaw.reviews || reviewsRaw;
    const showReviews = allReviews.filter(r => r.showId === show.id);
    result.reviews = showReviews.map(r => ({
      outlet: r.outlet,
      critic: r.criticName,
      score: r.assignedScore,
      tier: r.tier,
      scoreSource: r.scoreSource,
    }));
  } catch { /* skip */ }

  // Load audience buzz
  try {
    const buzz = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audience-buzz.json'), 'utf8'));
    const showBuzz = (buzz.shows || {})[show.id];
    if (showBuzz) result.audienceBuzz = showBuzz;
  } catch { /* skip */ }

  // Load commercial data
  try {
    const commercial = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/commercial.json'), 'utf8'));
    const showCommercial = (commercial.shows || {})[show.id];
    if (showCommercial) result.commercial = showCommercial;
  } catch { /* skip */ }

  return result;
}

/**
 * Build context from relevant files within token budget
 */
function buildCodeContext(categories) {
  const filesToLoad = new Set();

  for (const cat of categories) {
    const catDef = BUG_CATEGORIES[cat];
    if (catDef) {
      for (const f of catDef.files) filesToLoad.add(f);
    }
  }

  // Fallback if no files matched
  if (filesToLoad.size === 0) {
    for (const f of DEFAULT_FILES) filesToLoad.add(f);
  }

  let totalChars = 0;
  const sections = [];

  for (const relPath of filesToLoad) {
    const remaining = MAX_CONTEXT_CHARS - totalChars;
    if (remaining <= 1000) break; // Stop if nearly out of budget

    const { content, chars } = loadFile(relPath, remaining);
    if (content) {
      sections.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
      totalChars += chars + relPath.length + 20;
    }
  }

  return sections.join('\n\n');
}

/**
 * Call Claude Sonnet for diagnosis
 */
async function callClaude(prompt) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse Claude diagnosis as JSON');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Main diagnosis function
 */
export async function diagnoseBug(message, showName, userCategory) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // 1. Classify bug category
  const categories = classifyBugCategories(message);
  const isContentError = userCategory === 'content-error' || categories.includes('showData');

  // 2. Load code context
  const codeContext = buildCodeContext(categories);

  // 3. Load show data if mentioned
  let showData = null;
  let showDataStr = '';
  if (showName && showName !== 'N/A') {
    showData = loadShowData(showName);
    if (showData) {
      showDataStr = `## Show Data for "${showData.show.title}"\n\`\`\`json\n${JSON.stringify(showData, null, 2)}\n\`\`\``;
    }
  }

  // 4. Build diagnosis prompt
  const prompt = `You are diagnosing a user-reported bug on Broadway Scorecard (broadwayscorecard.com), a Broadway review aggregator.

## User's Bug Report
**Category:** ${userCategory || 'Not specified'}
**Show mentioned:** ${showName || 'None'}
**Message:** ${message}

${isContentError && showDataStr ? showDataStr : ''}

${codeContext ? `## Relevant Source Code\n${codeContext}` : ''}

## Instructions
1. Identify the most likely cause of the reported issue
2. Write your findings in PLAIN ENGLISH — the reader is non-technical and reading on their phone
3. Be specific: cite actual data values, file names, or behavior, not vague possibilities
4. If the user seems to be confused about how the site works (not actually a bug), say so kindly
5. Propose a concrete fix in 1-2 sentences, or say "no fix needed" if it's working as designed
6. Rate your confidence: high (obvious cause found), medium (likely but uncertain), low (speculative)

Respond with ONLY a JSON object in this exact format:
{
  "summary": "One-line plain English summary of the diagnosis",
  "whatsHappening": "2-3 sentence plain English explanation of the likely cause",
  "findings": ["Specific finding 1", "Specific finding 2"],
  "proposedFix": "What should be changed (or 'No fix needed — working as designed')",
  "fixType": "data|code|config|not-a-bug",
  "confidence": "high|medium|low",
  "relevantFiles": ["file1.ts", "file2.json"]
}`;

  // 5. Call Claude
  return await callClaude(prompt);
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let message = '';
  let show = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--message' && args[i + 1]) message = args[++i];
    if (args[i] === '--show' && args[i + 1]) show = args[++i];
  }

  if (!message) {
    console.error('Usage: node scripts/diagnose-feedback-bug.js --message "..." [--show "..."]');
    process.exit(1);
  }

  diagnoseBug(message, show || null, 'bug')
    .then(result => {
      console.log('\n=== DIAGNOSIS ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Diagnosis failed:', err.message);
      process.exit(1);
    });
}
