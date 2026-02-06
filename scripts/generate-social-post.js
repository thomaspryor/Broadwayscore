#!/usr/bin/env node

/**
 * Social Media Post Generator
 *
 * Fully automated social media posting for Broadway Scorecard.
 * Selects content type (day-of-week rotation or event trigger),
 * gathers data, generates tweet text via Claude, creates a social
 * card image, and posts to Twitter/X.
 *
 * CLI:
 *   node scripts/generate-social-post.js                     # Auto-select daily type
 *   node scripts/generate-social-post.js --type=spotlight     # Force content type
 *   node scripts/generate-social-post.js --event=opened --show=SLUG  # Event trigger
 *   node scripts/generate-social-post.js --dry-run            # Generate but don't post
 *
 * Content types (day-of-week rotation):
 *   Monday:    box-office    - Top 5 grossing shows
 *   Tuesday:   spotlight     - Feature a high-scoring show
 *   Wednesday: insight       - Data-driven "did you know" fact
 *   Thursday:  picks         - Weekend recommendations
 *   Friday:    divergence    - Biggest critic/audience gap
 *   Saturday:  closing       - Shows closing soon
 *   Sunday:    reviews       - New reviews this week
 *
 * Event triggers (override daily rotation):
 *   --event=opened --show=SLUG   Show just opened
 *   --event=closed --show=SLUG   Show just closed
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'social-post-history.json');
const RESULT_FILE = '/tmp/social-post-result.json';
const BASE_URL = 'https://broadwayscorecard.com';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
}
const DRY_RUN = args.includes('--dry-run');
const FORCE_TYPE = getArg('type');
const EVENT = getArg('event');
const EVENT_SHOW = getArg('show');

// ─── Data Loading ─────────────────────────────────────────────

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function loadShows() {
  const data = loadJSON('shows.json');
  if (!data) return [];
  // shows.json is { _meta, shows: [...] }
  if (data.shows && Array.isArray(data.shows)) return data.shows;
  if (Array.isArray(data)) return data;
  return Object.values(data).filter(v => v && typeof v === 'object' && v.title);
}

// Outlet tier mapping (from src/config/scoring.ts via src/lib/outlet-id-mapper.ts)
// Tier weights: 1 = 1.0, 2 = 0.75, 3 = 0.45 (default = 3)
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.45 };
const OUTLET_TIER_MAP = {
  // Tier 1
  'nytimes': 1, 'nyt-theater': 1, 'washpost': 1, 'latimes': 1, 'wsj': 1,
  'ap': 1, 'associated-press': 1, 'variety': 1, 'hollywood-reporter': 1,
  'vulture': 1, 'guardian': 1, 'timeout': 1, 'broadwaynews': 1, 'newyorker': 1,
  // Tier 2
  'chicagotribune': 2, 'usatoday': 2, 'usa-today': 2, 'nydailynews': 2, 'nypost': 2,
  'thewrap': 2, 'ew': 2, 'entertainment-weekly': 2, 'indiewire': 2, 'deadline': 2,
  'slantmagazine': 2, 'dailybeast': 2, 'observer': 2, 'nytg': 2, 'nysr': 2,
  'theatermania': 2, 'theatrely': 2, 'newsday': 2, 'time': 2, 'rollingstone': 2,
  'bloomberg': 2, 'vox': 2, 'slate': 2, 'people': 2, 'parade': 2, 'billboard': 2,
  'huffpost': 2, 'backstage': 2, 'village-voice': 2,
  // Everything else defaults to Tier 3
};

function getOutletTier(outletId) {
  if (!outletId) return 3;
  return OUTLET_TIER_MAP[outletId.toLowerCase()] || 3;
}

/**
 * Compute per-show scores from flat reviews array using tier-weighted averaging.
 * Matches the website's engine.ts:computeCriticScore() → weightedScore methodology.
 * reviews.json is { _meta, reviews: [ {showId, assignedScore, outletId, ...}, ... ] }
 * Returns { [showId]: { compositeScore, reviewCount, title } }
 */
