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

function parseExtraction(raw, opts = {}) {
  if (!raw) return null;
  // Trim code fences if model added them
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const j = JSON.parse(cleaned);
    if (!j || typeof j !== 'object') return null;
    if (j.date && !/^\d{4}-\d{2}-\d{2}$/.test(j.date)) return null;
    if (!['high', 'medium', 'low'].includes(j.confidence)) return null;
    // Year-sanity: reject extractions outside [TODAY - 6 months, TODAY + 3 years].
    // A 1998 revival article that says "closing 1998-10-04" would otherwise pass
    // the regex check and could cluster with another wrong-production article.
    // The actual future-close window for an open Broadway show is at most ~3 years
    // (Operation Mincemeat's 9 extensions stretched to ~2 years out).
    if (j.date) {
      const dt = new Date(j.date);
      const now = opts.now || new Date();
      const minDate = new Date(now.getTime() - 180 * 86400000);
      const maxDate = new Date(now.getTime() + 1095 * 86400000);
      if (dt < minDate || dt > maxDate) return null;
    }
    return { date: j.date || null, confidence: j.confidence, quote: j.quote || null };
  } catch {
    return null;
  }
}

// Stronger show-name guard against same-title revivals: the article body must
// mention at least one ≥4-char word from the show title. Mirrors
// pageMatchesShow() in scripts/audit-closing-dates.js. Without this, a 1998
// "Cabaret" revival article could be matched to the 2024 production.
function pageMatchesShowTitle(text, showTitle) {
  if (!text || !showTitle) return false;
  const haystack = text.toLowerCase();
  const words = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (words.length === 0) {
    // Single-syllable / very short title (e.g., "Job"): fall back to any
    // alphanumeric token match — but require it to be present as a whole word,
    // not a substring (so "Job" doesn't match "Jobs" or "jobbers").
    const tokens = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.some(t => new RegExp(`\\b${t}\\b`).test(haystack));
  }
  return words.some(w => haystack.includes(w));
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
// within ±CLUSTER_TOLERANCE_DAYS, plus the contributing sources. Tie-broken
// by distinct-host count (more independent publishers > more agreeing
// articles from one publisher) — without this, two stale republications
// of one wire story would beat a single fresh primary report.
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function clusterDates(extractions) {
  if (extractions.length === 0) return null;
  const dated = extractions.filter(e => e.date && e.confidence === 'high');
  if (dated.length === 0) return null;

  let best = null;
  let bestDistinctHosts = 0;
  for (let i = 0; i < dated.length; i++) {
    const center = new Date(dated[i].date);
    const cluster = dated.filter(e => {
      const d = new Date(e.date);
      return Math.abs((d - center) / 86400000) <= CLUSTER_TOLERANCE_DAYS;
    });
    const distinctHosts = new Set(cluster.map(c => hostOf(c.sourceUrl))).size;
    // Prefer the cluster with more members; tie-break by more distinct hosts.
    if (!best
      || cluster.length > best.cluster.length
      || (cluster.length === best.cluster.length && distinctHosts > bestDistinctHosts)
    ) {
      best = { centerDate: dated[i].date, cluster };
      bestDistinctHosts = distinctHosts;
    }
  }
  // Single-source acceptance ONLY if the extraction has both a date and a
  // quote with "final performance" / closure-verb language. Bounds the
  // "one hallucinated article wrong-corrects the show" failure mode. The
  // regex is broader than the original to catch real announcement language
  // ("ends its run", "shutters", "last show", "wraps") without admitting
  // generic phrasing.
  if (best.cluster.length === 1) {
    const q = (best.cluster[0].quote || '').toLowerCase();
    if (!/final performance|closing on|last performance|ends? its run on|ends? on|wraps? (?:its run )?on|shutters? on|will close on|to close on|last show on/.test(q)) return null;
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
      // Use a wider window for the show-name guard than the LLM prompt — the
      // show name often appears in the article body but past the first 4000
      // chars on press sites with heavy nav/promo headers.
      const fullText = stripHtml(page.content);
      if (!pageMatchesShowTitle(fullText.slice(0, 12000), showTitle)) continue;
      const text = fullText.slice(0, 4000);
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
  pageMatchesShowTitle,
  CREDIBLE_HOSTS,
};
