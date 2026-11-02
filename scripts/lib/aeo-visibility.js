/**
 * AEO visibility tracker core (BRO-6841). Pure helpers + engine adapters.
 * Method (Graphite AEO playbook): long-tail prompts, several runs per prompt,
 * web search ON, record mention / position / cited URLs / how we're described.
 */

const PROMPTS = [
  // Generic discovery
  'Where can I find aggregated Broadway critic scores for current shows?',
  'What is the best Broadway review aggregator?',
  'Which Broadway shows have the best critic reviews right now?',
  'What are the highest rated Broadway musicals this season?',
  'Which new Broadway plays are worth seeing according to critics?',
  'Best Broadway shows for kids and families right now?',
  'Is there a site that combines Broadway critic reviews into one score?',
  // Show-specific decision prompts (our traffic lands on /show/* pages)
  'Is Hamilton on Broadway still worth seeing? What do critics say?',
  'Is Wicked on Broadway worth the ticket price? What did critics think?',
  'What did critics say about The Lion King on Broadway?',
  'Is Hadestown worth seeing on Broadway? Critic consensus?',
  'Are the new Broadway musicals this fall any good? Review roundup please.',
  'How did critics review the latest Broadway revival?',
  'Which Broadway show should I see on a first trip to New York? Go by critic reviews.',
  // Comparison and intent
  'Broadway Scorecard vs Show Score vs Did They Like It: which is best for Broadway reviews?',
  'Which Broadway shows are critics and audiences disagreeing about?',
  'Best Broadway musicals for people who do not like musicals?',
  'Which Broadway shows are worth full price versus lottery or rush tickets?',
  'Are Broadway reviews from the New York Times and Vulture usually aligned?',
  'What Broadway shows are closing soon that critics loved?',
];

const BRAND = {
  name: 'Broadway Scorecard',
  patterns: [/broadway\s*score\s*card/i, /broadwayscorecard/i],
  domain: 'broadwayscorecard.com',
};

const COMPETITORS = {
  'Show Score': [/\bshow[\s-]?score\b/i],
  'Did They Like It': [/did\s*they\s*like\s*it/i, /didtheylikeit/i],
  BroadwayWorld: [/broadway\s?world/i],
  Playbill: [/playbill/i],
  TheaterMania: [/theater\s?mania/i],
  'New York Times': [/new york times/i, /nytimes/i],
  Variety: [/\bVariety\b/],
  Vulture: [/vulture/i],
  'Rotten Tomatoes': [/rotten tomatoes/i],
  TodayTix: [/today\s?tix/i],
  'Broadway.com': [/broadway\.com/i],
  'Time Out': [/\bTime Out\b/],
};

function firstIndex(text, patterns) {
  let best = -1;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

/** One answer -> mention, rank among named brands, our cited URLs, description. */
// Inline citation links like ([broadwayscorecard.com](https://...)) are not prose mentions.
function stripLinks(t) {
  return t.replace(/\[([^\]]*)\]\((?:https?:\/\/)[^)]*\)/g, '').replace(/https?:\/\/\S+/g, '');
}

function analyzeAnswer(rawText, citations) {
  const text = stripLinks(rawText || '');
  citations = citations || [];
  const ourIdx = firstIndex(text, BRAND.patterns);
  const mentionedInText = ourIdx !== -1;
  const ourCited = citations.filter(c => {
    const h = hostOf(c.url);
    return h && (h === BRAND.domain || h.endsWith('.' + BRAND.domain));
  });
  const cited = ourCited.length > 0;
  const brands = [];
  if (mentionedInText) brands.push({ name: BRAND.name, idx: ourIdx });
  for (const [name, pats] of Object.entries(COMPETITORS)) {
    const i = firstIndex(text, pats);
    if (i !== -1) brands.push({ name, idx: i });
  }
  brands.sort((a, b) => a.idx - b.idx);
  const position = mentionedInText ? brands.findIndex(b => b.name === BRAND.name) + 1 : null;
  let description = null;
  if (mentionedInText) {
    const start = Math.max(0, text.lastIndexOf('\n', ourIdx) + 1);
    const endNl = text.indexOf('\n', ourIdx);
    const end = endNl === -1 ? text.length : endNl;
    const line = text.slice(start, end).replace(/\s+/g, ' ').trim();
    const at = Math.max(0, line.search(BRAND.patterns[0]) >= 0 ? line.search(BRAND.patterns[0]) : line.search(BRAND.patterns[1]));
    description = line.slice(Math.max(0, at - 80), at + 220);
  }
  const citedDomains = {};
  for (const c of citations) {
    const h = hostOf(c.url) || c.domain;
    if (h) citedDomains[h] = (citedDomains[h] || 0) + 1;
  }
  return {
    mentioned: mentionedInText || cited,
    mentionedInText,
    cited,
    position,
    ourUrls: [...new Set(ourCited.map(c => c.url.replace(/[?&]utm_source=[^&]+/, m => m[0] === '?' ? '?' : '').replace(/\?&/, '?').replace(/\?$/, '')))],
    description,
    competitors: brands.filter(b => b.name !== BRAND.name).map(b => b.name),
    citedDomains,
  };
}

// ---- Cost (USD). Rates as of 2026-11; update here if pricing moves. ----
const RATES = {
  openai: { inPerM: 0.25, outPerM: 2.0, perSearch: 0.01 },   // gpt-5-mini + web_search tool ($10/1k calls)
  gemini: { inPerM: 0.30, outPerM: 2.5, perPrompt: 0.035 },  // gemini-2.5-flash + grounding ($35/1k grounded prompts)
};

