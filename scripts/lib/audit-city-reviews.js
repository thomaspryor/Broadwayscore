#!/usr/bin/env node
/**
 * audit-city-reviews.js — LLM accuracy audit for city-hub reviews (BRO-6854).
 *
 * For every review of the given shows: fetch the article (fetchPage, disk-cached), ask Gemini whether the
 * article reviews THIS production at THIS theatre, and what the byline critic, publish date and outlet are,
 * then diff against what reviews.json says. Chicago lessons baked into the prompt: the article byline wins over
 * Theatre-In-X-style critic names; do not anchor on our own dates; two reviews in one article is not a roundup.
 *
 *   node scripts/lib/audit-city-reviews.js --ids=a,b,c --reviews=<path to reviews.json> --shows=<path to shows.json>
 *        [--cache=dir] [--out=data/audit/city-review-audit.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const ROOT = path.join(__dirname, '..', '..');

function articleText(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
const metaOf = (html, re) => { const m = String(html).match(re); return m ? m[1] : ''; };

// rev is deliberately unused: the model extracts byline/date/outlet blind, and we compare in code (no anchoring on our record).
function buildPrompt(show, rev, text, meta) {
  return `You audit a theatre-review database. Answer ONLY with JSON.
Production we believe the article reviews: "${show.title}" at ${show.venue}, opened ${show.openingDate}.
Rules: judge the production from the article text itself, not from our dates (a remount or a later run can legitimately be reviewed outside our window).
The critic is the byline author in the article, not a site name. An article that reviews two productions can still be a valid review of this one if it has a real critique of it.
Page meta: ${meta}
Article text (truncated):
${text.slice(0, 6000)}
JSON keys: rightProduction (true/false/"unclear"), productionSeen (title and theatre the article is actually about), critic (byline author or null), publishDate (YYYY-MM-DD from the page or null), outlet (publication name), isReview (true/false: a critique, not a preview, interview or listing), note (one short sentence).`;
}

async function gemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
  }); // timeout-audit-ok: one-shot audit CLI
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
  return parseJson(t);
}

/** Tolerates code fences and surrounding prose; throws on anything that is not one JSON object. */
function parseJson(t) {
  const s = String(t || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object in model reply');
  const v = JSON.parse(s.slice(a, b + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('model reply is not an object');
  return v;
}

const ISO = /^\d{4}-\d{2}-\d{2}/;
const nameTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
/** Same critic when the last names match and, if both sides give a first name, the first initials match. */
function sameCritic(a, b) {
  const x = nameTokens(a); const y = nameTokens(b);
  if (!x.length || !y.length) return true;
  if (x[x.length - 1] !== y[y.length - 1]) return false;
  return x.length < 2 || y.length < 2 || x[0][0] === y[0][0];
}

async function main() {
  const { fetchPage } = require('./scraper');
  const ids = arg('ids', '').split(',').filter(Boolean);
  const cache = arg('cache', path.join(os.tmpdir(), 'city-review-audit-cache'));
  fs.mkdirSync(cache, { recursive: true });
  if (!arg('shows') || !arg('reviews')) throw new Error('--shows=<shows.json> and --reviews=<reviews.json> are required');
  const shows = JSON.parse(fs.readFileSync(arg('shows'), 'utf8')); const sh = Array.isArray(shows) ? shows : shows.shows;
  const rv = JSON.parse(fs.readFileSync(arg('reviews'), 'utf8')); const R = Array.isArray(rv) ? rv : (rv.reviews || Object.values(rv));
  const flags = []; let n = 0;
  for (const id of ids) {
    const show = sh.find((s) => s.id === id); if (!show) continue;
    for (const rev of R.filter((r) => r.showId === id && r.url)) {
      n++;
      const f = path.join(cache, crypto.createHash('sha1').update(rev.url).digest('hex') + '.json');
      let page = null;
      try { page = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fetch */ }
      if (!page) { try { const p = await fetchPage(rev.url, { skipVerify: true }); page = p && p.content ? { content: p.content, finalUrl: p.finalUrl || p.url || null } : null; if (page) fs.writeFileSync(f, JSON.stringify(page)); } catch { page = null; } }
      if (!page) { flags.push({ id, url: rev.url, problem: 'unfetchable' }); continue; }
      const meta = [metaOf(page.content, /<title[^>]*>([^<]+)/i), metaOf(page.content, /property="article:published_time"\s+content="([^"]+)/i), metaOf(page.content, /name="author"\s+content="([^"]+)/i)].filter(Boolean).join(' | ');
      let v; try { v = await gemini(buildPrompt(show, rev, articleText(page.content), meta)); } catch (e) { flags.push({ id, url: rev.url, problem: 'llm-error ' + e.message }); continue; }
      const problems = [];
      const body = articleText(page.content);
      const redirected = page.finalUrl && String(page.finalUrl).replace(/[?#].*$/, '').replace(/\/+$/, '') !== String(rev.url).replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (redirected) problems.push(`redirected to ${page.finalUrl}`);
      if (body.length > 6000) v.truncatedAt = 6000;
      if (v.rightProduction === false) problems.push(`wrong production (${v.productionSeen})`);
      if (v.rightProduction === 'unclear') problems.push('production unclear');
      if (v.isReview === false) problems.push('not a review');
      if (v.critic && rev.criticName && !sameCritic(v.critic, rev.criticName)) problems.push(`critic ${rev.criticName} vs byline ${v.critic}`);
      if (v.publishDate && !ISO.test(String(v.publishDate))) problems.push(`unparseable page date ${v.publishDate}`);
      else if (v.publishDate && rev.publishDate && String(v.publishDate).slice(0, 10) !== String(rev.publishDate).slice(0, 10)) problems.push(`date ${rev.publishDate} vs page ${v.publishDate}`);
      if (problems.length) flags.push({ id, url: rev.url, outlet: rev.outlet, ourCritic: rev.criticName, ourDate: rev.publishDate, verdict: v, problems });
    }
  }
  const out = arg('out', path.join(ROOT, 'data', 'audit', 'city-review-audit.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ audited: n, flagged: flags.length, flags }, null, 1));
  try { require('./scraper').cleanup(); } catch { /* none */ }
  console.log(`audited ${n} reviews, flagged ${flags.length} -> ${out}`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { articleText, buildPrompt, parseJson, sameCritic };
