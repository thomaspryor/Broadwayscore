#!/usr/bin/env node
/**
 * draft-reddit-opening-posts.js (BRO-4333)
 *
 * The owner's "reviews are in" Reddit posts drive a lot of traffic, but West
 * End and Off-Broadway openings kept slipping by. This drafts the post for
 * them every morning so posting is one tap:
 *
 *   1. Picks West End / Off-West End / Off-Broadway shows that opened 1-5
 *      days ago and have enough reviews (scripts/lib/reddit-opening-post.js).
 *   2. Builds a fact sheet from public/data/shows/{id}.json (the live site's
 *      numbers) and has Claude write the post in the owner's voice, using a
 *      style guide distilled from his real posts. A lint pass refuses wrong
 *      scores and AI tells; on failure it falls back to a plain template.
 *   3. Saves drafts to data/audit/reddit-post-drafts.json. The daily opening
 *      digest (send-opening-digest.js) shows them at the top with a
 *      "post it" link that opens Reddit with title + body filled in.
 *   4. Checks the owner's recent Reddit posts (Arctic Shift archive, no Reddit
 *      credentials needed) and marks drafts posted so the email stops asking.
 *
 * Usage:
 *   node scripts/draft-reddit-opening-posts.js              # draft + save
 *   node scripts/draft-reddit-opening-posts.js --dry-run    # print, save nothing
 *   node scripts/draft-reddit-opening-posts.js --show=ID    # force one show (any age)
 *   node scripts/draft-reddit-opening-posts.js --no-llm     # template drafts only
 *   node scripts/draft-reddit-opening-posts.js --today=YYYY-MM-DD
 *
 * Env: ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY. With neither, the
 * template draft is used, so the email still gets something postable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib/reddit-opening-post');

const ROOT = path.resolve(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const SLIM_DIR = path.join(ROOT, 'public', 'data', 'shows');
const SEEN_PATH = path.join(ROOT, 'data', 'shows-seen.json');
const DRAFTS_PATH = path.join(ROOT, 'data', 'audit', 'reddit-post-drafts.json');
const REDDIT_USER = 'thomaspryor';

const args = process.argv.slice(2);
const getArg = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const DRY_RUN = args.includes('--dry-run');
const NO_LLM = args.includes('--no-llm');
const FORCE_SHOW = getArg('show');
const TODAY = getArg('today') || new Date().toISOString().slice(0, 10);

const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-5-20250929'];

function loadJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadShows() {
  const d = loadJSON(SHOWS_PATH);
  if (!d) throw new Error(`missing ${SHOWS_PATH} (run scripts/setup-local-data.sh)`);
  return Array.isArray(d) ? d : d.shows;
}

function loadSlims(shows) {
  const slims = new Map();
  for (const s of shows) {
    if (!lib.SUBREDDIT_BY_MARKET[lib.marketOf(s)]) continue;
    const j = loadJSON(path.join(SLIM_DIR, `${s.id}.json`));
    if (j) slims.set(s.id, j);
  }
  return slims;
}

function peersByMarket(shows, slims) {
  const out = {};
  for (const s of shows) {
    const m = lib.marketOf(s);
    if (!lib.SUBREDDIT_BY_MARKET[m]) continue;
    if (s.status !== 'open' && s.status !== 'previews') continue;
    const slim = slims.get(s.id);
    if (!slim || typeof slim.cs !== 'number') continue;
    if ((slim.rc || 0) < lib.MIN_REVIEWS[m] / 2) continue;
    (out[m] = out[m] || []).push({ id: s.id, cs: slim.cs });
  }
  return out;
}

// ── LLM ─────────────────────────────────────────────────────────────────────

function parseJsonBlock(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  return JSON.parse(m[0]);
}

async function callAnthropic(system, user) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  let lastErr;
  for (const model of ANTHROPIC_MODELS) {
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return { model, text: msg.content.map(c => c.text || '').join('') };
    } catch (e) {
      lastErr = e;
      // Only an unknown model id moves on to the next model.
      if (e && (e.status === 404 || (e.error && e.error.error && e.error.error.type === 'not_found_error'))) continue;
      throw e;
    }
  }
  throw lastErr;
}

// Anthropic first, OpenAI if Anthropic errors (or has no key).
async function callLLM(system, user) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropic(system, user);
    } catch (e) {
      if (!process.env.OPENAI_API_KEY) throw e;
      console.warn(`  Anthropic failed (${e.message}); trying OpenAI`);
    }
  }
  return callOpenAI(system, user);
}

async function callOpenAI(system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { model: 'gpt-4o', text: j.choices[0].message.content };
}

async function writeDraft(facts) {
  if (NO_LLM || (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY)) {
    return { draft: lib.templateDraft(facts), source: 'template', problems: [] };
  }
  const call = callLLM;
  let problems = [];
  let user = lib.buildUserPrompt(facts);
  // Two tries: the second one is told what the first got wrong.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { model, text } = await call(lib.STYLE_GUIDE, user);
      const res = lib.lintDraft(parseJsonBlock(text), facts);
      if (res.ok) return { draft: res.draft, source: model, problems: [] };
      problems = res.problems;
      user = `${lib.buildUserPrompt(facts)}\n\nYour previous draft had these problems, fix them: ${problems.join('; ')}`;
    } catch (e) {
      problems = [`llm error: ${e.message}`];
    }
  }
  return { draft: lib.templateDraft(facts), source: 'template', problems };
}

// ── Posted detection ────────────────────────────────────────────────────────

async function fetchRecentOwnerPosts() {
  const after = Math.floor(Date.now() / 1000) - 21 * 86400;
  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?author=${REDDIT_USER}&after=${after}&limit=100&sort=desc`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'broadwayscorecard-draft-bot/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return Array.isArray(j.data) ? j.data : [];
  } catch (e) {
    console.warn(`  posted-detection skipped (${e.message}); drafts stay as they are`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const shows = loadShows();
  const slims = loadSlims(shows);
  const peers = peersByMarket(shows, slims);
  const seenLookup = lib.makeSeenLookup(loadJSON(SEEN_PATH, { shows: [] }), { sinceYear: Number(TODAY.slice(0, 4)) - 1 });
  let drafts = loadJSON(DRAFTS_PATH, null) || { _meta: {}, drafts: {} };

  const posts = await fetchRecentOwnerPosts();
  if (posts) {
    const before = Object.values(drafts.drafts).filter(d => d.status === 'posted').length;
    drafts = lib.applyPostedDetection(drafts, posts);
    const after = Object.values(drafts.drafts).filter(d => d.status === 'posted').length;
    if (after > before) console.log(`  marked ${after - before} draft(s) posted`);
  }

  const candidates = lib.selectCandidates({
    shows, slims, drafts, peersByMarket: peers, today: TODAY, seenLookup, forceShowId: FORCE_SHOW,
  });
  console.log(`${TODAY}: ${candidates.length} opening(s) to draft${FORCE_SHOW ? ` (forced ${FORCE_SHOW})` : ''}`);

  for (const c of candidates) {
    const { draft, source, problems } = await writeDraft(c.facts);
    const entry = {
      showId: c.show.id,
      showTitle: c.show.title,
      market: c.facts.market,
      subreddit: c.facts.subreddit,
      score: c.facts.score,
      reviewCount: c.facts.reviewCount,
      url: c.facts.url,
      notability: Math.round(c.notability),
      createdAt: new Date().toISOString(),
      status: 'ready',
      source,
      lintProblems: problems,
      ...draft,
      submitUrl: lib.submitUrl(c.facts.subreddit, draft.title, draft.body),
      oldRedditSubmitUrl: lib.oldRedditSubmitUrl(c.facts.subreddit, draft.title, draft.body),
    };
    drafts.drafts[c.show.id] = entry;
    console.log(`\n── r/${entry.subreddit} · ${entry.showTitle} (${source}${problems.length ? `, fell back: ${problems.join('; ')}` : ''})`);
    console.log(`TITLE: ${entry.title}\n\n${entry.body}\n`);
    console.log(`WHY: ${entry.why}`);
    console.log(`PUSHBACK: ${entry.expectedPushback}\nREPLY: ${entry.suggestedReply}`);
    if (entry.personalLines.length) console.log(`PERSONAL: ${entry.personalLines.join(' | ')}`);
  }

  drafts._meta = {
    description: 'Reddit "reviews are in" post drafts for WE/OWE/OB openings (BRO-4333). Written by scripts/draft-reddit-opening-posts.js, shown in the opening digest email.',
    lastRun: new Date().toISOString(),
  };
  // Keep the file small: drop entries older than 60 days.
  const cutoff = Date.now() - 60 * 86400000;
  for (const [id, d] of Object.entries(drafts.drafts)) {
    if (Date.parse(d.createdAt) < cutoff) delete drafts.drafts[id];
  }

  if (DRY_RUN) {
    console.log('\n(dry run: nothing saved)');
    return;
  }
  fs.mkdirSync(path.dirname(DRAFTS_PATH), { recursive: true });
  fs.writeFileSync(DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n');
  console.log(`\nSaved ${Object.keys(drafts.drafts).length} draft(s) to ${path.relative(ROOT, DRAFTS_PATH)}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
