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
const { CLAUDE_SONNET } = require('./models');

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
      model: CLAUDE_SONNET,
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

// Per-field configuration. fieldType determines: the SERP query phrasing,
// the LLM prompt's date semantics, the year-sanity window, and the closure-
// verb regex for single-source acceptance. Closing is the original behavior
// preserved verbatim — it stays the default for discoverAnnouncedClosingDate
// callers. Opening and previews-start were added 2026-05-24 as part of the
// same triple-signal pattern.
const FIELD_CONFIGS = {
  closing: {
    serpQuery: title => `"${title}" broadway closing OR extends final performance`,
    promptDateRole: 'FINAL Broadway performance',
    promptHighConfidenceCriteria: 'the article explicitly states a closing OR final-performance date for the named show on Broadway',
    promptExclusions: 'Not opening, not previews, not a future tour stop, not a past extension if a newer date has been announced.',
    // Closing dates can be far-future (Op Mincemeat extended to 2027). Allow
    // up to 3 years out; allow 180 days into the past in case a show closed
    // very recently and a press article is from after the fact.
    sanityWindowDaysPast: 180,
    sanityWindowDaysFuture: 1095,
    // Phrases acceptable for single-source acceptance.
    quoteAcceptanceRegex: /final performance|closing on|last performance|ends? its run on|ends? on|wraps? (?:its run )?on|shutters? on|will close on|to close on|last show on/,
  },
  opening: {
    serpQuery: title => `"${title}" broadway opening night OR delayed OR pushed OR postponed`,
    promptDateRole: 'OFFICIAL OPENING NIGHT (not the first preview)',
    promptHighConfidenceCriteria: 'the article explicitly states an opening-night date for the named show on Broadway. Opening night follows previews and is typically a single performance with critics invited',
    promptExclusions: 'Not the first preview, not the closing, not a tour opening, not a West End opening. If the article only mentions previews-start, return null.',
    // Opening dates are near-future (within ~1 year). A 4-year-future
    // "opening" almost certainly means a different production.
    sanityWindowDaysPast: 30,
    sanityWindowDaysFuture: 365,
    // Common press phrasings: opening night, officially opens, opens on,
    // set to open, premieres on, will premiere, bows on (Playbill standard),
    // to/will open on.
    quoteAcceptanceRegex: /opening night|officially opens?|opens? on|opening on|(?:is )?set to open|to open on|will open on|premieres? on|will premiere|bows? on/,
  },
  'previews-start': {
    serpQuery: title => `"${title}" broadway previews begin OR start OR first preview`,
    promptDateRole: 'FIRST PREVIEW PERFORMANCE (the first paid performance, before official opening)',
    promptHighConfidenceCriteria: 'the article explicitly states a previews-start date or first-preview date for the named show on Broadway',
    promptExclusions: 'Not opening night, not closing. If the article only mentions opening night, return null.',
    sanityWindowDaysPast: 30,
    sanityWindowDaysFuture: 365,
    // Anchored to verbs — bare "previews on" was matching "no previews on
    // Mondays". Includes Playbill/Variety "begin performances" and
    // "first performance" phrasings.
    quoteAcceptanceRegex: /first preview|previews begin|begin previews|previews start|starts previews|begins? performances|starts? performances|first performance|opens? for previews|first paid performance/,
  },
};

function getFieldConfig(fieldType) {
  const cfg = FIELD_CONFIGS[fieldType];
  if (!cfg) throw new Error(`closing-date-discovery: unknown fieldType "${fieldType}". Expected: ${Object.keys(FIELD_CONFIGS).join(', ')}`);
  return cfg;
}

function buildExtractionPrompt(showTitle, text, url, fieldType = 'closing') {
  const cfg = getFieldConfig(fieldType);
  return `You are extracting the announced ${cfg.promptDateRole} date for a Broadway show from a press article.

Show: ${showTitle}
Article URL: ${url}
Article text (truncated):
"""
${text}
"""

Return ONLY JSON in this exact form (no markdown, no commentary):
{"date": "YYYY-MM-DD" | null, "confidence": "high" | "medium" | "low", "quote": "the exact sentence stating the date" | null}

Rules:
- date = the ${cfg.promptDateRole} announced in this article. ${cfg.promptExclusions}
- confidence "high" ONLY if ${cfg.promptHighConfidenceCriteria}.
- If the article is about a tour, regional production, off-Broadway run, or West End run, return {"date": null, "confidence": "low", "quote": null}.
- If the date is ambiguous, a range, conditional, or not present, return {"date": null, "confidence": "low", "quote": null}.`;
}

