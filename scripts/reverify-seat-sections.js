#!/usr/bin/env node
'use strict';
/**
 * Re-verify archived seating sections against their own cited sources (BRO-8018).
 *
 *   node scripts/reverify-seat-sections.js fetch  --snapshot=FILE [--theater="Gershwin Theatre"]
 *   node scripts/reverify-seat-sections.js run    --snapshot=FILE [--theater=...] [--max-usd=25]
 *   node scripts/reverify-seat-sections.js recheck-rows --snapshot=FILE [--max-usd=1]   (rows-in-name check on cached results)
 *   node scripts/reverify-seat-sections.js report --snapshot=FILE [--audit-out=FILE]
 *   node scripts/reverify-seat-sections.js apply  --snapshot=FILE [--write]
 *
 * FILE is an archived data/theater-metadata.json (e.g. `git show 38018c358f3e:data/theater-metadata.json`).
 * Per section: GPT rewrites it down to what the cited pages say, with a quote for every claim;
 * a program checks each quote is word-for-word on a page that names the theater; Gemini then
 * checks each quoted claim. Only claims passing all three survive (scripts/lib/seat-adjudication.js).
 *
 * Fetched page text is copyrighted: it stays in .cache/seat-evidence/ (gitignored), never in the repo.
 * Model or fetch errors are never read as "unsupported": the section is left UNKNOWN and retried
 * on the next run; apply refuses while any UNKNOWN remains.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./lib/seat-adjudication');
const { foldDiacritics } = require('./lib/title-match');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'seat-evidence');
const PAGES = path.join(CACHE, 'pages');
const RESULTS = path.join(CACHE, 'results');
const META = path.join(ROOT, 'data', 'theater-metadata.json');
const DEFAULT_AUDIT = path.join(ROOT, 'data', 'seat-research-eval', 'audits', '2026-11-bro-8018.json');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const slug = (t) => foldDiacritics(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadSnapshot() {
  const f = arg('snapshot');
  if (!f) throw new Error('--snapshot=FILE is required');
  const raw = fs.readFileSync(f, 'utf8');
  return { data: JSON.parse(raw), sha: sha(raw).slice(0, 16) };
}

function theatersWithSections(snap) {
  const only = arg('theater');
  return Object.keys(snap)
    .filter((t) => ((snap[t].structuredTips || {}).seating || {}).sections?.length)
    .filter((t) => !only || only.split('|').includes(t));
}

const pageFile = (url) => path.join(PAGES, `${sha(url)}.json`);
function readPage(url) {
  try { return JSON.parse(fs.readFileSync(pageFile(url), 'utf8')); } catch { return null; }
}

/** Broadway titles a rationale may not name at this theater: every title except current tenants. */
function showTitleRules(theaterName) {
  let shows = [];
  for (const p of [path.join(ROOT, 'data', 'shows.json')]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); shows = Array.isArray(j) ? j : j.shows; break; } catch { /* next */ }
  }
  if (!shows.length) throw new Error('shows.json not found (run scripts/setup-local-data.sh --link-only)');
  const bw = shows.filter((s) => s.market === 'broadway' && s.title);
  const names = A.theaterNamePatterns(theaterName);
  const tenants = bw.filter((s) => ['open', 'previews'].includes(s.status) && names.includes(A.normalizeText(s.venue)));
  const allowed = new Set(tenants.map((s) => s.title));
  const forbidden = [...new Set(bw.map((s) => s.title))].filter((t) => !allowed.has(t) && A.normalizeText(t).length >= 4);
  return { allowed: [...allowed], forbidden };
}

