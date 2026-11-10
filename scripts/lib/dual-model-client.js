'use strict';
/**
 * Thin Gemini + OpenAI clients for audit scripts (BRO-7256). Both return text; both count spend
 * in `spend` and refuse once `maxUsd` is reached. Keys come from GEMINI_API_KEY / OPENAI_API_KEY.
 * Require ./llm-usage-install BEFORE this file so the repo's spend meter sees the calls.
 */

const GEMINI_MODEL = process.env.AUDIT_GEMINI_MODEL || 'gemini-2.5-flash';
const OPENAI_MODEL = process.env.AUDIT_OPENAI_MODEL || 'gpt-5-mini';
const PRICE = {
  gemini: { in: 0.30e-6, out: 2.5e-6, grounded: 0.035 },
  openai: { in: 0.25e-6, out: 2e-6, search: 0.01 },
};
const spend = { usd: 0, gemini: 0, openai: 0, calls: 0, maxUsd: Infinity };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, opts = {}, ms = 120000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
function guard() { if (spend.usd >= spend.maxUsd) throw new Error(`audit spend cap reached ($${spend.usd.toFixed(2)})`); }

/** opts: { grounded, image: {mime, b64} } */
async function askGemini(prompt, opts = {}) {
  guard();
  const parts = [{ text: prompt }];
  if (opts.image) parts.push({ inlineData: { mimeType: opts.image.mime, data: opts.image.b64 } });
  const body = { contents: [{ parts }], generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: opts.grounded ? 2048 : 512 }, maxOutputTokens: 8192 } };
  if (opts.grounded) body.tools = [{ google_search: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let a = 0; a < 4; a++) {
    const res = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await sleep(4000 * (a + 1)); continue; }
    if (j.error) throw new Error(`gemini: ${j.error.message}`);
    const u = j.usageMetadata || {};
    const cost = ((u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0)) * PRICE.gemini.in
      + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE.gemini.out + (opts.grounded ? PRICE.gemini.grounded : 0);
    spend.usd += cost; spend.gemini += cost; spend.calls++;
    const c = (j.candidates || [])[0] || {};
    return ((c.content || {}).parts || []).map((p) => p.text || '').join('');
  }
  throw new Error('gemini: retries exhausted');
}

/** opts: { search: true, image: {mime, b64} } */
async function askOpenAI(prompt, opts = {}) {
  guard();
  const content = [{ type: 'input_text', text: prompt }];
  if (opts.image) content.push({ type: 'input_image', image_url: `data:${opts.image.mime};base64,${opts.image.b64}` });
  const body = { model: OPENAI_MODEL, input: [{ role: 'user', content }], reasoning: { effort: 'low' } };
  if (opts.search) body.tools = [{ type: 'web_search' }];
  for (let a = 0; a < 4; a++) {
    const res = await fetchT('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await sleep(4000 * (a + 1)); continue; }
    if (j.error) throw new Error(`openai: ${j.error.message}`);
    const u = j.usage || {};
    const searches = (j.output || []).filter((o) => o.type === 'web_search_call').length;
    const cost = (u.input_tokens || 0) * PRICE.openai.in + (u.output_tokens || 0) * PRICE.openai.out + searches * PRICE.openai.search;
    spend.usd += cost; spend.openai += cost; spend.calls++;
    return (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  }
  throw new Error('openai: retries exhausted');
}

/** Run fn over items with a fixed worker count; errors become {error} results, never throw. */
async function pool(items, workers, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e.message || e) }; }
    }
  }));
  return out;
}

module.exports = { askGemini, askOpenAI, pool, spend, GEMINI_MODEL, OPENAI_MODEL };