function computeShowScores() {
  const data = loadJSON('reviews.json');
  if (!data?.reviews) return {};

  const byShow = {};
  for (const r of data.reviews) {
    if (!r.showId || r.assignedScore == null) continue;
    if (!byShow[r.showId]) byShow[r.showId] = { reviews: [], title: r.showTitle || r.showId };
    byShow[r.showId].reviews.push({ score: r.assignedScore, outletId: r.outletId });
  }

  const result = {};
  for (const [showId, { reviews, title }] of Object.entries(byShow)) {
    if (reviews.length === 0) continue;
    // Tier-weighted average (matching engine.ts)
    let weightedSum = 0;
    let totalWeight = 0;
    for (const r of reviews) {
      const tier = getOutletTier(r.outletId);
      const weight = TIER_WEIGHTS[tier];
      weightedSum += r.score * weight;
      totalWeight += weight;
    }
    const weightedScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
    result[showId] = { compositeScore: weightedScore, reviewCount: reviews.length, title };
  }
  return result;
}

// Cached scores
let _showScores = null;
function getShowScores() {
  if (!_showScores) _showScores = computeShowScores();
  return _showScores;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return { _meta: { description: 'Tracks social media posts', lastUpdated: null }, posts: [] };
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

function saveHistory(history) {
  history._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
}

function saveResult(result) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
}

// ─── Helpers ──────────────────────────────────────────────────

function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  // Broadway season runs roughly June–May (Tony cutoff late April)
  return month >= 5 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// ─── Dedup ────────────────────────────────────────────────────

function wasPostedRecently(history, showId, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return history.posts.some(p =>
    p.showId === showId && new Date(p.date).getTime() > cutoff
  );
}

// ─── Content Generators ───────────────────────────────────────

function getBoxOfficeContent() {
  const grosses = loadJSON('grosses.json');
  if (!grosses?.shows) return null;

  // Build slug→title lookup from shows.json (never derive titles from slugs)
  const allShows = loadShows();
  const titleBySlug = {};
  for (const s of allShows) {
    titleBySlug[s.slug] = s.title;
    titleBySlug[s.id] = s.title;
  }

  const shows = Object.entries(grosses.shows)
    .filter(([, d]) => d.thisWeek?.gross)
    .map(([slug, d]) => ({
      slug,
      title: titleBySlug[slug] || slug,
      gross: d.thisWeek.gross,
      capacity: d.thisWeek.capacity,
      change: d.thisWeek.capacityPrevWeek != null && d.thisWeek.capacity != null
        ? d.thisWeek.capacity - d.thisWeek.capacityPrevWeek
        : null,
    }))
    .sort((a, b) => b.gross - a.gross)
    .slice(0, 5);

  if (shows.length === 0) return null;

  return {
    type: 'box-office',
    url: `${BASE_URL}/box-office`,
    imageType: 'box-office',
    imageData: {
      weekEnding: grosses.weekEnding || '',
      shows: shows.map((s, i) => ({ rank: i + 1, title: s.title, gross: s.gross, capacity: s.capacity, change: s.change })),
    },
    promptData: `Top 5 Broadway grosses this week:\n${shows.map((s, i) => `${i + 1}. ${s.title}: $${(s.gross / 1000000).toFixed(1)}M (${s.capacity}% capacity)`).join('\n')}`,
    prompt: `Write a brief tweet about this week's Broadway box office. Mention the top grosser and one interesting trend (biggest jump, capacity, etc.). Under 230 chars. End with the URL: ${BASE_URL}/box-office`,
  };
}