function costOf(engine, usage) {
  const r = RATES[engine];
  const tokens = (usage.input * r.inPerM + usage.output * r.outPerM) / 1e6;
  if (engine === 'openai') return tokens + (usage.searches || 0) * r.perSearch;
  return tokens + (usage.searches > 0 ? r.perPrompt : 0);
}

// ---- Engines: each returns { text, citations:[{url,title,domain}], usage:{input,output,searches} } ----
async function runOpenAI(prompt, { fetchImpl = fetch, apiKey = process.env.OPENAI_API_KEY, model = 'gpt-5-mini' } = {}) {
  const res = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      tools: [{ type: 'web_search' }],
      reasoning: { effort: 'low' },
      include: ['web_search_call.action.sources'],
      input: `${prompt}\n\nSearch the web and cite your sources with links.`,
      max_output_tokens: 4000,
    }),
  });
  const d = await res.json();
  if (!res.ok || d.error) throw new Error(`openai ${res.status}: ${(d.error && d.error.message) || 'error'}`);
  if (d.status && d.status !== 'completed') throw new Error(`openai answer ${d.status} (${(d.incomplete_details || {}).reason || 'unknown'})`);
  let text = '';
  const citations = [];
  let searches = 0;
  for (const o of d.output || []) {
    if (o.type === 'web_search_call') {
      searches++;
      for (const s of (o.action && o.action.sources) || []) if (s.url) citations.push({ url: s.url, title: s.title || '', domain: hostOf(s.url) });
    } else if (o.type === 'message') {
      for (const c of o.content || []) {
        if (c.type === 'output_text') {
          text += c.text;
          for (const a of c.annotations || []) if (a.type === 'url_citation') citations.push({ url: a.url, title: a.title || '', domain: hostOf(a.url) });
        }
      }
    }
  }
  const seen = new Set();
  const uniq = citations.filter(c => (seen.has(c.url) ? false : seen.add(c.url)));
  const u = d.usage || {};
  return { text, citations: uniq, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, searches } };
}

const DOMAIN_RE = /^[\w.-]+\.[a-z]{2,}$/i;

async function runGemini(prompt, { fetchImpl = fetch, apiKey = process.env.GEMINI_API_KEY, model = 'gemini-2.5-flash' } = {}) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${prompt}\n\nSearch the web and cite your sources.` }] }],
      tools: [{ google_search: {} }],
    }),
  });
  const d = await res.json();
  if (!res.ok || d.error) throw new Error(`gemini ${res.status}: ${(d.error && d.error.message) || 'error'}`);
  const cand = (d.candidates || [])[0] || {};
  if (cand.finishReason && cand.finishReason !== 'STOP') throw new Error(`gemini finishReason ${cand.finishReason}`);
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  const gm = cand.groundingMetadata || {};
  // Gemini returns vertex redirect URIs; the chunk title carries the source domain, so use that.
  const citations = (gm.groundingChunks || []).filter(c => c.web).map(c => {
    const title = c.web.title || '';
    if (DOMAIN_RE.test(title)) {
      const domain = title.toLowerCase().replace(/^www\./, '');
      return { url: `https://${domain}/`, title, domain };
    }
    return { url: c.web.uri, title, domain: hostOf(c.web.uri) };
  });
  const u = d.usageMetadata || {};
  return {
    text,
    citations,
    usage: {
      input: (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0),
      output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      searches: (gm.webSearchQueries || []).length,
    },
  };
}

const ENGINES = {
  openai: { label: 'ChatGPT (gpt-5-mini + web_search)', key: 'OPENAI_API_KEY', run: runOpenAI },
  gemini: { label: 'Gemini (2.5-flash + Google Search)', key: 'GEMINI_API_KEY', run: runGemini },
};

/** Roll runs up per engine and overall. */
function summarize(runs) {
  const by = {};
  const add = (k, r) => {
    const s = (by[k] = by[k] || { runs: 0, mentioned: 0, cited: 0, positions: [], competitors: {}, ourUrls: {}, domains: {}, cost: 0 });
    s.runs++;
    if (r.mentioned) s.mentioned++;
    if (r.cited) s.cited++;
    if (r.position) s.positions.push(r.position);
    for (const c of r.competitors) s.competitors[c] = (s.competitors[c] || 0) + 1;
    for (const u of r.ourUrls) s.ourUrls[u] = (s.ourUrls[u] || 0) + 1;
    for (const [d, n] of Object.entries(r.citedDomains)) s.domains[d] = (s.domains[d] || 0) + n;
    s.cost += r.cost || 0;
  };
  for (const r of runs.filter(x => !x.error)) { add(r.engine, r); add('all', r); }
  for (const s of Object.values(by)) {
    s.mentionRate = s.runs ? +(s.mentioned / s.runs).toFixed(3) : 0;
    s.citeRate = s.runs ? +(s.cited / s.runs).toFixed(3) : 0;
    s.avgPosition = s.positions.length ? +(s.positions.reduce((a, b) => a + b, 0) / s.positions.length).toFixed(2) : null;
    s.cost = +s.cost.toFixed(4);
    delete s.positions;
  }
  return by;
}

module.exports = { PROMPTS, BRAND, COMPETITORS, RATES, ENGINES, analyzeAnswer, costOf, summarize, runOpenAI, runGemini, hostOf };
