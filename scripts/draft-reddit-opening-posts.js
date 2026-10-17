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
 *      style guide distilled from the owner's real posts. A lint pass refuses wrong
 *      scores and AI tells; on failure it falls back to a plain template.
 *   3. Saves drafts to data/audit/reddit-post-drafts.json. The next step,
 *      send-reddit-post-email.js, emails each new draft on its own with a
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

// ── LLM ─────────────────────────────────────────────────────────────────────

function parseJsonBlock(text, stopReason) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) {
    // Say what came back, so a CI log shows why (truncation, refusal, prose).
    const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`no JSON in model output (stop: ${stopReason || '?'}, ${String(text || '').length} chars: "${snippet}")`);
  }
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
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      return { model, text, stopReason: msg.stop_reason };
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

async function writeDraft(facts, examples = []) {
  if (NO_LLM || (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY)) {
    return { draft: lib.templateDraft(facts), source: 'template', problems: [] };
  }
  const call = callLLM;
  let problems = [];
  let user = lib.buildUserPrompt(facts, examples);
  // Three tries: each retry is told what the last one got wrong.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Last try goes to the other provider when available, so one model's bad
    // day still yields a voiced draft instead of the template.
    const useOpenAI = attempt === 3 && process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY;
    try {
      const { model, text, stopReason } = await (useOpenAI ? callOpenAI : call)(lib.STYLE_GUIDE, user);
      const res = lib.lintDraft(parseJsonBlock(text, stopReason), facts);
      if (res.ok) return { draft: res.draft, source: model, problems: [] };
      problems = res.problems;
      user = `${lib.buildUserPrompt(facts, examples)}\n\nYour previous draft had these problems, fix them: ${problems.join('; ')}`;
    } catch (e) {
      problems = [`llm error: ${e.message}`];
      user = `${lib.buildUserPrompt(facts, examples)}\n\nYour previous reply could not be parsed. Reply with the JSON object only.`;
    }
    console.log(`  attempt ${attempt}${useOpenAI ? ' (OpenAI)' : ''}: ${problems.join('; ').slice(0, 300)}`);
  }
  return { draft: lib.templateDraft(facts), source: 'template', problems };
}

// ── Posted detection ────────────────────────────────────────────────────────

async function fetchRecentOwnerPosts() {
  const after = Math.floor(Date.now() / 1000) - 365 * 86400; // a year: posted detection + voice examples
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

const USAGE = `draft-reddit-opening-posts.js: draft Reddit "reviews are in" posts for WE/OWE/OB openings (BRO-4333).
  --dry-run        print drafts, save nothing
  --show=ID        force one show (any age)
  --no-llm         template drafts only
  --today=YYYY-MM-DD`;

async function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const shows = loadShows();
  const slims = loadSlims(shows);
  const peers = lib.buildPeers(shows, slims);
  const seenLookup = lib.makeSeenLookup(loadJSON(SEEN_PATH, { shows: [] }), { sinceYear: Number(TODAY.slice(0, 4)) - 1 });
  let drafts = loadJSON(DRAFTS_PATH, null) || { _meta: {}, drafts: {} };

  const posts = await fetchRecentOwnerPosts();
  if (posts) {
    const before = Object.values(drafts.drafts).filter(d => d.status === 'posted').length;
    drafts = lib.applyPostedDetection(drafts, posts);
    const after = Object.values(drafts.drafts).filter(d => d.status === 'posted').length;
    if (after > before) console.log(`  marked ${after - before} draft(s) posted`);
  }

  // Freshest voice: the owner's top roundup posts from the last 4 months, widening to
  // a year if they've been quiet. Falls back to the static style guide examples.
  let examples = lib.pickRecentExamples(posts || [], { maxAgeDays: 120 });
  if (examples.length < 2) examples = lib.pickRecentExamples(posts || [], { maxAgeDays: 365 });
  console.log(`  voice examples: ${examples.map(e => `${e.date} (${e.upvotes})`).join(', ') || 'none, using built-in'}`);

  const candidates = lib.selectCandidates({
    shows, slims, drafts, peersByMarket: peers, today: TODAY, seenLookup, forceShowId: FORCE_SHOW,
  });
  console.log(`${TODAY}: ${candidates.length} opening(s) to draft${FORCE_SHOW ? ` (forced ${FORCE_SHOW})` : ''}`);

  // --show is an owner request (a resend dispatch emails these right after):
  // a show that could not be redrafted fails the step, so the email step
  // never sends its old text as if it were fresh.
  const forcedFailures = [];
  if (FORCE_SHOW) {
    const got = new Set(candidates.map(c => c.show.id));
    for (const id of FORCE_SHOW.split(',').map(x => x.trim()).filter(Boolean)) {
      if (!got.has(id)) forcedFailures.push(`${id}: not draftable (unknown id, unsupported market, or no score yet)`);
    }
  }

  for (const c of candidates) {
    const prevDraft = drafts.drafts[c.show.id];
    // --show on a posted draft would pay for text nobody will use, and the
    // stored text would no longer match what went up.
    if (prevDraft && prevDraft.status === 'posted') { console.log(`  ${c.show.id}: already posted, not redrafting`); continue; }
    const { draft, source, problems } = await writeDraft(c.facts, examples);
    // Scheduled refreshes keep their old behavior (a template with fresh
    // numbers beats a reminder with stale ones, BRO-4597).
    if (FORCE_SHOW && lib.keepPreviousDraft(prevDraft, source)) {
      forcedFailures.push(`${c.show.id}: LLM failed (${problems.join('; ').slice(0, 200) || 'no LLM run'}); kept the earlier ${prevDraft.source} draft`);
      continue;
    }
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
      crosspostSubreddit: c.facts.crosspostSubreddit || null,
      crosspostSubmitUrl: c.facts.crosspostSubreddit ? lib.submitUrl(c.facts.crosspostSubreddit, draft.title, draft.body) : null,
    };
    // A redraft (retry after an LLM outage, or --show) keeps the email
    // stamps and posted state, so it never re-sends a "new post" email or
    // revives a draft the owner already posted (ship-check 2026-09-29).
    const prev = drafts.drafts[c.show.id];
    if (prev) {
      for (const k of ['createdAt', 'emailedAt', 'reminderAt', 'status', 'postedAt', 'postedUrl', 'postedSubreddit', 'postedScore']) {
        if (prev[k] !== undefined) entry[k] = prev[k];
      }
      // Already emailed: the reminder says the numbers moved since.
      if (prev.emailedAt) {
        entry.refreshedAt = new Date().toISOString();
        // Keep the numbers from the email the owner actually got, across
        // repeated refreshes.
        entry.previousReviewCount = prev.previousReviewCount ?? prev.reviewCount;
        entry.previousScore = prev.previousScore ?? prev.score;
      }
    }
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
    reportForcedFailures(forcedFailures);
    return;
  }
  fs.mkdirSync(path.dirname(DRAFTS_PATH), { recursive: true });
  fs.writeFileSync(DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n');
  console.log(`\nSaved ${Object.keys(drafts.drafts).length} draft(s) to ${path.relative(ROOT, DRAFTS_PATH)}`);
  reportForcedFailures(forcedFailures);
}

function reportForcedFailures(failures) {
  for (const f of failures) console.log(`::error::${f}`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
