/**
 * LLM-based relevance filter + sentiment classification for Social Pulse
 * mentions.
 *
 * Why this exists: Apify scrapers return raw mentions matching a phrase
 * search. Many will be false positives ("maybe a happy ending" ≠ the
 * Broadway musical Maybe Happy Ending). Sentiment analysis is likewise
 * unreliable when done keyword-based — sarcasm, theater stan-speak, and
 * in-community language all confound simple classifiers.
 *
 * GPT-4o-mini handles both cleanly in one batched call per ~20 mentions.
 * Cost: ~$0.0002 per mention, so 50 mentions/show × 93 shows × weekly-ish
 * cadence ≈ $3/month total.
 */

const OpenAI = require('openai');
const { GPT4O_MINI } = require('./models');

const MODEL = GPT4O_MINI;
const BATCH_SIZE = 20;

/**
 * The system prompt establishes the LLM as a theater-buzz classifier. It is
 * deliberately short — GPT-4o-mini handles simple classification tasks well
 * with minimal instruction, and longer prompts just burn tokens.
 *
 * We ask for INDEXED output so a dropped/skipped item doesn't cascade-fail
 * the whole batch. Every item in the batch is labeled with [i=0], [i=1], …
 * and the LLM returns objects containing that index.
 */
function buildSystemPrompt(showTitle, marketLabel) {
  return `You are classifying social media posts about the ${marketLabel} show "${showTitle}".

For each input item (prefixed with its index [i=0], [i=1], etc.), return a classification:
- i: the integer index from the input
- relevant: true if the post is about the ${marketLabel} production of "${showTitle}" — INCLUDING casting news, cast photos, fan reposts, official show promos, user reactions. False only for unrelated uses of the phrase (e.g., "maybe a happy ending for this movie"), other unrelated productions, or noise.
- sentiment:
    "positive" — genuine audience enthusiasm ("loved it", "obsessed"), strong praise, fan art/tribute posts, celebratory cast news
    "negative" — disappointment, criticism, warnings, reports of cast cuts / early closures, backlash
    "mixed" — genuinely nuanced opinions where the author expresses BOTH praise and criticism
    "neutral" — factual/informational posts with NO opinion signal: news links, ticket listings, schedule announcements, cast announcements without commentary, retweets of official content without added opinion. Also: promotional content from the show's own official account (@HamiltonMusical, @CatsMusical, etc.) — marketing is not audience sentiment.

IMPORTANT: Return a result for EVERY input index, in order. If you are unsure about an item, default to relevant=true + sentiment=neutral rather than skipping it. Use "mixed" ONLY for genuinely mixed opinions, not for neutral/informational posts.

Return JSON: {"results": [{"i": 0, "relevant": true, "sentiment": "positive"}, {"i": 1, ...}, ...]}`;
}

/**
 * Classifies a batch of mentions in a single LLM call. Returns the same
 * mentions with `relevant` and `sentiment` fields populated.
 *
 * If the call fails or returns malformed JSON, every mention in the batch
 * is marked relevant=false with a warning logged — safer to drop ambiguous
 * data than display wrong classifications.
 */
async function classifyBatch({ openai, showTitle, marketLabel, batch, logger = console }) {
  // Prefix each item with [i=N] so the LLM can return indexed output.
  // Missing indices are tolerated — conservatively defaulted to
  // relevant=true + sentiment=mixed so we don't silently hide real content.
  const userContent = batch
    .map((m, i) => `[i=${i}] (${m.platform}) ${m.author || '?'}: ${m.text.slice(0, 500)}`)
    .join('\n');

  let response;
  try {
    response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(showTitle, marketLabel) },
        { role: 'user', content: userContent },
      ],
    });
  } catch (err) {
    logger.warn(`[${showTitle}] LLM classify batch failed: ${err.message}`);
    // Conservative default: relevant=true, sentiment=mixed. Better than
    // dropping real content.
    return batch.map((m) => ({ ...m, relevant: true, sentiment: 'neutral' }));
  }

  const raw = response.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`[${showTitle}] LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    return batch.map((m) => ({ ...m, relevant: true, sentiment: 'neutral' }));
  }

  const results = Array.isArray(parsed.results) ? parsed.results : Array.isArray(parsed) ? parsed : [];

  // Index-match results. Tolerate count mismatches (missing indices get
  // the conservative default).
  const byIndex = new Map();
  for (const r of results) {
    if (r && Number.isInteger(r.i) && r.i >= 0 && r.i < batch.length) {
      byIndex.set(r.i, r);
    }
  }

  if (byIndex.size !== batch.length) {
    logger.warn(
      `[${showTitle}] LLM returned ${byIndex.size}/${batch.length} classifications — defaulting missing to relevant=true neutral`,
    );
  }

  return batch.map((m, i) => {
    const r = byIndex.get(i);
    if (!r) {
      return { ...m, relevant: true, sentiment: 'neutral' };
    }
    const sentiment =
      r.sentiment === 'positive' || r.sentiment === 'negative' || r.sentiment === 'mixed' || r.sentiment === 'neutral'
        ? r.sentiment
        : 'neutral';
    return { ...m, relevant: Boolean(r.relevant), sentiment };
  });
}

/**
 * Classifies a full list of mentions in batches. Returns the same list with
 * relevant/sentiment fields populated.
 *
 * Empty or very short mentions (< 5 meaningful chars) are auto-marked
 * relevant=false without burning an LLM call.
 */
async function classifyMentions({ mentions, showTitle, marketLabel, openaiApiKey, logger = console }) {
  if (!Array.isArray(mentions) || mentions.length === 0) return [];
  if (!openaiApiKey) {
    throw new Error('classifyMentions requires openaiApiKey');
  }

  // Pre-filter: skip LLM for clearly empty/garbage text
  const needsClassify = [];
  const output = mentions.map((m) => {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (text.length < 5) {
      return { ...m, relevant: false, sentiment: 'neutral' };
    }
    needsClassify.push(m);
    return m;
  });

  const openai = new OpenAI({ apiKey: openaiApiKey });
  const classified = [];

  for (let i = 0; i < needsClassify.length; i += BATCH_SIZE) {
    const batch = needsClassify.slice(i, i + BATCH_SIZE);
    const result = await classifyBatch({ openai, showTitle, marketLabel, batch, logger });
    classified.push(...result);
  }

  // Merge classified results back by reference
  const classifiedMap = new Map(classified.map((m) => [m.url || m.text, m]));
  return output.map((m) => {
    if (typeof m.relevant === 'boolean') return m; // already handled in pre-filter
    const key = m.url || m.text;
    return classifiedMap.get(key) || { ...m, relevant: false, sentiment: 'mixed' };
  });
}

/**
 * Rough cost estimate for a batch of N mentions at the current model.
 * GPT-4o-mini: $0.15/1M input tokens, $0.60/1M output tokens. Per-mention
 * overhead is ~150 input tokens + 20 output tokens, so:
 *   input cost  = N * 150 / 1e6 * 0.15 ≈ N * 0.0000225
 *   output cost = N * 20  / 1e6 * 0.60 ≈ N * 0.000012
 * Total per mention: ~$0.000035. 50 mentions per show × 93 shows × weekly
 * cadence ≈ $0.65/month. Conservative budget line item: $3/month.
 */
function estimateCost(mentionCount) {
  return mentionCount * 0.000035;
}

module.exports = {
  classifyMentions,
  classifyBatch,
  buildSystemPrompt,
  estimateCost,
  MODEL,
  BATCH_SIZE,
};