function parseExtraction(raw, opts = {}) {
  if (!raw) return null;
  const fieldType = opts.fieldType || 'closing';
  const cfg = getFieldConfig(fieldType);
  // Trim code fences if model added them
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const j = JSON.parse(cleaned);
    if (!j || typeof j !== 'object') return null;
    if (j.date && !/^\d{4}-\d{2}-\d{2}$/.test(j.date)) return null;
    if (!['high', 'medium', 'low'].includes(j.confidence)) return null;
    // Year-sanity: reject extractions outside the field's plausible window.
    // Closing dates have a wide future window (Op Mincemeat 2027); opening
    // and previews-start are much narrower (within ~1 year). This is the
    // primary defense against same-title revival hallucinations.
    if (j.date) {
      const dt = new Date(j.date);
      const now = opts.now || new Date();
      const minDate = new Date(now.getTime() - cfg.sanityWindowDaysPast * 86400000);
      const maxDate = new Date(now.getTime() + cfg.sanityWindowDaysFuture * 86400000);
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

function clusterDates(extractions, opts = {}) {
  if (extractions.length === 0) return null;
  const dated = extractions.filter(e => e.date && e.confidence === 'high');
  if (dated.length === 0) return null;
  const cfg = getFieldConfig(opts.fieldType || 'closing');

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
  // quote with field-appropriate announcement-verb language. Bounds the
  // "one hallucinated article wrong-corrects the show" failure mode.
  if (best.cluster.length === 1) {
    const q = (best.cluster[0].quote || '').toLowerCase();
    if (!cfg.quoteAcceptanceRegex.test(q)) return null;
  }
  return best;
}

/**
 * Generic field discovery. fieldType in {'closing','opening','previews-start'}.
 * @returns null OR { date: 'YYYY-MM-DD', sources: [{url, title, quote}], extractions: [...], fieldType }
 */
async function discoverAnnouncedDate(showTitle, fieldType, opts = {}) {
  // Fail fast on missing/unknown fieldType — silently defaulting to 'closing'
  // would run a closing-date SERP/prompt on an opening-date call site and
  // return plausibly-wrong data. Caller MUST pass an explicit fieldType.
  const log = (opts && opts.log) || (() => {});
  const cfg = getFieldConfig(fieldType);
  const query = cfg.serpQuery(showTitle);
  log(`  [discovery:${fieldType}] SERP: ${query}`);

  // Last 30 days — announcements stay relevant only briefly. Older results
  // are mostly historical pieces.
  const dateMax = new Date();
  const dateMin = new Date(dateMax.getTime() - 30 * 86400000);
  let results;
  try {
    results = await serpQuery(query, { nbResults: 12, dateRange: { dateMin, dateMax } });
  } catch (e) {
    log(`  [discovery:${fieldType}] SERP error: ${e.message}`);
    return null;
  }
  if (!results || results.length === 0) return null;

  const candidates = results
    .filter(r => isCredibleUrl(r.url))
    .slice(0, MAX_CANDIDATES_PER_SHOW);
  if (candidates.length === 0) {
    log(`  [discovery:${fieldType}] no credible-host results`);
    return null;
  }

  const extractions = [];
  for (const c of candidates) {
    try {
      const page = await fetchPage(c.url, { source: `audit-${fieldType}-dates` });
      if (!page || !page.content) continue;
      const fullText = stripHtml(page.content);
      if (!pageMatchesShowTitle(fullText.slice(0, 12000), showTitle)) continue;
      const text = fullText.slice(0, 4000);
      const raw = await callClaudeSonnet(buildExtractionPrompt(showTitle, text, c.url, fieldType));
      const parsed = parseExtraction(raw, { fieldType });
      if (parsed) {
        extractions.push({ ...parsed, sourceUrl: c.url, sourceTitle: c.title || null });
      }
    } catch (e) {
      log(`  [discovery:${fieldType}] candidate ${c.url} failed: ${e.message.slice(0, 80)}`);
    }
  }

  if (extractions.length === 0) {
    log(`  [discovery:${fieldType}] no extractions`);
    return null;
  }

  const cluster = clusterDates(extractions, { fieldType });
  if (!cluster) {
    log(`  [discovery:${fieldType}] extractions present but no high-confidence cluster`);
    return null;
  }
  return {
    date: cluster.centerDate,
    sources: cluster.cluster.map(c => ({ url: c.sourceUrl, title: c.sourceTitle, quote: c.quote })),
    extractions,
    fieldType,
  };
}

// Backwards-compat wrapper preserves the original API used by
// audit-closing-dates.js. New callers should use discoverAnnouncedDate().
async function discoverAnnouncedClosingDate(showTitle, opts = {}) {
  return discoverAnnouncedDate(showTitle, 'closing', opts);
}

module.exports = {
  discoverAnnouncedDate,
  discoverAnnouncedClosingDate,
  // exported for tests
  parseExtraction,
  clusterDates,
  isCredibleUrl,
  pageMatchesShowTitle,
  getFieldConfig,
  CREDIBLE_HOSTS,
  FIELD_CONFIGS,
};
