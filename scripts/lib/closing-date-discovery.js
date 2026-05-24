/**
 * closing-date-discovery.js
 *
 * Discover the announced Broadway closing date for a show by SERP-searching
 * credible theater press within the last 30 days and LLM-extracting the date
 * from each candidate article. Returns null unless ≥2 high-confidence
 * extractions agree within ±3 days (or 1 extraction names BOTH the show and
 * an explicit "final performance" date).
 *
 * Used by scripts/audit-closing-dates.js as the second of three signals in
 * the triple-signal auto-fix: only auto-apply a new closingDate when
 * broadway.com schedule + press article + LLM extraction all agree within
 * ±7 days of each other. Failures fall through to the human-review Notion
 * card path.
 */

const https = require('https');
const { serpQuery } = require('./url-discovery');
const { fetchPage } = require('../lib/scraper');

const CREDIBLE_HOSTS = [
  'variety.com',
  'playbill.com',
  'deadline.com',
  'broadwayworld.com',
  'broadway.com',
  'broadwaynews.com',
  'theatermania.com',
  'newyorktheatreguide.com',
];

const CLUSTER_TOLERANCE_DAYS = 3;
const MAX_CANDIDATES_PER_SHOW = 5;

function callClaudeSonnet(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).content?.[0]?.text || ''); }
          catch (e) { reject(new Error(`Anthropic parse: ${e.message}`)); }
        } else {
          reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isCredibleUrl(url) {
  if (!url) return false;
  return CREDIBLE_HOSTS.some(h => url.includes(h));
}

function buildExtractionPrompt(showTitle, text, url) {
  return `You are extracting the announced final Broadway performance date from a press article.

Show: ${showTitle}
Article URL: ${url}
Article text (truncated):
"""
${text}
"""

Return ONLY JSON in this exact form (no markdown, no commentary):
{"date": "YYYY-MM-DD" | null, "confidence": "high" | "medium" | "low", "quote": "the exact sentence stating the date" | null}

Rules:
- date = the FINAL Broadway performance announced in this article. Not opening, not previews, not a future tour stop, not a past extension if a newer date has been announced.
- confidence "high" ONLY if the article explicitly states a closing OR final-performance date for the named show on Broadway.
- If the article is about a tour, regional production, off-Broadway run, or West End run, return {"date": null, "confidence": "low", "quote": null}.
- If the date is ambiguous, a range, conditional, or not present, return {"date": null, "confidence": "low", "quote": null}.`;
}

function parseExtraction(raw) {
  if (!raw) return null;
  // Trim code fences if model added them
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const j = JSON.parse(cleaned);
    if (!j || typeof j !== 'object') return null;
    if (j.date && !/^\d{4}-\d{2}-\d{2}$/.test(j.date)) return null;
    if (!['high', 'medium', 'low'].includes(j.confidence)) return null;
    return { date: j.date || null, confidence: j.confidence, quote: j.quote || null };
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[^]*?<\/script>/g, ' ')
    .replace(/<style[^]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cluster dates by proximity: returns the date with the most agreements
// within ±CLUSTER_TOLERANCE_DAYS, plus the contributing sources.
function clusterDates(extractions) {
  if (extractions.length === 0) return null;
  const dated = extractions.filter(e => e.date && e.confidence === 'high');
  if (dated.length === 0) return null;

  let best = null;
  for (let i = 0; i < dated.length; i++) {
    const center = new Date(dated[i].date);
    const cluster = dated.filter(e => {
      const d = new Date(e.date);
      return Math.abs((d - center) / 86400000) <= CLUSTER_TOLERANCE_DAYS;
    });
    if (!best || cluster.length > best.cluster.length) {
      best = { centerDate: dated[i].date, cluster };
    }
  }
  // Single-source acceptance ONLY if the extraction has both a date and a
  // quote with "final performance" language — bounds the
  // "one hallucinated article wrong-corrects the show" failure mode.
  if (best.cluster.length === 1) {
    const q = (best.cluster[0].quote || '').toLowerCase();
    if (!/final performance|closing on|last performance/.test(q)) return null;
  }
  return best;
}

/**
 * @returns null OR { date: 'YYYY-MM-DD', sources: [{url, title, quote}], extractions: [...] }
 */
async function discoverAnnouncedClosingDate(showTitle, opts = {}) {
  const log = opts.log || (() => {});
  const query = `"${showTitle}" broadway closing OR extends final performance`;
  log(`  [discovery] SERP: ${query}`);

  // Last 30 days — closing announcements stay relevant only briefly. Older
  // results are mostly historical pieces.
  const dateMax = new Date();
  const dateMin = new Date(dateMax.getTime() - 30 * 86400000);
  let results;
  try {
    results = await serpQuery(query, { nbResults: 12, dateRange: { dateMin, dateMax } });
  } catch (e) {
    log(`  [discovery] SERP error: ${e.message}`);
    return null;
  }
  if (!results || results.length === 0) return null;

  const candidates = results
    .filter(r => isCredibleUrl(r.url))
    .slice(0, MAX_CANDIDATES_PER_SHOW);
  if (candidates.length === 0) {
    log('  [discovery] no credible-host results');
    return null;
  }

  const extractions = [];
  for (const c of candidates) {
    try {
      const page = await fetchPage(c.url, { source: 'audit-closing-dates' });
      if (!page || !page.content) continue;
      const text = stripHtml(page.content).slice(0, 4000);
      // Reject if the body doesn't even mention the show name
      if (!text.toLowerCase().includes(showTitle.toLowerCase().split(/[^a-z0-9]/i)[0])) continue;
      const raw = await callClaudeSonnet(buildExtractionPrompt(showTitle, text, c.url));
      const parsed = parseExtraction(raw);
      if (parsed) {
        extractions.push({ ...parsed, sourceUrl: c.url, sourceTitle: c.title || null });
      }
    } catch (e) {
      log(`  [discovery] candidate ${c.url} failed: ${e.message.slice(0, 80)}`);
    }
  }

  if (extractions.length === 0) {
    log('  [discovery] no extractions');
    return null;
  }

  const cluster = clusterDates(extractions);
  if (!cluster) {
    log('  [discovery] extractions present but no high-confidence cluster');
    return null;
  }
  return {
    date: cluster.centerDate,
    sources: cluster.cluster.map(c => ({ url: c.sourceUrl, title: c.sourceTitle, quote: c.quote })),
    extractions,
  };
}

module.exports = {
  discoverAnnouncedClosingDate,
  // exported for tests
  parseExtraction,
  clusterDates,
  isCredibleUrl,
  CREDIBLE_HOSTS,
};
