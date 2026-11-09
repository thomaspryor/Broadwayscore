'use strict';

/**
 * Reads a producing theatre's season page into productions (BRO-7250). The page text goes to Gemini with today's date;
 * scripts/lib/city-season.js fromPageRows() then drops everything the page text does not support.
 */
require('./gemini-usage-ledger').install(); // BRO-5043: record-only Gemini usage ledger

const MODEL = 'gemini-2.5-flash';

const decode = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&[lr]squo;/g, "'");

/** { text, links }: visible page text with each anchor kept as "label (absolute url)", and the page's absolute link set. */
function pageToText(html, baseUrl) {
  const links = new Set();
  const abs = (h) => { try { return new URL(decode(h), baseUrl).href; } catch { return null; } };
  const body = String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ' ');
  const withLinks = body.replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, label) => {
    const u = abs(h);
    if (u) links.add(u);
    const t = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return u && t ? ` ${t} (${u}) ` : ` ${t} `;
  });
  const text = decode(withLinks.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return { text, links: [...links] };
}

function buildPrompt({ theatre, city, today, horizon, text }) {
  return `Today is ${today}. Below is text from the website of ${theatre} (${city}). List the live stage productions this theatre itself is producing or presenting that are running now or open on or before ${horizon}.
Rules:
- Only productions the page names with dates. Take the dates from the page; infer the year from today's date (a run is never longer than about 4 months). If the page gives no start or no end date, use null.
- Exclude: touring shows, concerts, readings, galas, fundraisers, classes, camps, youth or student shows, rentals, subscriptions, and productions that already closed before ${today}.
- "url" is the link the page gives for that production, copied exactly, or null.
Return JSON: {"productions":[{"title":string,"start":"YYYY-MM-DD"|null,"end":"YYYY-MM-DD"|null,"type":"play"|"musical","url":string|null}]}

PAGE TEXT:
${text.slice(0, 24000)}`;
}

async function readSeasonPage(args, { fetchImpl = fetch } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(args) }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
  const s = String(t || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const parsed = JSON.parse(s);
  return Array.isArray(parsed.productions) ? parsed.productions : [];
}

module.exports = { pageToText, buildPrompt, readSeasonPage };
