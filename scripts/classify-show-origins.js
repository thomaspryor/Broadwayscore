#!/usr/bin/env node
'use strict';
/**
 * Classify how each Broadway production reached Broadway and what it is
 * based on (BRO-5842). One web-searching model call per small batch of
 * shows; every label must carry a source URL. Writes data/show-origins.json
 * after each batch, so a rerun resumes where it stopped.
 *
 * Usage:
 *   node scripts/classify-show-origins.js [--ids=a,b] [--limit=N] [--batch=5]
 *     [--concurrency=4] [--max-usd=25] [--effort=low|medium] [--redo] [--dry-run]
 *   node scripts/classify-show-origins.js --needs-review --batch=1 --effort=medium
 *     (re-asks shows whose pathNote names a stop the route codes left out)
 *   node scripts/classify-show-origins.js --check
 *     (second, independent answer from Gemini with Google Search; stored as "check")
 *   node scripts/classify-show-origins.js --resolve --batch=1 --effort=medium
 *     (re-researches every show where the two answers disagree or a note conflicts,
 *      showing the model both answers; its answer replaces the record)
 */

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { inScopeShows, normalizeOrigin, normalizeCheck, originsAgree, pathNoteConflicts, PATH_STAGES, SOURCE_TYPES } = require('./lib/show-origins');
const { researchCallCost, countSearchCalls } = require('./lib/research-cost');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'show-origins.json');
const MODEL = 'gpt-5.4-mini';
const CHECK_MODEL = 'gemini-2.5-flash';
// USD: per 1M tokens and per grounded request (Gemini 2.5 Flash paid tier).
const GEMINI_PRICE = { input: 0.30, output: 2.50, perGrounded: 0.035 };

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const BATCH = Number(args.batch || 5);
const CONCURRENCY = Number(args.concurrency || 4);
const MAX_USD = Number(args['max-usd'] || 25);
const EFFORT = args.effort || 'low';

function loadOut() {
  if (!fs.existsSync(OUT)) return { _meta: {}, shows: {} };
  return JSON.parse(fs.readFileSync(OUT, 'utf8'));
}