function getSpotlightContent(history) {
  const scores = getShowScores();
  const consensus = loadJSON('critic-consensus.json');
  const shows = loadShows();
  if (!shows || Object.keys(scores).length === 0) return null;

  // Open shows with score >= 70 and enough reviews
  const candidates = shows
    .filter(s => s.status === 'open' || s.status === 'previews')
    .map(s => {
      const r = scores[s.id];
      if (!r || r.reviewCount < 5 || r.compositeScore < 70) return null;
      return { ...s, score: r.compositeScore, reviewCount: r.reviewCount };
    })
    .filter(Boolean)
    .filter(s => !wasPostedRecently(history, s.id, 30))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  // Pick a random one from the top 10 (adds variety)
  const pick = candidates[Math.floor(Math.random() * Math.min(10, candidates.length))];
  const con = consensus?.shows?.[pick.id];

  return {
    type: 'spotlight',
    showId: pick.id,
    url: `${BASE_URL}/show/${pick.slug}`,
    imageType: 'show',
    imageData: { title: pick.title, score: pick.score, reviewCount: pick.reviewCount, venue: pick.venue, showId: pick.id },
    promptData: `Show: ${pick.title}\nScore: ${Math.round(pick.score)}/100 (${pick.reviewCount} reviews)\nVenue: ${pick.venue}\nType: ${pick.type}\n${con?.text ? `Critics' Take: ${con.text}` : ''}`,
    prompt: `Write a tweet spotlighting this Broadway show. Be conversational, not salesy. Include the score. Under 230 chars. End with: ${BASE_URL}/show/${pick.slug}`,
  };
}

function getInsightContent() {
  const scores = getShowScores();
  const shows = loadShows();
  if (!shows || Object.keys(scores).length === 0) return null;

  const openShows = shows.filter(s => s.status === 'open');
  const scored = openShows.map(s => {
    const r = scores[s.id];
    return r && r.reviewCount >= 5 ? { title: s.title, score: r.compositeScore, reviewCount: r.reviewCount } : null;
  }).filter(Boolean);

  const avgScore = scored.length > 0 ? (scored.reduce((sum, s) => sum + s.score, 0) / scored.length).toFixed(1) : 'N/A';
  const highest = [...scored].sort((a, b) => b.score - a.score)[0];
  const lowest = [...scored].sort((a, b) => a.score - b.score)[0];
  const mostReviewed = [...scored].sort((a, b) => b.reviewCount - a.reviewCount)[0];

  const totalReviews = Object.values(scores).reduce((sum, r) => sum + (r?.reviewCount || 0), 0);
  const totalShows = shows.length;

  return {
    type: 'insight',
    url: BASE_URL,
    imageType: 'generic',
    imageData: {}, // Will be filled after LLM generates the headline
    promptData: `Data points:\n- ${openShows.length} shows currently on Broadway\n- Average score of open shows: ${avgScore}/100\n- Highest rated open: ${highest?.title} (${Math.round(highest?.score || 0)})\n- Lowest rated open: ${lowest?.title} (${Math.round(lowest?.score || 0)})\n- Most reviewed: ${mostReviewed?.title} (${mostReviewed?.reviewCount} reviews)\n- Total in database: ${totalShows} shows, ${totalReviews} reviews\n- Season: ${getCurrentSeason()}`,
    prompt: `You're a Broadway data nerd. Pick the most interesting fact from this data and write a "did you know" style tweet. Be specific with numbers. Under 240 chars. End with: ${BASE_URL}`,
  };
}

