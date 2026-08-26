#!/usr/bin/env node
/**
 * reddit-engagement-digest.js
 *
 * Scans r/Broadway once daily for threads worth engaging with.
 * Uses Claude to evaluate threads and draft replies in thomaspryor's voice.
 *
 * Card #511 (owner merge decision — one scheduled morning email, not
 * several): this no longer emails on its own. It writes a structured
 * snapshot to data/audit/reddit-digest-snapshot.json instead;
 * autonomous-email.js reads it and folds it into the single scheduled
 * morning email, same pattern as card #364's health-check.js digest. Went
 * from twice-daily (01:00/13:00 UTC) to once-daily, retimed to run before
 * the loop's 07:30 UTC start — a second same-day run would just overwrite
 * this one's snapshot before the morning email ever read it, silently
 * dropping its threads. LOOKBACK_HOURS raised 14 → 26 to cover the full gap
 * between runs now that there's only one per day.
 *
 * Usage: node scripts/reddit-engagement-digest.js [--dry-run] [--verbose]
 * Env: ANTHROPIC_API_KEY
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { fetchWithFallback, flattenComments } = require('./lib/reddit-api');
const { VOICE_CHARACTERISTICS } = require('./lib/voice-characteristics');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

// ── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
// Usage: node scripts/reddit-engagement-digest.js [--dry-run] [--verbose] [--time-budget-min=N]
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'reddit-digest-history.json');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const DIGEST_SNAPSHOT_FILE = path.join(AUDIT_DIR, 'reddit-digest-snapshot.json');
const DIGEST_ITEM_CAP = 8;

const SUBREDDIT = 'Broadway';
const LOOKBACK_HOURS = 26;
const MAX_LISTING = 50;
const MAX_COMMENTS_PER_THREAD = 30;
const MY_USERNAMES = ['thomaspryor', 'thepinkmusical'];

// Promo phase thresholds (digest count)
const PHASE_NO_MENTION = 28;   // Digests 1-28: zero site mentions
const PHASE_DATA_ONLY = 56;    // Digests 29-56: mention data, no links
// 57+: occasional links allowed

// ── Voice Profile ───────────────────────────────────────────────────────────
// VOICE_CHARACTERISTICS now lives in scripts/lib/voice-characteristics.js
// (shared with brand-mention-monitor and other voice-aware tools).

// ── Utility Functions ───────────────────────────────────────────────────────

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadHistory() {
  const data = loadJSON(HISTORY_PATH);
  return data || {
    digestCount: 0,
    suggestedThreadIds: [],
    promoDigests: [],       // digest numbers that included promo links
    lastDigestAt: null,
  };
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function formatAge(createdUtc) {
  const hours = Math.round((Date.now() / 1000 - createdUtc) / 3600);
  if (hours < 1) return '<1h ago';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function getPromoPhase(digestCount) {
  if (digestCount < PHASE_NO_MENTION) return 'no-mention';
  if (digestCount < PHASE_DATA_ONLY) return 'data-only';
  return 'links-ok';
}

function log(msg) {
  if (VERBOSE) console.log(msg);
}

/**
 * Call Claude Messages API directly (no SDK dependency)
 */