function saveOut(out) {
  const sorted = Object.fromEntries(Object.keys(out.shows).sort().map((k) => [k, out.shows[k]]));
  out.shows = sorted;
  out._meta = {
    description: 'Route to Broadway and source material per Broadway production (BRO-5842). Written by scripts/classify-show-origins.js; hand corrections set "verifiedBy".',
    pathStages: PATH_STAGES,
    sourceTypes: SOURCE_TYPES,
    count: Object.keys(sorted).length,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
}

function prompt(batch) {
  const lines = batch.map((s, i) => `${i + 1}. id="${s.id}" | "${s.title}" | ${s.type || 'unknown type'} | ${s.isRevival ? 'REVIVAL' : 'original production'} | Broadway opening ${s.openingDate} at ${s.venue}`);
  return `You are a Broadway historian. For each Broadway production below, research (search the web; IBDB, Playbill, Wikipedia, Broadway World, the New York Times) and answer two questions.

A) ROUTE: which earlier staged productions of THIS show led to this Broadway run, in the order they happened. Use these codes:
- "regional-us": a staged run at a US theater outside New York City, including commercial out-of-town tryouts (e.g. La Jolla Playhouse, Goodman, Arena Stage, a Chicago or Boston tryout).
- "off-broadway": a staged run Off-Broadway or Off-Off-Broadway in New York City (e.g. Public Theater, Second Stage's Off-Broadway house, New York Theatre Workshop, MCC, a festival run like NYMF).
- "london": a staged run in London or elsewhere in the UK (West End, National Theatre, Donmar, Almeida, Royal Court, Chichester, Edinburgh Fringe, etc.).
- "international": a staged run in any other country, including Canada (Toronto, Edmonton, Stratford Festival), Australia, Korea, Germany, Ireland, etc. A Canadian theater is never "regional-us".
List EVERY earlier stop, not only the last one: check the show's full production history (e.g. Hadestown = ["off-broadway","international","london"]: New York Theatre Workshop 2016, Citadel Theatre Edmonton 2017, National Theatre London 2018).
Return [] when the show came to Broadway directly (no earlier staged production; readings, workshops, concerts and cast albums do not count). For a REVIVAL, describe THIS revival staging's route (e.g. a West End revival that transferred = ["london"]), not the show's original history. A Broadway production that was previously on Broadway does not count as a stage.

B) SOURCE: what the show is based on. One code:
- "film": a movie. "tv": a TV series. "book": a novel, memoir, nonfiction book, biography or children's book.
- "play": adapted from a DIFFERENT stage play (a musical made from a play, a new version of an older play by another writer). A play that is itself the work being staged is NOT "play": a revival of Betrayal, Hedda Gabler or Death of a Salesman = "original".
- "music-catalog": built around an existing artist's or group's song catalog (jukebox musical), when not based on a film/book.
- "other": any other existing work (myth, opera, ballet, comic, video game, poem, earlier musical, song cycle, podcast, true-crime article, etc.).
- "original": not based on any existing work. Only a show about real people or events that does NOT draw on a specific book, film, myth or song catalog is original.
Examples: Hamilton = "book" (Ron Chernow's biography Alexander Hamilton); Jersey Boys = "music-catalog" (the Four Seasons' songs); Mamma Mia! = "music-catalog"; Hadestown = "other" (the Orpheus myth); Wicked = "book" (Gregory Maguire's novel); Kinky Boots = "film"; Come From Away = "original"; Dear Evan Hansen = "original"; Stereophonic = "original"; Waitress = "film"; Spongebob = "tv"; The Lion King = "film"; Les Miserables = "book"; Kiss Me, Kate = "play" (The Taming of the Shrew); Into the Woods = "other" (fairy tales).
For a revival, classify what the underlying work was based on (a revival of Gypsy = "book", from Gypsy Rose Lee's memoir; a revival of Our Town = "original"). For a revival's ROUTE, count only earlier runs of this same revival staging (same director/production), never earlier productions of the show by other companies. The same goes for an older play or musical getting its first Broadway production in a NEW staging (e.g. Blackbird 2016, Hedwig 2014): earlier productions by other companies, often years before, do not count; only earlier runs of this same staging do.

Give a short pathNote naming the earlier venues with years (null when direct), the sourceTitle (null when original), confidence "high" / "medium" / "low", and 1 to 2 evidence URLs that support the route (prefer IBDB, Playbill, Wikipedia).

Productions:
${lines.join('\n')}

Reply with ONLY a JSON object: {"results":[{"id":"...","path":[...],"pathNote":"...","source":"...","sourceTitle":"...","confidence":"...","evidence":["https://..."]}]} with one entry per production, same ids.`;
}

function resolvePrompt(s, rec) {
  const fmt = (r) => JSON.stringify({ path: r.path, source: r.source });
  return prompt([s]).replace('Productions:', `Two researchers disagreed about this production (or its notes conflict). Answer A: ${fmt(rec)} (note: ${rec.pathNote || 'none'}). Answer B: ${fmt(rec.check || rec)}. Neither is trusted: research the production's full history yourself, checking where its world premiere was and every staged run between that and Broadway, then answer. Do not invent stops; every stop must appear in a page you found.

Productions:`);
}

async function callGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } }),
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      const cand = (j.candidates || [])[0] || {};
      const msg = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
      const m = msg.match(/\{[\s\S]*\}/);
      let parsed = null;
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
      const u = j.usageMetadata || {};
      const grounded = ((cand.groundingMetadata || {}).webSearchQueries || []).length ? 1 : 0;
      const usd = ((u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0)) * GEMINI_PRICE.input / 1e6
        + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * GEMINI_PRICE.output / 1e6
        + grounded * GEMINI_PRICE.perGrounded;
      return { parsed, seen: null, usd };
    }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 10000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  throw new Error('retries exhausted');
}

async function callModel(text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, input: text, tools: [{ type: 'web_search' }], reasoning: { effort: EFFORT }, include: ['web_search_call.action.sources'] }),
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      const out = j.output || [];
      const parts = out.filter((o) => o.type === 'message').flatMap((o) => o.content || []);
      const msg = parts.map((c) => c.text || '').join('');
      // URLs the search really returned; evidence must come from these.
      const seen = [
        ...parts.flatMap((c) => (c.annotations || []).filter((a) => a.type === 'url_citation').map((a) => a.url)),
        ...out.filter((o) => o.type === 'web_search_call').flatMap((o) => { const a = o.action || {}; return [a.url, ...((a.sources || []).map((x) => x.url))]; }),
      ].filter(Boolean);
      const m = msg.match(/\{[\s\S]*\}/);
      let parsed = null;
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
      return { parsed, seen, usd: researchCallCost(j.usage, MODEL, countSearchCalls(out)).total };
    }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 10000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  throw new Error('retries exhausted');
}

