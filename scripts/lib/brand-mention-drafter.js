/**
 * brand-mention-drafter.js
 *
 * Takes a normalized mention and asks Claude Sonnet to:
 *   1. Classify sentiment (positive / neutral / negative / hostile)
 *   2. Decide whether a response is appropriate (shouldRespond bool)
 *   3. If yes, draft a response in thomaspryor's voice with platform
 *      constraints (X: 280 chars, Reddit: ≤120 words, Bluesky: 300 chars)
 *
 * Returns a structured verdict the orchestrator can act on:
 *   {
 *     sentiment: 'positive' | 'neutral' | 'negative' | 'hostile',
 *     shouldRespond: boolean,
 *     confidence: 'high' | 'medium' | 'low',
 *     reason: string,
 *     draftResponse: string | null,
 *     platformLimit: number    // char limit used for the draft
 *   }
 *
 * Guardrails:
 *   - Never drafts for hostile / flame-bait content
 *   - Never drafts if keyword appears only in a URL (e.g., list of links)
 *   - Never auto-publishes — all drafts go to Buffer/Discord for human review
 *   - Hard fail → returns { shouldRespond: false, sentiment: 'neutral' }
 *     so the orchestrator can still log the mention without crashing
 */

const https = require('https');
const { VOICE_CHARACTERISTICS } = require('./voice-characteristics');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';  // Claude Sonnet 4.5, stable
const FALLBACK_MODEL = 'claude-3-5-sonnet-20241022';  // last-known-good fallback

// Platform character/word limits
const PLATFORM_LIMITS = {
  x:       { kind: 'chars', limit: 280, label: 'X/Twitter (280 chars)' },
  reddit:  { kind: 'words', limit: 120, label: 'Reddit (≤120 words)' },
  bluesky: { kind: 'chars', limit: 300, label: 'Bluesky (300 chars)' },
  hn:      { kind: 'words', limit: 100, label: 'Hacker News (≤100 words)' },
  google:  { kind: 'chars', limit: 0,   label: 'Google web — no-reply source' },
  news:    { kind: 'chars', limit: 0,   label: 'News article — no-reply source' },
  forum:   { kind: 'words', limit: 150, label: 'Web forum (≤150 words)' },
};

function getPlatformLimit(source) {
  return PLATFORM_LIMITS[source] || { kind: 'chars', limit: 280, label: 'generic (280 chars)' };
}

// ──────────────────────────────────────────────────────────────────────────
// Anthropic API call
// ──────────────────────────────────────────────────────────────────────────

function callClaude(messages, { apiKey, model = MODEL, maxTokens = 800, temperature = 0.4, system = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages,
    });

    const u = new URL(ANTHROPIC_API_URL);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Anthropic API ${res.statusCode}: ${body.slice(0, 300)}`));
          }
          try {
            const data = JSON.parse(body);
            const text = data.content && data.content[0] && data.content[0].text;
            if (!text) return reject(new Error('Empty response from Claude'));
            resolve(text);
          } catch (e) {
            reject(new Error(`Failed to parse Claude response: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Claude API timeout (30s)'));
    });
    req.write(payload);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are thomaspryor's assistant, drafting responses to online mentions of BroadwayScorecard (broadwayscorecard.com) — a data-driven Broadway critic score aggregator he built and maintains.

Your job has TWO parts on every mention:

1. CLASSIFY the mention on these axes:
   - sentiment: positive | neutral | negative | hostile
   - shouldRespond: true if a genuine reply adds value, false otherwise
   - confidence: high | medium | low
   - reason: one sentence explaining the classification

2. IF shouldRespond is true, DRAFT a response following these voice guidelines:

${VOICE_CHARACTERISTICS}

When to set shouldRespond=false:
- Hostile / flame-bait content (feed is the wrong response)
- Keyword appears only in a URL/link list with no real discussion
- Mention is pure news aggregation (no human author to reply to)
- Content is already old and the thread is dead
- The user is a bot or obvious spam account
- The mention is on a news article's Google/News result (no reply UI exists)
- The mention is CRITICISM where a reply would escalate rather than help

When to set shouldRespond=true:
- Someone asks a genuine question about the data/methodology
- Someone shares a positive experience and a thank-you adds warmth
- Someone has a misconception you can correct factually without being defensive
- Someone references BWSC data in a discussion where adding context helps

OUTPUT FORMAT — you MUST return exactly this JSON object (no prose, no markdown fences):