function getPicksContent(history) {
  const scores = getShowScores();
  const shows = loadShows();
  if (!shows || Object.keys(scores).length === 0) return null;

  const candidates = shows
    .filter(s => s.status === 'open')
    .map(s => {
      const r = scores[s.id];
      if (!r || r.reviewCount < 5 || r.compositeScore < 75) return null;
      return { ...s, score: r.compositeScore, reviewCount: r.reviewCount };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  // Pick top 4, excluding exact same set from last week
  const picks = candidates.slice(0, 4);
  if (picks.length < 2) return null;

  return {
    type: 'picks',
    url: `${BASE_URL}/browse/best-broadway-shows`,
    imageType: 'picks',
    imageData: {
      headline: 'Weekend Picks',
      shows: picks.map(s => ({ title: s.title, score: s.score, reviewCount: s.reviewCount, showId: s.id })),
    },
    promptData: `Top picks for this weekend:\n${picks.map(s => `- ${s.title} (${Math.round(s.score)}/100, ${s.reviewCount} reviews)`).join('\n')}`,
    prompt: `Recommend these Broadway shows for the weekend. Brief, enthusiastic but honest. Under 200 chars. End with: ${BASE_URL}/browse/best-broadway-shows`,
  };
}

function getDivergenceContent(history) {
  const scores = getShowScores();
  const audience = loadJSON('audience-buzz.json');
  const shows = loadShows();
  if (!audience || !shows || Object.keys(scores).length === 0) return null;

  const candidates = shows
    .filter(s => s.status === 'open')
    .map(s => {
      const r = scores[s.id];
      const a = audience.shows?.[s.id];
      if (!r || !a?.combinedScore || r.reviewCount < 5) return null;
      const gap = Math.abs(r.compositeScore - a.combinedScore);
      return { ...s, criticScore: r.compositeScore, audienceScore: a.combinedScore, gap, reviewCount: r.reviewCount };
    })
    .filter(Boolean)
    .filter(s => !wasPostedRecently(history, s.id, 60))
    .sort((a, b) => b.gap - a.gap);

  if (candidates.length === 0) return null;
  const pick = candidates[0];
  const direction = pick.criticScore > pick.audienceScore ? 'critics love more' : 'audiences love more';

  return {
    type: 'divergence',
    showId: pick.id,
    url: `${BASE_URL}/show/${pick.slug}`,
    imageType: 'show',
    imageData: { title: pick.title, score: pick.criticScore, reviewCount: pick.reviewCount, venue: pick.venue, showId: pick.id },
    promptData: `Show: ${pick.title}\nCritic score: ${Math.round(pick.criticScore)}/100\nAudience score: ${Math.round(pick.audienceScore)}/100\nGap: ${Math.round(pick.gap)} points (${direction})`,
    prompt: `Critics scored ${pick.title} at ${Math.round(pick.criticScore)}, but audiences gave it ${Math.round(pick.audienceScore)}. Write a tweet about this gap. Be curious, not judgmental. Under 230 chars. End with: ${BASE_URL}/show/${pick.slug}`,
  };
}

function getClosingContent(history) {
  const shows = loadShows();
  const scores = getShowScores();
  if (!shows) return null;

  const now = new Date();
  const candidates = shows
    .filter(s => {
      if (s.status !== 'open' || !s.closingDate) return false;
      const closing = new Date(s.closingDate);
      const daysLeft = Math.ceil((closing - now) / (1000 * 60 * 60 * 24));
      return daysLeft > 0 && daysLeft <= 30;
    })
    .map(s => {
      const r = scores[s.id];
      const daysLeft = Math.ceil((new Date(s.closingDate) - now) / (1000 * 60 * 60 * 24));
      return { ...s, score: r?.compositeScore, reviewCount: r?.reviewCount || 0, daysLeft };
    })
    .filter(s => !wasPostedRecently(history, s.id, 14))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (candidates.length === 0) return null;
  const pick = candidates[0];

  return {
    type: 'closing',
    showId: pick.id,
    url: `${BASE_URL}/show/${pick.slug}`,
    imageType: 'show',
    imageData: { title: pick.title, score: pick.score, reviewCount: pick.reviewCount, venue: pick.venue, showId: pick.id },
    promptData: `Show: ${pick.title}\nClosing: ${pick.closingDate} (${pick.daysLeft} days left)\nScore: ${pick.score ? Math.round(pick.score) + '/100' : 'N/A'}\nVenue: ${pick.venue}`,
    prompt: `${pick.title} closes on ${new Date(pick.closingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. ${pick.score ? `It scored ${Math.round(pick.score)}/100.` : ''} Write a "last chance to see" tweet. Informative, not FOMO. Under 230 chars. End with: ${BASE_URL}/show/${pick.slug}`,
  };
}

function getReviewsContent() {
  const data = loadJSON('reviews.json');
  if (!data?.reviews) return null;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const showsWithNewReviews = {};

  for (const r of data.reviews) {
    if (!r.showId || !r.publishDate || r.publishDate < oneWeekAgo) continue;
    if (!showsWithNewReviews[r.showId]) {
      showsWithNewReviews[r.showId] = { count: 0, title: r.showTitle || r.showId };
    }
    showsWithNewReviews[r.showId].count++;
  }

  const entries = Object.entries(showsWithNewReviews).sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) return null;

  const totalNew = entries.reduce((sum, [, d]) => sum + d.count, 0);
  const topShows = entries.slice(0, 5).map(([, d]) => `${d.title} (${d.count})`).join(', ');

  return {
    type: 'reviews',
    url: BASE_URL,
    imageType: 'generic',
    imageData: { headline: `${totalNew} New Reviews This Week`, subtitle: `Across ${entries.length} shows` },
    promptData: `New reviews this week: ${totalNew} across ${entries.length} shows.\nTop shows: ${topShows}`,
    prompt: `We added ${totalNew} new critic reviews this week across ${entries.length} shows. Highlights: ${topShows}. Write a brief recap tweet. Under 230 chars. End with: ${BASE_URL}`,
  };
}

function getEventContent(event, showSlug) {
  const shows = loadShows();
  const scores = getShowScores();
  const show = shows.find(s => s.slug === showSlug || s.id === showSlug);
  if (!show) {
    console.log(`[Social] Show not found: ${showSlug}`);
    return null;
  }

  const r = scores[show.id];
  const score = r?.compositeScore || null;
  const reviewCount = r?.reviewCount || 0;

  if (event === 'opened') {
    return {
      type: 'event-opened',
      showId: show.id,
      url: `${BASE_URL}/show/${show.slug}`,
      imageType: 'show',
      imageData: { title: show.title, score, reviewCount, venue: show.venue, showId: show.id },
      promptData: `${show.title} just officially opened at ${show.venue}.${score ? ` Early critic score: ${Math.round(score)}/100 from ${reviewCount} reviews.` : ''}`,
      prompt: `${show.title} just opened on Broadway at ${show.venue}.${score ? ` Critic score so far: ${Math.round(score)}/100 from ${reviewCount} reviews.` : ''} Write a brief announcement tweet. Under 230 chars. End with: ${BASE_URL}/show/${show.slug}`,
    };
  }

  if (event === 'closed') {
    return {
      type: 'event-closed',
      showId: show.id,
      url: `${BASE_URL}/show/${show.slug}`,
      imageType: 'show',
      imageData: { title: show.title, score, reviewCount, venue: show.venue, showId: show.id },
      promptData: `${show.title} has closed at ${show.venue}.${score ? ` Final critic score: ${Math.round(score)}/100 from ${reviewCount} reviews.` : ''}`,
      prompt: `${show.title} has taken its final bow at ${show.venue}.${score ? ` Final score: ${Math.round(score)}/100 from ${reviewCount} reviews.` : ''} Write a brief closing tweet. Respectful, celebratory of the run. Under 230 chars. End with: ${BASE_URL}/show/${show.slug}`,
    };
  }

  return null;
}

// ─── Day-of-week rotation ─────────────────────────────────────

const DAY_TYPES = [
  'reviews',     // Sunday (0)
  'box-office',  // Monday
  'spotlight',   // Tuesday
  'insight',     // Wednesday
  'picks',       // Thursday
  'divergence',  // Friday
  'closing',     // Saturday
];

function selectContent(history) {
  // Event triggers override everything
  if (EVENT && EVENT_SHOW) {
    return getEventContent(EVENT, EVENT_SHOW);
  }

  // Force type or day-of-week rotation
  const type = FORCE_TYPE || DAY_TYPES[new Date().getDay()];
  console.log(`[Social] Content type: ${type}`);

  const generators = {
    'box-office': () => getBoxOfficeContent(),
    'spotlight': () => getSpotlightContent(history),
    'insight': () => getInsightContent(),
    'picks': () => getPicksContent(history),
    'divergence': () => getDivergenceContent(history),
    'closing': () => getClosingContent(history),
    'reviews': () => getReviewsContent(),
  };

  const gen = generators[type];
  if (!gen) {
    console.log(`[Social] Unknown type: ${type}, falling back to spotlight`);
    return getSpotlightContent(history);
  }

  const content = gen();

  // Fallback chain: if primary type has no content, try spotlight → insight
  if (!content) {
    console.log(`[Social] No content for ${type}, trying spotlight fallback`);
    const fallback = getSpotlightContent(history) || getInsightContent();
    return fallback;
  }

  return content;
}

// ─── LLM Text Generation ──────────────────────────────────────

async function generateTweetText(content) {
  const Anthropic = require('@anthropic-ai/sdk');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[Social] No ANTHROPIC_API_KEY — skipping (will not post raw data)');
    return null;
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You write social media posts for Broadway Scorecard (broadwayscorecard.com), a review aggregator for Broadway shows.

Rules:
- Never use hashtags
- Never use emojis excessively (one is fine, zero is fine too)
- Never say "check out" or "head to" or "visit"
- Be conversational, witty when appropriate, never corporate
- Always include the numeric score when relevant
- Vary your opening — don't start with the show name every time
- The URL MUST appear at the end of the tweet, on its own line
- Total tweet including URL must be under 280 characters`;

  const fullPrompt = `${content.promptData}\n\n${content.prompt}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      temperature: 0.8,
      system: systemPrompt,
      messages: [{ role: 'user', content: fullPrompt }],
    });

    let text = message.content[0].text.trim();

    // Ensure URL is included
    if (!text.includes(content.url)) {
      text = text + '\n' + content.url;
    }

    // Trim to 280 chars if needed (break at last sentence before limit)
    if (text.length > 280) {
      const urlPart = '\n' + content.url;
      const maxBody = 280 - urlPart.length;
      let body = text.replace(urlPart, '').replace(content.url, '');
      if (body.length > maxBody) {
        // Find last sentence end before the limit
        const truncated = body.slice(0, maxBody);
        const lastPeriod = truncated.lastIndexOf('.');
        if (lastPeriod > maxBody * 0.5) {
          body = truncated.slice(0, lastPeriod + 1);
        } else {
          body = truncated.trim();
        }
      }
      text = body + urlPart;
    }

    return text;
  } catch (err) {
    console.error('[Social] LLM error:', err.message);
    return null; // Don't post raw data — caller will alert via Discord
  }
}