async function main() {
  if (!args['dry-run'] && !process.env[args.check ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY']) throw new Error(`${args.check ? 'GEMINI' : 'OPENAI'}_API_KEY not set`);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const out = loadOut();
  let todo = inScopeShows(shows);
  if (args.ids) {
    const ids = new Set(String(args.ids).split(','));
    todo = shows.filter((s) => ids.has(s.id));
  }
  const MODE = args.check ? 'check' : args.resolve ? 'resolve' : 'classify';
  if (MODE === 'check') {
    todo = todo.filter((s) => out.shows[s.id] && !out.shows[s.id].check && !out.shows[s.id].verifiedBy);
  } else if (MODE === 'resolve') {
    todo = todo.filter((s) => {
      const r = out.shows[s.id];
      return r && r.check && !r.resolvedBy && !r.verifiedBy && (!originsAgree(r, r.check) || r.needsReview);
    });
  } else if (args['needs-review']) {
    // Second pass: re-ask flagged shows one at a time.
    const flagged = new Set(Object.keys(out.shows).filter((id) => out.shows[id].needsReview && !out.shows[id].verifiedBy));
    todo = shows.filter((s) => flagged.has(s.id));
  } else if (!args.redo) todo = todo.filter((s) => !out.shows[s.id]);
  // Hand corrections (verifiedBy) are never overwritten by a model answer.
  todo = todo.filter((s) => !(out.shows[s.id] && out.shows[s.id].verifiedBy));
  todo.sort((a, b) => a.openingDate.localeCompare(b.openingDate));
  if (args.limit) todo = todo.slice(0, Number(args.limit));
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  console.log(`[origins] ${todo.length} shows in ${batches.length} batches (${MODE}, model ${MODE === 'check' ? CHECK_MODEL : MODEL}, cap $${MAX_USD})`);
  if (args['dry-run']) { console.log(prompt(batches[0] || [])); return; }

  let spent = 0;
  let done = 0;
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < batches.length && spent < MAX_USD) {
      const batch = batches[next++];
      let r;
      try {
        if (MODE === 'check') r = await callGemini(prompt(batch));
        else if (MODE === 'resolve') r = await callModel(resolvePrompt(batch[0], out.shows[batch[0].id]));
        else r = await callModel(prompt(batch));
      } catch (e) { failures.push(...batch.map((s) => `${s.id}: ${e.message}`)); continue; }
      spent += r.usd;
      const results = (r.parsed && Array.isArray(r.parsed.results)) ? r.parsed.results : [];
      for (const s of batch) {
        const hit = results.find((x) => x && x.id === s.id);
        if (MODE === 'check') {
          // Gemini's grounding links are redirect URLs, so the check keeps only its labels.
          const c = normalizeCheck(hit);
          if (c.error) { failures.push(`${s.id}: ${c.error}`); continue; }
          out.shows[s.id].check = { ...c.record, model: CHECK_MODEL };
          done++;
          continue;
        }
        const n = normalizeOrigin(hit, r.seen);
        if (n.error) { failures.push(`${s.id}: ${n.error}`); continue; }
        const conflicts = pathNoteConflicts(n.record);
        out.shows[s.id] = {
          title: s.title, openingDate: s.openingDate, ...n.record,
          ...(conflicts.length ? { needsReview: `pathNote names ${conflicts.join(', ')} stops the route codes leave out` } : {}),
          model: MODEL, classifiedAt: new Date().toISOString().slice(0, 10),
          ...(MODE === 'resolve' ? { check: out.shows[s.id].check, firstAnswer: { path: out.shows[s.id].path, source: out.shows[s.id].source }, resolvedBy: `${MODEL}:${EFFORT}` } : {}),
        };
        done++;
      }
      saveOut(out);
      console.log(`[origins] ${done}/${todo.length} done, $${spent.toFixed(2)} spent`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(JSON.stringify({ done, failed: failures.length, spentUsd: Number(spent.toFixed(2)) }));
  if (failures.length) {
    console.log('Failures:\n' + failures.slice(0, 40).join('\n'));
    process.exitCode = 1; // progress is saved; a red run lets the workflow's failure notice fire (BRO-5867)
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