/** Title, post body and every comment body from a Reddit thread's JSON listing. */
function redditText(raw) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const k of ['title', 'selftext', 'body']) if (typeof v[k] === 'string' && v[k].trim()) out.push(v[k]);
    for (const [k, x] of Object.entries(v)) if (k !== 'body_html' && k !== 'selftext_html' && typeof x === 'object') walk(x);
  };
  walk(JSON.parse(String(raw).replace(/^[^[{]*/, '').replace(/<\/pre>[\s\S]*$/, '')));
  return out.join('\n');
}

async function cmdFetch() {
  const { fetchPage } = require('./lib/scraper');
  const { data } = loadSnapshot();
  fs.mkdirSync(PAGES, { recursive: true });
  const urls = [...new Set(theatersWithSections(data).flatMap((t) => data[t].structuredTips.seating.sections.flatMap((s) => s.evidenceUrls || [])))];
  const todo = urls.filter((u) => { const p = readPage(u); return !p || (!p.ok && arg('retry-failed')); });
  console.log(`fetch: ${urls.length} unique URLs, ${todo.length} to fetch`);
  let n = 0;
  // Pages are independent files, so parallel fetches never write the same path.
  await require('./lib/dual-model-client').pool(todo, Number(arg('concurrency', 6)), async (url) => {
    let rec;
    try {
      const reddit = /(^|\.)reddit\.com$/.test(new URL(url).hostname);
      // Reddit serves a script shell to scrapers; the thread's .json form carries the post and comments.
      const r = await fetchPage(reddit ? `${url.replace(/[?#].*$/, '').replace(/\/$/, '')}.json` : url, {});
      const text = reddit ? redditText(r.content)
        : r.format === 'html' || /<html|<body|<div/i.test(r.content || '') ? A.htmlToText(r.content) : String(r.content || '');
      rec = { url, ok: text.length > 200, text, source: r.source, finalUrl: r.finalUrl || url, fetchedAt: new Date().toISOString() };
      if (!rec.ok) rec.error = 'page text under 200 chars';
    } catch (e) {
      rec = { url, ok: false, error: String(e.message || e).slice(0, 200), fetchedAt: new Date().toISOString() };
    }
    fs.writeFileSync(pageFile(url), JSON.stringify(rec));
    if (++n % 10 === 0) console.log(`  ${n}/${todo.length}`);
  });
  const ok = urls.filter((u) => (readPage(u) || {}).ok).length;
  console.log(`fetch done: ${ok}/${urls.length} pages usable`);
}

function sourcesFor(theaterName, section) {
  return (section.evidenceUrls || []).map((url) => {
    const p = readPage(url);
    if (!p) return { url, missing: true };
    if (!p.ok) return { url, text: '', namesTheater: false, error: p.error };
    const namesTheater = A.pageNamesTheater(p.text, theaterName);
    return { url, text: p.text, namesTheater, passages: namesTheater ? A.selectPassages(p.text, theaterName, section) : '' };
  });
}

async function adjudicateSection(theaterName, section, rules, clients) {
  const sources = sourcesFor(theaterName, section);
  if (sources.some((s) => s.missing)) return { status: 'UNKNOWN', reason: 'evidence not fetched yet' };
  const live = sources.filter((s) => s.namesTheater);
  if (!live.length) return { status: 'DROPPED', reason: 'no cited page loads and names the theater', sources: sources.map((s) => ({ url: s.url, ok: !!s.text, namesTheater: !!s.namesTheater })) };

  const rewritePrompt = A.buildRewritePrompt({ theaterName, section, sources, allowedShowTitles: rules.allowed });
  let reply;
  try { reply = A.parseJsonReply(await clients.askOpenAI(rewritePrompt)); } catch (e) { return { status: 'UNKNOWN', reason: `rewrite: ${e.message}` }; }
  const { claims } = A.groundRewrite(section, reply, sources, { forbiddenTitles: rules.forbidden });
  const quotesOffered = countQuotes(reply);
  const base = {
    sources: sources.map((s) => ({ url: s.url, ok: !!s.text, namesTheater: !!s.namesTheater })),
    quotesOffered, quotesGrounded: claims.reduce((n, c) => n + c.evidence.length, 0),
  };
  if (!claims.length) return { status: 'DROPPED', reason: 'no claim had a word-for-word quote', ...base, claims: [] };

  let accepted;
  try {
    const vp = A.buildVerifyPrompt({ theaterName, sectionName: section.name, claims });
    accepted = A.parseVerifyReply(await clients.askGemini(vp), claims.length);
  } catch (e) { return { status: 'UNKNOWN', reason: `verify: ${e.message}` }; }

  const decision = A.decideSection(section, claims, accepted);
  const claimLog = claims.map((c, i) => ({
    kind: c.kind, text: c.text, accepted: accepted.get(i + 1), why: accepted.why ? accepted.why.get(i + 1) : undefined,
    evidence: c.evidence.map((e) => ({ url: e.url, quoteHash: A.quoteHash(e.quote), quote: e.quote })),
  }));
  if (decision.dropped) return { status: 'DROPPED', reason: decision.dropped, ...base, claims: claimLog };
  const out = decision.section;
  out.dataPoints = new Set(out.evidenceUrls).size;
  return { status: 'KEPT', section: out, ...base, claims: claimLog };
}

function countQuotes(reply) {
  let n = 0;
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.quote === 'string') n++; Object.values(v).forEach(walk); } };
  walk(reply);
  return n;
}