function callClaude(systemPrompt, userMessage, maxTokens = 4000, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content[0].text);
          } catch (e) {
            reject(new Error(`Claude response parse error: ${data.slice(0, 300)}`));
          }
        } else {
          reject(new Error(`Claude API ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Claude API timed out after ${timeoutMs / 1000}s`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Reddit Data ─────────────────────────────────────────────────────────────

async function getSubredditListing(sort) {
  const url = `https://www.reddit.com/r/${SUBREDDIT}/${sort}.json?limit=${MAX_LISTING}&raw_json=1`;
  return fetchWithFallback(url);
}

/**
 * Fetch hot/new/rising, deduplicate, filter to recent posts
 */
async function fetchRecentThreads(history) {
  console.log('Fetching r/Broadway listings...');
  const cutoff = Date.now() / 1000 - LOOKBACK_HOURS * 3600;
  const seen = new Set(history.suggestedThreadIds.slice(-500)); // Last 500 to avoid repeats
  const allPosts = new Map();

  for (const sort of ['hot', 'new', 'rising']) {
    try {
      const listing = await getSubredditListing(sort);
      const posts = listing?.data?.children || [];
      log(`  ${sort}: ${posts.length} posts`);

      for (const { data: post } of posts) {
        if (allPosts.has(post.id)) continue;
        allPosts.set(post.id, post);
      }
    } catch (e) {
      console.warn(`  Failed to fetch ${sort}: ${e.message}`);
    }
  }

  console.log(`  Total unique posts: ${allPosts.size}`);

  // Filter
  const filtered = [];
  for (const post of allPosts.values()) {
    // Skip old posts
    if (post.created_utc < cutoff) continue;
    // Skip own posts
    if (MY_USERNAMES.includes(post.author?.toLowerCase())) continue;
    // Skip already-suggested
    if (seen.has(post.id)) continue;
    // Skip posts with no engagement
    if (post.num_comments < 1) continue;
    // Skip extremely low-effort
    if (post.score < 2) continue;

    filtered.push(post);
  }

  console.log(`  After filtering: ${filtered.length} threads`);

  // Sort by engagement (score × comments)
  filtered.sort((a, b) => (b.score * b.num_comments) - (a.score * a.num_comments));

  // Cap at reasonable number for evaluation
  return filtered.slice(0, 30);
}

/**
 * Fetch top comments for each thread, check if user already commented
 */
async function enrichWithComments(threads) {
  console.log(`Fetching comments for ${threads.length} threads...`);
  const enriched = [];

  for (const post of threads) {
    if (timeBudget.exceeded()) {
      console.log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — ${threads.length - enriched.length} thread(s) skipped this run.`);
      break;
    }
    try {
      const url = `https://www.reddit.com/r/${SUBREDDIT}/comments/${post.id}.json?limit=${MAX_COMMENTS_PER_THREAD}&depth=2&raw_json=1`;
      const response = await fetchWithFallback(url);
      const comments = flattenComments(response);

      // Check if user already commented
      const alreadyCommented = comments.some(c =>
        MY_USERNAMES.includes(c.author?.toLowerCase?.())
      );
      if (alreadyCommented) {
        log(`  Skipping "${post.title.slice(0, 50)}" — already commented`);
        continue;
      }

      // Take top comments by score
      const topComments = comments
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10)
        .map(c => ({
          author: c.author || '[deleted]',
          body: (c.body || '').slice(0, 250),
          score: c.score || 0,
        }));

      enriched.push({ ...post, topComments });
    } catch (e) {
      log(`  Failed comments for "${post.title.slice(0, 40)}": ${e.message}`);
    }
  }

  console.log(`  Enriched: ${enriched.length} threads (${threads.length - enriched.length} skipped)`);
  return enriched;
}

// ── Show Context ────────────────────────────────────────────────────────────

function loadShowContext() {
  const showsRaw = loadJSON(path.join(DATA_DIR, 'shows.json'));
  const reviewsRaw = loadJSON(path.join(DATA_DIR, 'reviews.json'));
  if (!showsRaw || !reviewsRaw) return 'No show data available.';

  const shows = showsRaw.shows || showsRaw;
  const showList = Array.isArray(shows) ? shows : Object.values(shows);

  // Compute average scores from reviews
  const scores = {};
  const reviewEntries = reviewsRaw.shows || reviewsRaw;
  if (typeof reviewEntries === 'object') {
    for (const [showId, reviews] of Object.entries(reviewEntries)) {
      if (!Array.isArray(reviews)) continue;
      const scored = reviews.filter(r => r.assignedScore != null && !r.excluded);
      if (scored.length > 0) {
        scores[showId] = {
          avg: Math.round(scored.reduce((s, r) => s + r.assignedScore, 0) / scored.length),
          count: scored.length,
        };
      }
    }
  }

  // Build context for open + recently closed shows
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoff = threeMonthsAgo.toISOString().slice(0, 10);

  const lines = [];
  for (const show of showList) {
    const isOpen = show.status === 'open' || show.status === 'previews';
    const recentlyClosed = show.status === 'closed' && show.closingDate && show.closingDate >= cutoff;

    if (!isOpen && !recentlyClosed) continue;

    const scoreData = scores[show.id];
    const scorePart = scoreData ? `${scoreData.avg}/100 from ${scoreData.count} reviews` : 'no scores yet';
    const statusPart = show.status === 'previews' ? 'In Previews' :
      show.status === 'open' ? 'Open' : `Closed ${show.closingDate}`;

    lines.push(`- ${show.title} (${show.openingYear || ''}): ${scorePart}, ${statusPart}, slug: ${show.slug}`);
  }

  if (lines.length === 0) return 'No current show data available.';

  lines.sort();
  return `Current/recent Broadway shows (${lines.length} shows):\n${lines.join('\n')}`;
}

/**
 * Load Thomas's personal show watch history for Claude context
 */
function loadShowsSeenContext() {
  const data = loadJSON(path.join(DATA_DIR, 'shows-seen.json'));
  if (!data?.shows?.length) return '';

  // Deduplicate (keep highest rating per show title) and sort by year desc
  const bestRating = new Map();
  const viewCounts = new Map();
  for (const s of data.shows) {
    const key = s.title;
    viewCounts.set(key, (viewCounts.get(key) || 0) + 1);
    const existing = bestRating.get(key);
    if (!existing || (s.rating != null && (existing.rating == null || s.rating > existing.rating))) {
      bestRating.set(key, s);
    }
  }

  const unique = Array.from(bestRating.values())
    .filter(s => s.rating != null)
    .sort((a, b) => b.year - a.year || b.rating - a.rating);

  const stars = r => r >= 4.5 ? 'loved' : r >= 3.5 ? 'liked' : r >= 2.5 ? 'mixed' : 'disliked';

  const lines = unique.map(s => {
    const views = viewCounts.get(s.title);
    const repeat = views > 1 ? ` (seen ${views}x)` : '';
    return `- ${s.title} (${s.year}): ${s.rating}/5 [${stars(s.rating)}]${repeat}`;
  });

  // Top 5s and bottom 5s for quick reference
  const sorted = [...unique].sort((a, b) => b.rating - a.rating);
  const favorites = sorted.slice(0, 10).map(s => s.title).join(', ');
  const least = sorted.filter(s => s.rating <= 2.5).map(s => `${s.title} (${s.rating})`).join(', ');

  // Upcoming shows
  const upcoming = (data.upcoming || []).map(s => `- ${s.title} (${s.date})`);
  const upcomingBlock = upcoming.length > 0
    ? `\nUpcoming (has tickets):\n${upcoming.join('\n')}`
    : '';

  return `\nTHOMAS'S SHOW HISTORY (${unique.length} unique shows, ${data.shows.length} total viewings):
Top-rated: ${favorites}
Shows he didn't love: ${least || 'none'}
${upcomingBlock}

Full list (most recent first):
${lines.join('\n')}

IMPORTANT: Use this history to know which shows Thomas has ACTUALLY seen. Only reference personal experience for shows on this list. If the draft says "I saw X" — verify X is on this list. Shows he saw multiple times (marked "seen Nx") are ones he really loves. Upcoming shows = has tickets but hasn't seen yet.`;
}

// ── Claude Evaluation ───────────────────────────────────────────────────────

function buildSystemPrompt(promoPhase, showContext, showsSeenContext, lastDigestHadPromo) {
  let promoInstructions;
  if (promoPhase === 'no-mention') {
    promoInstructions = 'DO NOT mention Broadway Scorecard, the website, scores from it, or any data source. You are just a knowledgeable theater fan engaging in conversation.';
  } else if (promoPhase === 'data-only') {
    promoInstructions = 'You may casually reference critic score data (e.g., "the critics averaged about a 73 from 30+ reviews") but DO NOT mention "Broadway Scorecard" by name or link to the website. Make the data feel like general knowledge.';
  } else {
    const linkCaveat = lastDigestHadPromo
      ? 'The last digest included a promo link, so DO NOT include one this time.'
      : 'You may include ONE natural link to broadwayscorecard.com/show/{slug} if someone asks about scores/ratings. Never the homepage. Mark as promoLink: true.';
    promoInstructions = `Occasional site references allowed. ${linkCaveat}`;
  }

  return `You are selecting r/Broadway threads worth replying to and drafting replies for u/thomaspryor (also posts as u/pinkthemusical).

Thomas runs Broadway Scorecard (broadwayscorecard.com) — a critic review aggregation site for Broadway. He sees ~60 shows/year and is deeply knowledgeable about Broadway history, box office, and critic reception.

${VOICE_CHARACTERISTICS}

SELF-PROMOTION RULES (CRITICAL — follow exactly):
${promoInstructions}

${showContext}
${showsSeenContext}

YOUR TASK:
Evaluate the provided threads. For each, rate reply-worthiness (1-10, where 7+ = worth replying to).

Criteria for high scores:
- Thread asks a question Thomas can answer with unique knowledge (recommendations, critic data, industry insight)
- Active discussion where a smart take would be noticed (5-50 comments, not buried)
- Topic where data or personal experience adds value
- NOT: memes, photos, ticket resale, personal stories, accessibility questions, posts with 100+ comments (he'd be buried)

CRITICAL — ADDING VALUE (most important rule):
Read the existing comments carefully. Your draft reply MUST add something the existing comments DON'T already cover. This means:
- A specific data point nobody mentioned (critic scores, box office numbers, review counts)
- A genuinely different angle or framing that recontextualizes the discussion
- Personal experience or insider knowledge that goes beyond the obvious consensus
- A contrarian but defensible take backed by evidence
- A specific, concrete recommendation when others are being vague

If the top comments already make the obvious points well, DO NOT draft a reply that restates them. Either find a fresh angle or skip the thread entirely (score it below 7). Repeating what others said — even with better phrasing — is worse than not replying. It's better to suggest 1-2 genuinely additive replies than 5 that blend into the noise.

For each qualifying thread (score 7+), draft a complete reply ready to paste.

Respond with ONLY a valid JSON array (no markdown fences, no explanation):
[
  {
    "threadId": "abc123",
    "score": 8,
    "category": "recommendation",
    "draftReply": "The actual reply text ready to paste...",
    "promoLink": false,
    "assumesSaw": null,
    "whyReply": "One sentence on why this is worth engaging with"
  }
]

Categories: "recommendation" | "debate" | "reaction" | "industry" | "meta"
assumesSaw: set to show name string if the draft references personal experience seeing a show. Only reference shows from the SHOW HISTORY list above. null if no personal experience referenced.
Target 3-7 threads. Quality over quantity. Return [] if nothing qualifies.`;
}

function formatThreadsForClaude(threads) {
  return threads.map((t, i) => {
    const age = formatAge(t.created_utc);
    const body = t.selftext ? t.selftext.slice(0, 500) : '(link post)';
    const commentBlock = (t.topComments || [])
      .map(c => `  [↑${c.score}] u/${c.author}: ${c.body.replace(/\n/g, ' ')}`)
      .join('\n');

    return `--- THREAD ${i + 1} ---
ID: ${t.id}
Title: ${t.title}
Author: u/${t.author} | ↑${t.score} | ${t.num_comments} comments | ${age}
Flair: ${t.link_flair_text || 'none'}
Body: ${body}
Top comments:
${commentBlock || '  (no comments yet)'}`;
  }).join('\n\n');
}

async function evaluateThreads(threads, history) {
  if (threads.length === 0) {
    console.log('No threads to evaluate.');
    return [];
  }

  const promoPhase = getPromoPhase(history.digestCount);
  const lastDigestHadPromo = history.promoDigests.includes(history.digestCount - 1);
  const showContext = loadShowContext();
  const showsSeenContext = loadShowsSeenContext();

  console.log(`Evaluating ${threads.length} threads (phase: ${promoPhase}, digest #${history.digestCount + 1})...`);
  if (showsSeenContext) log(`  Shows-seen context: ${showsSeenContext.split('\n').length} lines`);

  const systemPrompt = buildSystemPrompt(promoPhase, showContext, showsSeenContext, lastDigestHadPromo);
  const userMessage = formatThreadsForClaude(threads);

  log(`  System prompt: ${systemPrompt.length} chars`);
  log(`  User message: ${userMessage.length} chars`);

  const response = await callClaude(systemPrompt, userMessage);

  // Parse JSON from response (handle potential markdown fences)
  let parsed;
  try {
    const jsonStr = response.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse Claude response as JSON:');
    console.error(response.slice(0, 500));
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('Claude response is not an array');
    return [];
  }

  // Enrich with thread data
  const threadMap = new Map(threads.map(t => [t.id, t]));
  const suggestions = parsed
    .filter(s => s.threadId && s.draftReply && s.score >= 7)
    .map(s => {
      const thread = threadMap.get(s.threadId);
      return {
        ...s,
        threadTitle: thread?.title || s.threadId,
        threadUrl: thread ? `https://www.reddit.com${thread.permalink}` : null,
        threadScore: thread?.score || 0,
        threadComments: thread?.num_comments || 0,
        threadAge: thread ? formatAge(thread.created_utc) : '',
      };
    })
    .filter(s => s.threadUrl);

  console.log(`  Claude selected ${suggestions.length} threads`);
  return suggestions;
}

// ── Digest snapshot (card #511) ─────────────────────────────────────────────
// Same subject/bannerText + item-list shape as health-check.js's snapshot
// (card #364), so autonomous-email.js can fold it through the shared render
// block (renderNamedDigestBlock).

function getPhaseLabel(phase) {
  return phase === 'no-mention'
    ? 'Phase 1: Building reputation (no site mentions)'
    : phase === 'data-only'
      ? 'Phase 2: Sharing data casually (no links yet)'
      : 'Phase 3: Full engagement (occasional links OK)';
}

function buildDigestItems(suggestions) {
  return suggestions.map(s => {
    const flags = [];
    if (s.promoLink) flags.push('includes broadwayscorecard.com link');
    if (s.assumesSaw) flags.push(`assumes you saw ${s.assumesSaw} — edit if not`);
    const meta = `${s.threadScore} upvotes · ${s.threadComments} comments · ${s.threadAge}`;
    const flagsText = flags.length ? ` (${flags.join('; ')})` : '';
    return {
      title: s.threadTitle,
      detail: `${meta}${flagsText} — ${s.draftReply}`,
      url: s.threadUrl,
    };
  });
}

function writeDigestSnapshot({ subject, bannerText, items }) {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    subject,
    bannerText,
    items: items.slice(0, DIGEST_ITEM_CAP),
    moreCount: Math.max(0, items.length - DIGEST_ITEM_CAP),
  };
  fs.mkdirSync(path.dirname(DIGEST_SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(DIGEST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Snapshot written (${snapshot.items.length} item(s)) — folds into the morning email, not sent separately`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Reddit Engagement Digest');
  console.log('=======================\n');

  // Preflight checks
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Load history
  const history = loadHistory();
  console.log(`Digest #${history.digestCount + 1} (phase: ${getPromoPhase(history.digestCount)})`);

  // 1. Fetch recent threads
  const threads = await fetchRecentThreads(history);
  if (threads.length === 0) {
    console.log('\nNo recent threads found. Skipping digest.');
    if (!DRY_RUN) writeDigestSnapshot({ subject: 'r/Broadway — no threads today', bannerText: 'No threads found', items: [] });
    return;
  }

  // 2. Enrich with comments
  const enriched = await enrichWithComments(threads);
  if (enriched.length === 0) {
    console.log('\nNo threads after comment enrichment. Skipping digest.');
    if (!DRY_RUN) writeDigestSnapshot({ subject: 'r/Broadway — no threads today', bannerText: 'No threads found', items: [] });
    return;
  }

  // 3. Claude evaluates and drafts
  const suggestions = await evaluateThreads(enriched, history);
  if (suggestions.length === 0) {
    console.log('\nNo threads worth replying to. Skipping digest.');
    if (!DRY_RUN) writeDigestSnapshot({ subject: 'r/Broadway — nothing worth replying to today', bannerText: 'Nothing worth replying to', items: [] });
    return;
  }

  // 4. Build the digest snapshot (card #511 — no longer emails on its own).
  const phaseLabel = getPhaseLabel(getPromoPhase(history.digestCount));
  const subject = `r/Broadway — ${suggestions.length} thread${suggestions.length !== 1 ? 's' : ''} for you`;
  const bannerText = `${suggestions.length} thread${suggestions.length !== 1 ? 's' : ''} (${phaseLabel})`;
  const items = buildDigestItems(suggestions);

  if (DRY_RUN) {
    console.log(`\nDry run — would write digest snapshot:`);
    console.log(`Subject: ${subject}`);
    console.log(`\nSuggestions:`);
    for (const s of suggestions) {
      console.log(`  [${s.score}] ${s.category}: "${s.threadTitle.slice(0, 60)}"`);
      console.log(`    Draft: ${s.draftReply.slice(0, 100)}...`);
      if (s.promoLink) console.log(`    ** Includes promo link **`);
      if (s.assumesSaw) console.log(`    ** Assumes saw: ${s.assumesSaw} **`);
      console.log();
    }
  } else {
    // DRY_RUN must never touch the real digest snapshot — it must stay a
    // preview, not silently overwrite what the morning email will actually
    // read (same ship-check finding card #497 fixed for send-daily-digest.js).
    writeDigestSnapshot({ subject, bannerText, items });
  }

  // 5. Update history
  // Track promo digests BEFORE incrementing count (so the recorded number matches)
  if (suggestions.some(s => s.promoLink)) {
    history.promoDigests.push(history.digestCount + 1);
  }
  history.digestCount++;
  history.lastDigestAt = new Date().toISOString();
  for (const s of suggestions) {
    history.suggestedThreadIds.push(s.threadId);
  }
  // Keep history from growing unbounded
  if (history.suggestedThreadIds.length > 1000) {
    history.suggestedThreadIds = history.suggestedThreadIds.slice(-500);
  }
  if (history.promoDigests.length > 100) {
    history.promoDigests = history.promoDigests.slice(-50);
  }

  saveHistory(history);
  console.log(`\nDone. History saved (digest #${history.digestCount}).`);

  // Write result for CI summary
  const result = {
    digestNumber: history.digestCount,
    threadsEvaluated: enriched.length,
    threadsSuggested: suggestions.length,
    promoLinksIncluded: suggestions.filter(s => s.promoLink).length,
    dryRun: DRY_RUN,
  };
  fs.writeFileSync('/tmp/reddit-digest-result.json', JSON.stringify(result, null, 2));
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
