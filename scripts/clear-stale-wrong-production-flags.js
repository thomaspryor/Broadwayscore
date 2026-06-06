#!/usr/bin/env node
/**
 * Sweep stale wrongProduction=true flags off review-text files that are
 * actually substantial individual critic reviews of THIS production.
 * Identified by `isLikelyStaleWrongProduction()` from
 * scripts/lib/review-guards.js, then verified by an LLM second-opinion
 * (Sonnet) before the flag is cleared. Bulk-override is UNSAFE for this
 * flag — most ~15k flagged files are CORRECTLY flagged (tour reviews,
 * regional tryouts, prior revivals, cross-Atlantic transfers).
 *
 * Background: Notion 34e637c5-416f-811d, Session 5 of multi-flag stale
 * audit. Predecessors: isRoundupArticle (817b), wrongShow (8121),
 * suspectedMisattribution (81b8), wrongAttribution (no stale cohort).
 *
 * Default mode runs an LLM second-opinion (Anthropic Claude Sonnet) per
 * candidate. Predicate alone has ~88% precision (manual sample 8/9);
 * LLM lifts to ~95%+. The sweep sets `wrongProduction = false` directly
 * (so the bare gate checks at is-scoreable.js:12, review-text-scoreable.js:49,
 * and llm-scoring/is-scoreable.ts:15 also pass without further refactor)
 * AND writes `wrongProductionManualClear = true` as a durable breadcrumb
 * so future audit/restore-protected-fields don't re-flag the file.
 *
 * Usage:
 *   node scripts/clear-stale-wrong-production-flags.js              # dry-run, predicate only
 *   node scripts/clear-stale-wrong-production-flags.js --llm        # dry-run + LLM second-opinion
 *   node scripts/clear-stale-wrong-production-flags.js --llm --apply  # write to disk
 *   node scripts/clear-stale-wrong-production-flags.js --show=ID    # filter to one show
 *   node scripts/clear-stale-wrong-production-flags.js --dir=PATH   # alt review-texts dir
 *
 * Without --llm the predicate is the only gate. NOT RECOMMENDED for
 * apply-mode — the flag's signal is weak and bulk-override is risky.
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleWrongProduction } = require('./lib/review-guards');
const { CLAUDE_SONNET } = require('./lib/models');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USE_LLM = args.includes('--llm');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';
const SHOWS_OVERRIDE = (args.find(a => a.startsWith('--shows=')) || '').split('=')[1] || '';

if (APPLY && !USE_LLM) {
  console.error('REFUSED: --apply requires --llm. Predicate alone is too weak for wrongProduction.');
  console.error('       Re-run with both flags, or use --apply on isLikelyStaleWrongShow / isLikelyStaleRoundupFlag instead.');
  process.exit(1);
}

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = SHOWS_OVERRIDE || path.join(__dirname, '..', 'data', 'shows.json');

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = Object.create(null);
for (const s of showsArr) if (s && s.id) showById[s.id] = s;

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
  .map(d => d.name)
  .sort();

let scanned = 0;
let flagged = 0;
let predicateMatches = 0;
let llmConfirmed = 0;
let llmRejected = 0;
let cleared = 0;
const candidates = [];

for (const showId of showDirs) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  const show = showById[showId];
  if (!show) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch { continue; }
  for (const f of files) {
    scanned++;
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.wrongProduction !== true) continue;
    flagged++;
    if (!isLikelyStaleWrongProduction(data, show)) continue;
    predicateMatches++;
    candidates.push({ showId, file: f, filePath, data, show });
  }
}

async function llmVerify(c) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — re-run without --llm or export the key');
  }
  const fullText = String(c.data.fullText || '');
  const excerpt = fullText.length > 4000 ? fullText.slice(0, 4000) + '\n[…truncated]' : fullText;
  const prompt = `You are auditing whether a review-text file is a real review of a SPECIFIC theatrical PRODUCTION (not just the same play in a different production).

Show: "${c.show.title}"
Show ID: ${c.show.id}
Opening date: ${c.show.openingDate || '(unknown)'}
Closing date: ${c.show.closingDate || '(open run)'}
Show category: ${c.show.category || '(unknown)'}
Show venue: ${c.show.venue || '(unknown)'}
Review URL: ${c.data.url}
Review publish date: ${c.data.publishDate || '(unknown)'}
Critic: ${c.data.criticName || '(unknown)'}
Outlet: ${c.data.outlet || c.data.outletId || '(unknown)'}

Full text excerpt:
---
${excerpt}
---

Question: Is this review of THIS specific production — the one that opened ${c.show.openingDate}${c.show.venue ? ' at ' + c.show.venue : ''}? Consider:
- Cross-Atlantic transfers (e.g., West End original vs Broadway transfer = DIFFERENT productions)
- Regional tryouts (e.g., Boston Huntington pre-Broadway tryout = DIFFERENT production)
- Revivals (e.g., 2003 Wicked Broadway opening vs 2024 national tour = DIFFERENT productions)
- Prior productions of same play (e.g., 2008 Lincoln Center Macbeth vs 2022 Daniel Craig Macbeth)
- Concert / staged-reading versions (City Center Encores, etc.) vs full production
- Preview/opening reviews of THIS run = SAME production

Reply with JSON only: {"isThisProduction": true|false, "confidence": "high"|"medium"|"low", "reason": "<one sentence>"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM call failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content && json.content[0] && json.content[0].text) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM response not parseable: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

(async () => {
  const decisions = [];
  if (USE_LLM) {
    console.log(`Running LLM second-opinion on ${candidates.length} candidates (rate-limited 1/sec)...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const v = await llmVerify(c);
        // STRICTER than wrongShow sweep — require HIGH confidence for wrongProduction
        // because the false-clear cost is leaking actual wrong-production reviews
        // back into scoring (wrong-production noise is much more common than wrong-show).
        const verdict = v.isThisProduction === true && v.confidence === 'high';
        decisions.push({ c, v, verdict });
        if (verdict) llmConfirmed++; else llmRejected++;
        console.log(`  ${i + 1}/${candidates.length} ${c.showId}/${c.file} → ${verdict ? 'CONFIRMED' : 'rejected'} (${v.confidence}: ${v.reason})`);
      } catch (e) {
        decisions.push({ c, v: null, verdict: false, error: e.message });
        llmRejected++;
        console.log(`  ${i + 1}/${candidates.length} ${c.showId}/${c.file} → ERROR: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } else {
    for (const c of candidates) decisions.push({ c, v: null, verdict: true });
  }

  const toClear = decisions.filter(d => d.verdict);

  console.log('');
  console.log(`Scanned: ${scanned} files`);
  console.log(`wrongProduction=true: ${flagged}`);
  console.log(`Predicate matches: ${predicateMatches}`);
  if (USE_LLM) {
    console.log(`LLM confirmed stale (high-conf only): ${llmConfirmed}`);
    console.log(`LLM rejected (genuine wrong-production OR low-conf): ${llmRejected}`);
  }
  console.log(`Would clear: ${toClear.length}`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write changes.\n');
    console.log('Files that would be cleared:');
    for (const d of toClear) console.log(`  ${d.c.showId}/${d.c.file}`);
    return;
  }

  for (const d of toClear) {
    const orig = fs.readFileSync(d.c.filePath, 'utf8');
    const hadTrailingNewline = orig.endsWith('\n');
    d.c.data.wrongProduction = false;
    d.c.data.wrongProductionManualClear = true;
    d.c.data.wrongProductionClearedNote = `[2026-04-26 cleared stale wrongProduction — predicate + Sonnet (high-conf) confirmed real review of ${d.c.show.title} — Notion 34e637c5-416f-811d]`;
    fs.writeFileSync(d.c.filePath, JSON.stringify(d.c.data, null, 2) + (hadTrailingNewline ? '\n' : ''));
    cleared++;
  }
  console.log(`\nAPPLIED — cleared ${cleared} files.`);
})().catch(e => { console.error(e); process.exit(1); });