async function cmdRun() {
  const clients = require('./lib/dual-model-client');
  clients.spend.maxUsd = Number(arg('max-usd', 25));
  const { data, sha: snapSha } = loadSnapshot();
  fs.mkdirSync(RESULTS, { recursive: true });
  const theaters = theatersWithSections(data);
  console.log(`run: ${theaters.length} theaters; models ${clients.OPENAI_MODEL} (rewrite) + ${clients.GEMINI_MODEL} (verify); cap $${clients.spend.maxUsd}`);
  for (const t of theaters) {
    const file = path.join(RESULTS, `${slug(t)}.json`);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
    if ((prev.snapshotSha && prev.snapshotSha !== snapSha) || arg('fresh')) prev = {};
    const rules = showTitleRules(t);
    const sections = data[t].structuredTips.seating.sections;
    const results = prev.sections || [];
    await clients.pool(sections.map((s, i) => [s, i]), 3, async ([s, i]) => {
      if (results[i] && results[i].status !== 'UNKNOWN' && results[i].name === s.name) return;
      results[i] = { name: s.name, ...(await adjudicateSection(t, s, rules, clients)) };
    });
    const kept = results.filter((r) => r && r.status === 'KEPT').map((r) => r.section);
    const unknown = results.filter((r) => !r || r.status === 'UNKNOWN').length;
    const problems = unknown ? ['has UNKNOWN sections'] : A.theaterKeepProblems(kept);
    fs.writeFileSync(file, JSON.stringify({ theater: t, snapshotSha: snapSha, models: { rewrite: clients.OPENAI_MODEL, verify: clients.GEMINI_MODEL }, ranAt: new Date().toISOString(), sections: results, theaterKept: !problems.length, theaterProblems: problems }, null, 1));
    console.log(`${t}: ${kept.length}/${sections.length} kept, ${unknown} unknown${problems.length ? ` -> theater blank (${problems.join('; ')})` : ''}  [$${clients.spend.usd.toFixed(2)}]`);
  }
  console.log(`spend: $${clients.spend.usd.toFixed(2)} over ${clients.spend.calls} calls`);
}

/**
 * Audit-3 follow-up over cached results, without re-running the rewriter: strip seat numbers from
 * kept names, and for names that carry rows, verify the verdict holds for every listed row using
 * the quotes already grounded for that section. Rejected -> section dropped, theater re-decided.
 */