// ─── Discord Alerts ──────────────────────────────────────────

async function sendDiscordAlert(title, description, severity = 'error') {
  try {
    const { sendAlert } = require('./lib/discord-notify');
    await sendAlert({ title, description, severity });
  } catch (err) {
    console.error('[Social] Discord alert failed:', err.message);
  }
}

// ─── Dead Man's Switch ───────────────────────────────────────

async function checkDeadManSwitch(history) {
  if (history.posts.length === 0) return; // Nothing posted yet, skip check

  const lastPost = history.posts[history.posts.length - 1];
  const daysSinceLastPost = (Date.now() - new Date(lastPost.date).getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceLastPost > 3) {
    console.log(`[Social] Dead man's switch: ${Math.round(daysSinceLastPost)} days since last post`);
    await sendDiscordAlert(
      'Social Media Silent for ' + Math.round(daysSinceLastPost) + ' Days',
      `No social media post has succeeded in ${Math.round(daysSinceLastPost)} days. Last post: "${lastPost.text?.slice(0, 100)}..." (${lastPost.type}). Check Twitter secrets, Anthropic API key, or workflow logs.`,
      'warning'
    );
  }
}

// ─── History Pruning ─────────────────────────────────────────

function pruneHistory(history) {
  const MAX_ENTRIES = 365;
  if (history.posts.length > MAX_ENTRIES) {
    const pruned = history.posts.length - MAX_ENTRIES;
    history.posts = history.posts.slice(-MAX_ENTRIES);
    console.log(`[Social] Pruned ${pruned} old history entries (keeping ${MAX_ENTRIES})`);
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`[Social] Starting social post generation${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const history = loadHistory();

  // Check dead man's switch (alert if no post in 3+ days)
  await checkDeadManSwitch(history);

  // 1. Select content
  const content = selectContent(history);
  if (!content) {
    console.log('[Social] No content to post today');
    saveResult({ type: 'none', text: '', dryRun: DRY_RUN });
    return;
  }

  console.log(`[Social] Selected: ${content.type}${content.showId ? ` (${content.showId})` : ''}`);

  // 2. Generate tweet text via LLM
  const tweetText = await generateTweetText(content);
  if (!tweetText) {
    console.log('[Social] LLM failed to generate text — skipping post');
    await sendDiscordAlert(
      'Social Post Skipped: LLM Failed',
      `Could not generate tweet text for ${content.type} post. Check ANTHROPIC_API_KEY.`,
      'warning'
    );
    saveResult({ type: content.type, text: '', dryRun: DRY_RUN, success: false });
    return;
  }
  console.log(`[Social] Tweet text (${tweetText.length} chars):\n${tweetText}`);

  // 3. Generate social card image
  let imagePath = null;
  try {
    const { generateSocialImage } = require('./social-image-generator');

    // For insight type, extract headline from the generated tweet for the image
    if (content.type === 'insight' && content.imageType === 'generic') {
      const firstLine = tweetText.split('\n')[0].replace(BASE_URL, '').trim();
      content.imageData = { headline: firstLine.slice(0, 80), subtitle: 'broadwayscorecard.com' };
    }

    imagePath = await generateSocialImage({
      type: content.imageType,
      data: content.imageData,
    });
  } catch (err) {
    console.error('[Social] Image generation failed:', err.message);
    // Post without image — tweet-only is fine
  }

  // 4. Post to Twitter
  let tweetResult = { success: false };
  if (!DRY_RUN) {
    const { postTweet, isConfigured } = require('./lib/twitter-client');
    if (isConfigured()) {
      tweetResult = await postTweet({ text: tweetText, imagePath });
      if (!tweetResult.success) {
        await sendDiscordAlert(
          'Social Post Failed: Twitter Error',
          `Failed to post tweet: ${tweetResult.error || 'unknown'}. Type: ${content.type}.`,
          'error'
        );
      }
    } else {
      console.log('[Social] Twitter not configured, skipping post');
    }
  } else {
    console.log('[Social] DRY RUN — would post tweet');
    tweetResult = { success: true, dryRun: true };
  }

  // 5. Update history
  if (tweetResult.success && !DRY_RUN) {
    history.posts.push({
      date: new Date().toISOString(),
      type: content.type,
      showId: content.showId || null,
      tweetId: tweetResult.tweetId || null,
      tweetUrl: tweetResult.tweetUrl || null,
      text: tweetText,
    });
    pruneHistory(history);
    saveHistory(history);
    console.log('[Social] History updated');
  }

  // 6. Save result for workflow summary
  saveResult({
    type: content.type,
    showId: content.showId || null,
    text: tweetText,
    tweetUrl: tweetResult.tweetUrl || null,
    imagePath,
    dryRun: DRY_RUN,
    success: tweetResult.success,
  });

  console.log(`[Social] Done. ${tweetResult.success ? 'Posted successfully.' : 'Post failed or skipped.'}`);
}

main().catch(err => {
  console.error('[Social] Fatal error:', err);
  process.exit(1);
});