{
  "sentiment": "positive|neutral|negative|hostile",
  "shouldRespond": true|false,
  "confidence": "high|medium|low",
  "reason": "one sentence",
  "draftResponse": "the draft, or null if shouldRespond is false"
}`;
}

function buildUserPrompt(mention, platformLimit) {
  const parts = [];
  parts.push(`PLATFORM: ${mention.source}`);
  parts.push(`LIMIT: ${platformLimit.label}`);
  if (mention.subreddit) parts.push(`SUBREDDIT: r/${mention.subreddit}`);
  if (mention.author) parts.push(`AUTHOR: ${mention.author}`);
  if (mention.publishedAt) parts.push(`POSTED: ${mention.publishedAt}`);
  parts.push(`URL: ${mention.url}`);
  parts.push('');
  parts.push(`TITLE: ${mention.title || '(no title)'}`);
  parts.push('');
  parts.push(`CONTENT:`);
  parts.push(mention.excerpt || '(no excerpt)');
  parts.push('');
  parts.push(`Classify this mention and draft a response if appropriate. Return ONLY the JSON object — no explanation, no markdown fences.`);
  return parts.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Draft a response for a single mention
// ──────────────────────────────────────────────────────────────────────────

async function draftMentionResponse(mention, { apiKey = process.env.ANTHROPIC_API_KEY, verbose = false } = {}) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const platformLimit = getPlatformLimit(mention.source);

  // Short-circuit: sources with no reply UI (google, news) — classify only
  if (platformLimit.limit === 0) {
    return {
      sentiment: 'neutral',
      shouldRespond: false,
      confidence: 'high',
      reason: `${mention.source} is a no-reply source (article or search result)`,
      draftResponse: null,
      platformLimit,
    };
  }

  const system = buildSystemPrompt();
  const userMsg = buildUserPrompt(mention, platformLimit);

  let rawResponse;
  try {
    rawResponse = await callClaude(
      [{ role: 'user', content: userMsg }],
      { apiKey, system, temperature: 0.4 }
    );
  } catch (e) {
    if (verbose) console.warn(`[drafter] primary model failed: ${e.message}, trying fallback`);
    try {
      rawResponse = await callClaude(
        [{ role: 'user', content: userMsg }],
        { apiKey, model: FALLBACK_MODEL, system, temperature: 0.4 }
      );
    } catch (e2) {
      console.warn(`[drafter] both models failed: ${e2.message}`);
      return {
        sentiment: 'neutral',
        shouldRespond: false,
        confidence: 'low',
        reason: `Drafter failed: ${e2.message}`,
        draftResponse: null,
        platformLimit,
      };
    }
  }

  // Parse the JSON verdict
  let verdict;
  try {
    // Strip optional code fences Claude sometimes adds despite instructions
    const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    verdict = JSON.parse(cleaned);
  } catch (e) {
    if (verbose) console.warn(`[drafter] JSON parse failed: ${e.message}\nraw: ${rawResponse.slice(0, 300)}`);
    return {
      sentiment: 'neutral',
      shouldRespond: false,
      confidence: 'low',
      reason: `Could not parse drafter verdict: ${e.message}`,
      draftResponse: null,
      platformLimit,
    };
  }

  // Validate fields
  const sentiment = ['positive', 'neutral', 'negative', 'hostile'].includes(verdict.sentiment)
    ? verdict.sentiment
    : 'neutral';
  const confidence = ['high', 'medium', 'low'].includes(verdict.confidence)
    ? verdict.confidence
    : 'low';
  const shouldRespond = verdict.shouldRespond === true;
  const draft = verdict.draftResponse && typeof verdict.draftResponse === 'string' ? verdict.draftResponse : null;

  // Enforce platform limit — if Claude overshoots, downgrade confidence
  let finalDraft = draft;
  if (shouldRespond && draft) {
    if (platformLimit.kind === 'chars' && draft.length > platformLimit.limit) {
      if (verbose) console.warn(`[drafter] draft exceeds ${platformLimit.label} (${draft.length} chars); flagging low confidence`);
      // Don't auto-truncate — let the human handle it
      return {
        sentiment,
        shouldRespond: true,
        confidence: 'low',
        reason: `${verdict.reason || 'draft over limit'} — draft exceeds ${platformLimit.label}`,
        draftResponse: draft,
        platformLimit,
      };
    }
    if (platformLimit.kind === 'words') {
      const wc = draft.trim().split(/\s+/).length;
      if (wc > platformLimit.limit) {
        return {
          sentiment,
          shouldRespond: true,
          confidence: 'low',
          reason: `${verdict.reason || 'draft over limit'} — ${wc} words exceeds ${platformLimit.label}`,
          draftResponse: draft,
          platformLimit,
        };
      }
    }
  }

  return {
    sentiment,
    shouldRespond,
    confidence,
    reason: verdict.reason || '',
    draftResponse: finalDraft,
    platformLimit,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Batch draft with simple serialization + retry
// ──────────────────────────────────────────────────────────────────────────

async function draftMentions(mentions, opts = {}) {
  const results = [];
  for (const m of mentions) {
    try {
      const verdict = await draftMentionResponse(m, opts);
      results.push({ mention: m, verdict });
    } catch (e) {
      results.push({
        mention: m,
        verdict: {
          sentiment: 'neutral',
          shouldRespond: false,
          confidence: 'low',
          reason: `Drafter exception: ${e.message}`,
          draftResponse: null,
          platformLimit: getPlatformLimit(m.source),
        },
      });
    }
    // Small delay between calls to be polite to Anthropic
    if (mentions.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

module.exports = {
  draftMentionResponse,
  draftMentions,
  PLATFORM_LIMITS,
  getPlatformLimit,
};