async function cmdRecheckRows() {
  const clients = require('./lib/dual-model-client');
  clients.spend.maxUsd = Number(arg('max-usd', 1));
  const { data, sha: snapSha } = loadSnapshot();
  const only = arg('theater') ? String(arg('theater')).split('|') : null;
  let checked = 0, dropped = 0, renamed = 0;
  for (const r of loadResults(snapSha)) {
    if (only && !only.includes(r.theater)) continue;
    const orig = data[r.theater].structuredTips.seating.sections;
    const rules = showTitleRules(r.theater);
    await clients.pool(r.sections.map((x, i) => [x, i]), 3, async ([res, i]) => {
      if (res.status !== 'KEPT' || (res.claims || []).some((c) => c.kind === 'nameRows')) return;
      const sec = res.section;
      const stripped = A.cleanName(A.stripSeatNumbers(sec.name));
      if (stripped && stripped !== sec.name) { sec.name = stripped; renamed++; }
      const text = A.nameRowsClaimText(sec.name, sec.verdict, sec.rowRange);
      if (!text) return;
      const sources = sourcesFor(r.theater, orig[i]);
      const idx = new Map(sources.map((s, k) => [s.url, k + 1]));
      const quotes = (res.claims || []).filter((c) => c.accepted && ['name', 'verdict', 'rowRange'].includes(c.kind)).flatMap((c) => c.evidence);
      const evidence = A.groundEvidence(quotes.map((e) => ({ src: idx.get(e.url), quote: e.quote })), sources);
      const claim = { kind: 'nameRows', text, evidence };
      let acc;
      try {
        acc = evidence.length ? A.parseVerifyReply(await clients.askGemini(A.buildVerifyPrompt({ theaterName: r.theater, sectionName: sec.name, claims: [claim] })), 1) : new Map([[1, false]]);
      } catch (e) { res.status = 'UNKNOWN'; res.reason = `recheck: ${e.message}`; return; }
      checked++;
      res.claims.push({ kind: 'nameRows', text, accepted: acc.get(1), why: acc.why ? acc.why.get(1) : 'no grounded evidence', evidence: evidence.map((e) => ({ url: e.url, quoteHash: A.quoteHash(e.quote), quote: e.quote })) });
      if (acc.get(1) !== true) { res.status = 'DROPPED'; res.reason = 'rows in name not supported'; res.section = undefined; dropped++; }
    });
    const kept = r.sections.filter((x) => x.status === 'KEPT').map((x) => x.section);
    const unknown = r.sections.filter((x) => x.status === 'UNKNOWN').length;
    const problems = unknown ? ['has UNKNOWN sections'] : A.theaterKeepProblems(kept);
    for (const k of kept) for (const c of A.copyProblems(k.name, { forbiddenTitles: rules.forbidden })) problems.push(`${k.name}: ${c}`);
    r.theaterKept = !problems.length; r.theaterProblems = problems; r.recheckedAt = new Date().toISOString();
    fs.writeFileSync(path.join(RESULTS, `${slug(r.theater)}.json`), JSON.stringify(r, null, 1));
  }
  console.log(`recheck-rows: ${checked} checked, ${dropped} dropped, ${renamed} renamed  [$${clients.spend.usd.toFixed(2)}]`);
}

function loadResults(snapSha) {
  if (!fs.existsSync(RESULTS)) return [];
  return fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'))).filter((r) => r.snapshotSha === snapSha);
}

