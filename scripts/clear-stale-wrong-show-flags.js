#!/usr/bin/env node
/**
 * Sweep stale wrongShow=true flags off review-text files that are actually
 * substantial individual critic reviews of the show in question. Identified
 * by `isLikelyStaleWrongShow()` from scripts/lib/review-guards.js, optionally
 * verified by an LLM second-opinion (Sonnet) before the flag is cleared.
 *
 * Background: Notion 34e637c5-416f-8121. wrongShow is set by 3 paths —
 *   (1) LLM ensemble rejection (rejectionReason='wrong_show'),
 *   (2) content-fingerprint cross-attribution audit, and
 *   (3) manual flagging in ingest-manual-review.js.
 * The Giant 2026-04-22 incident (LLM mis-rejected real Broadway reviews because
 * it knew "Giant the musical" from training and called the play wrong-show)
 * is the canonical false positive. Older code paths leave the flag on disk
 * even after the producing logic is tightened, silently dropping legitimate
 * reviews from rebuild + LLM rescore.
 *
 * The predicate has measured precision ~75% on a 20-file sample. To lift that
 * to ~95%+ before a write, the default mode runs an LLM second-opinion
 * (Anthropic Claude Sonnet) per candidate, asking "is this fullText a real
 * critic review of {showTitle} ({openingDate})?" with the URL + a fullText
 * excerpt. Only files where the predicate AND the LLM both agree are cleared.
 *
 * Usage:
 *   node scripts/clear-stale-wrong-show-flags.js                # dry-run, predicate only
 *   node scripts/clear-stale-wrong-show-flags.js --llm          # dry-run + LLM second-opinion
 *   node scripts/clear-stale-wrong-show-flags.js --llm --apply  # write to disk
 *   node scripts/clear-stale-wrong-show-flags.js --show=ID      # filter to one show
 *   node scripts/clear-stale-wrong-show-flags.js --dir=PATH     # alt review-texts dir
 *
 * Without --llm the predicate is the only gate — useful for high-confidence
 * subsets (e.g. files with manualClear=true that just need the disk flag
 * cleared so future scans match).
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleWrongShow } = require('./lib/review-guards');
const { CLAUDE_SONNET } = require('./lib/models');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USE_LLM = args.includes('--llm');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';
const SHOWS_OVERRIDE = (args.find(a => a.startsWith('--shows=')) || '').split('=')[1] || '';

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
    if (data.wrongShow !== true) continue;
    flagged++;
    if (!isLikelyStaleWrongShow(data, show)) continue;
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
  const prompt = `You are auditing whether a review-text file is a real review of a specific theatrical production.

Show: "${c.show.title}"
Show ID: ${c.show.id}
Opening date: ${c.show.openingDate || '(unknown)'}
Show category: ${c.show.category || '(unknown)'}
Review URL: ${c.data.url}
Critic: ${c.data.criticName || '(unknown)'}
Outlet: ${c.data.outlet || c.data.outletId || '(unknown)'}

Full text excerpt:
---
${excerpt}
---

Question: Is this an individual critic review of "${c.show.title}" — the production that opened ${c.show.openingDate} (i.e., this exact production, not a different production of the same play, not a film/TV adaptation, not a multi-show roundup)?

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
        const verdict = v.isThisProduction === true && (v.confidence === 'high' || v.confidence === 'medium');
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
  console.log(`wrongShow=true: ${flagged}`);
  console.log(`Predicate matches: ${predicateMatches}`);
  if (USE_LLM) {
    console.log(`LLM confirmed stale: ${llmConfirmed}`);
    console.log(`LLM rejected (genuine wrong-show): ${llmRejected}`);
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
    d.c.data.wrongShow = false;
    const note = USE_LLM
      ? `[2026-04-26 cleared stale wrongShow — predicate + Sonnet confirmed real review of ${d.c.show.title} — Notion 34e637c5-416f-8121]`
      : `[2026-04-26 cleared stale wrongShow — predicate-only — Notion 34e637c5-416f-8121]`;
    d.c.data.wrongShowClearedNote = note;
    fs.writeFileSync(d.c.filePath, JSON.stringify(d.c.data, null, 2) + (hadTrailingNewline ? '\n' : ''));
    cleared++;
  }
  console.log(`\nAPPLIED — cleared ${cleared} files.`);
})().catch(e => { console.error(e); process.exit(1); });