function cmdReport() {
  const { data, sha: snapSha } = loadSnapshot();
  const res = loadResults(snapSha);
  const all = res.flatMap((r) => r.sections);
  const by = (k) => all.reduce((m, s) => { m[s[k]] = (m[s[k]] || 0) + 1; return m; }, {});
  const reasons = all.filter((s) => s.status === 'DROPPED').reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
  const claims = all.flatMap((s) => s.claims || []);
  console.log(JSON.stringify({
    theatersInSnapshot: theatersWithSections(data).length, theatersRun: res.length,
    theatersKept: res.filter((r) => r.theaterKept).length,
    sections: all.length, byStatus: by('status'), dropReasons: reasons,
    claimsChecked: claims.length, claimsAccepted: claims.filter((c) => c.accepted).length,
    quotesOffered: all.reduce((n, s) => n + (s.quotesOffered || 0), 0), quotesGrounded: all.reduce((n, s) => n + (s.quotesGrounded || 0), 0),
  }, null, 1));
  const out = arg('audit-out');
  if (out) {
    // Compact audit for the public repo: decisions, URLs and quote hashes only. No copied text.
    const audit = {
      card: 'BRO-8018', snapshotSha: snapSha, generatedAt: new Date().toISOString(),
      theaters: res.map((r) => ({
        theater: r.theater, kept: r.theaterKept, problems: r.theaterProblems, models: r.models,
        sections: r.sections.map((s) => ({
          name: s.name, status: s.status, reason: s.reason || null,
          claims: (s.claims || []).map((c) => ({ kind: c.kind, accepted: c.accepted, evidence: c.evidence.map((e) => ({ url: e.url, quoteHash: e.quoteHash })) })),
        })),
      })),
    };
    fs.mkdirSync(path.dirname(out === true ? DEFAULT_AUDIT : out), { recursive: true });
    fs.writeFileSync(out === true ? DEFAULT_AUDIT : out, `${JSON.stringify(audit, null, 1)}\n`);
    console.log(`audit written: ${out === true ? DEFAULT_AUDIT : out}`);
  }
}

function cmdApply() {
  const { sha: snapSha } = loadSnapshot();
  const res = loadResults(snapSha);
  if (!res.length) throw new Error('no results for this snapshot; run `run` first');
  const unknown = res.filter((r) => r.sections.some((s) => !s || s.status === 'UNKNOWN')).map((r) => r.theater);
  if (unknown.length) throw new Error(`refusing: UNKNOWN sections remain for ${unknown.join(', ')}`);
  const { validateSeatingSections } = require('./lib/seating-sections-validators');
  const bad = res.filter((r) => r.theaterKept).flatMap((r) => validateSeatingSections(r.theater, r.sections.filter((s) => s.status === 'KEPT').map((s) => s.section), { forbiddenTitles: showTitleRules(r.theater).forbidden }));
  if (bad.length) throw new Error(`refusing: kept sections fail validation:\n  ${bad.join('\n  ')}`);
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const byTheater = new Map(res.map((r) => [r.theater, r]));
  const summary = { set: [], cleared: [], untouched: [] };
  for (const t of Object.keys(meta)) {
    const seating = ((meta[t].structuredTips || {}).seating) || null;
    const r = byTheater.get(t);
    if (r && r.theaterKept) {
      meta[t].structuredTips = meta[t].structuredTips || {};
      meta[t].structuredTips.seating = { ...(seating || {}), sections: r.sections.filter((s) => s.status === 'KEPT').map((s) => s.section) };
      summary.set.push(t);
    } else if (seating && seating.sections) {
      // Not verified: the current sections (Sept 2026 unsourced templates) come off too.
      delete seating.sections;
      if (!Object.keys(seating).length) delete meta[t].structuredTips.seating;
      summary.cleared.push(t);
    } else summary.untouched.push(t);
  }
  const missing = res.map((r) => r.theater).filter((t) => !(t in meta));
  console.log(JSON.stringify({ set: summary.set.length, cleared: summary.cleared, untouched: summary.untouched.length, theatersNotInCurrentFile: missing }, null, 1));
  if (arg('write')) {
    fs.writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`wrote ${META}`);
  } else console.log('dry run (pass --write to save)');
}

const cmd = process.argv[2];
const table = { fetch: cmdFetch, run: cmdRun, 'recheck-rows': cmdRecheckRows, report: cmdReport, apply: cmdApply };
if (require.main === module) {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n'));
    process.exit(0);
  }
  if (!table[cmd]) { console.error('usage: reverify-seat-sections.js fetch|run|recheck-rows|report|apply --snapshot=FILE'); process.exit(2); }
  Promise.resolve(table[cmd]()).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}

module.exports = { showTitleRules, sourcesFor, adjudicateSection };
