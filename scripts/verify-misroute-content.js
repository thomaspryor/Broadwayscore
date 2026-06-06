#!/usr/bin/env node
/**
 * Independent content verification for slug-misroute findings.
 *
 * The slug matcher routes a review to a show using the aggregator ROUNDUP slug
 * (bwwRoundupUrl / playbillVerdictUrl). That is one signal. This script adds a
 * SECOND, independent signal: it reads the review file's OWN url + text +
 * publishDate (not the roundup slug) and asks two LLMs which production the
 * review is actually about. A move is auto-confirmed ONLY when both models
 * agree the review is about the matcher's TO show.
 *
 * Why this exists: real data has files where the roundup slug points at show X
 * but the review itself is about show Y. Examples found 2026-05-28:
 *   - bigfoot-off-broadway-2026/timeout--adam-feldman.json: roundup slug matched
 *     big-fish-2013, but the review text is about Bigfoot (2026). TO is WRONG.
 *   - cat-on-a-hot-tin-roof-2008/nytimes--ben-brantley.json: url is
 *     .../07roof.html (the 2008 Cat review) but a Streetcar roundup slug routes
 *     it to a-streetcar-named-desire-2012. TO is WRONG — leave it in Cat.
 *   - cat-.../nypost--elisabeth-vincentelli.json: url .../substandard_stanley —
 *     a real Streetcar review misfiled under Cat. TO is RIGHT — move it.
 * A blanket move of a from->to group would corrupt the first two. Per-file
 * content verification is the only way to tell them apart.
 *
 * Two-model agreement (Gemini + GPT-4o) because the cost of a wrong move is
 * high (live scores, critic pages, SEO, broadcast emails). Either model saying
 * anything other than "to" leaves the row confirm:false for a human.
 *
 * Output: rewrites the whitelist with verifierVerdict on every processed row
 * and confirm:true ONLY on rows both models verify as "to". Also writes a
 * human-readable report next to it. Does NOT move any files.
 *
 * Usage:
 *   node scripts/verify-misroute-content.js \
 *     [--whitelist=PATH] [--out=PATH] [--limit=N] [--concurrency=4]
 *   REVIEW_TEXTS_DIR defaults to ~/broadway-review-texts.
 */

const fs = require('fs');
const path = require('path');
const { callGemini, callOpenAI } = require('./lib/content-verifier');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const WHITELIST = flag('whitelist', path.join(process.env.HOME || '', 'Documents/claude-outputs/slug-misroute-whitelist.json'));
const OUT = flag('out', WHITELIST);
const LIMIT = parseInt(flag('limit', '0'), 10) || Infinity;
const CONCURRENCY = parseInt(flag('concurrency', '4'), 10);
// By default a row that already carries a verifierVerdict is left as-is, so a
// prior reject / needs-human decision is STICKY and a rerun can never flip it
// to confirm:true (LLM nondeterminism footgun, ship-check Codex 2026-05-28).
// Pass --reverify to deliberately re-evaluate every eligible row from scratch.
const REVERIFY = args.includes('--reverify');
// By default only clean rows (no warnings, not out-of-scope) are verified.
// --include-flagged also verifies rows carrying heuristic warnings
// (to-year-far / no-date / from-also-full-match); --include-oos also verifies
// Class-C generic-bin rows. The content check reads the review's OWN url+text
// and is the real arbiter — the warnings/Class-C labels were only heuristics,
// and the two-model agreement gate still fails closed, so a flagged row that
// is genuinely about the TO show is safe to confirm while the rest are rejected.
const INCLUDE_FLAGGED = args.includes('--include-flagged');
const INCLUDE_OOS = args.includes('--include-oos');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(process.env.HOME || '/tmp', 'broadway-review-texts');

if (!fs.existsSync(WHITELIST)) { console.error(`Whitelist not found: ${WHITELIST}`); process.exit(1); }
if (!process.env.GEMINI_API_KEY || !process.env.OPENAI_API_KEY) {
  console.error('Both GEMINI_API_KEY and OPENAI_API_KEY are required for two-model agreement.');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(WHITELIST, 'utf8'));
const findings = Array.isArray(raw) ? raw : raw.findings;
if (!Array.isArray(findings)) { console.error('Whitelist has no findings array.'); process.exit(1); }

// Verify rows not yet confirmed/verified. By default only clean rows; opt into
// flagged and/or out-of-scope rows explicitly. Two-model agreement still gates
// every confirm, so widening the candidate set never loosens the safety bar.
const eligible = findings.filter(f =>
  (INCLUDE_FLAGGED || !f.warnings || f.warnings.length === 0)
  && (INCLUDE_OOS || !f.outOfScope)
  && f.confirm !== true
  && (REVERIFY || !f.verifierVerdict));   // prior verdicts are sticky unless --reverify

function reviewEvidence(f) {
  const p = path.join(REVIEW_TEXTS_DIR, f.from, f.file);
  if (!fs.existsSync(p)) return null;
  let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const text = r.fullText || r.reviewText || r.bwwExcerpt || r.dtliExcerpt
    || r.nycTheatreExcerpt || r.showScoreExcerpt || r.pullQuote || '';
  return {
    reviewUrl: r.url || null,           // the review's OWN url, NOT the roundup slug
    outlet: r.outlet || r.outletId || null,
    critic: r.criticName || null,
    publishDate: r.publishDate || null,
    text: String(text).replace(/\s+/g, ' ').trim().slice(0, 1800),
  };
}

function buildPrompt(f, ev) {
  const fromY = f.fromShow && f.fromShow.openingDate ? f.fromShow.openingDate.slice(0, 4) : '?';
  const toY = f.toShow && f.toShow.openingDate ? f.toShow.openingDate.slice(0, 4) : '?';
  const fromV = f.fromShow && f.fromShow.venue ? ` at ${f.fromShow.venue}` : '';
  const toV = f.toShow && f.toShow.venue ? ` at ${f.toShow.venue}` : '';
  return `You are auditing whether a theater review file is filed under the correct show.

A review is currently stored under production A. A slug matcher suggests it actually belongs to production B. Decide which production this review is ACTUALLY about, using ONLY the review's own evidence below (its URL, outlet, publish date, and text). Do NOT assume the matcher is right — it sometimes is wrong.

Production A (current location): "${f.fromShow && f.fromShow.title || f.from}" (opened ${fromY}${fromV})
Production B (matcher's suggestion): "${f.toShow && f.toShow.title || f.to}" (opened ${toY}${toV})

Review evidence:
- URL: ${ev.reviewUrl || '(none)'}
- Outlet: ${ev.outlet || '(unknown)'}
- Critic: ${ev.critic || '(unknown)'}
- Publish date: ${ev.publishDate || '(unknown)'}
- Text excerpt: ${ev.text ? `"${ev.text}"` : '(empty — rely on the URL and publish date)'}

Clues: the URL slug often names the show or a character (e.g. "07roof" = Cat on a Hot Tin Roof; "substandard_stanley" = Stanley from A Streetcar Named Desire). Character names, cast, venue, and the publish date vs each production's opening year are all evidence. If A and B are different productions of the SAME title, use the publish year to decide which run.

Respond with ONLY valid JSON, no markdown:
{"verdict": "A" | "B" | "neither" | "unclear", "confidence": "high" | "medium" | "low", "evidence": "<one sentence citing the specific clue>"}

- "A": the review is about production A (the current location is correct; do NOT move).
- "B": the review is about production B (the matcher is right; safe to move).
- "neither": about some other production/show entirely.
- "unclear": not enough evidence to decide.`;
}

function parseVerdict(s) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const v = String(j.verdict || '').toLowerCase();
    if (!['a', 'b', 'neither', 'unclear'].includes(v)) return null;
    return { verdict: v, confidence: String(j.confidence || 'low').toLowerCase(), evidence: j.evidence || '' };
  } catch { return null; }
}

async function verifyOne(f) {
  const ev = reviewEvidence(f);
  if (!ev) { f.verifierVerdict = { decision: 'source-missing' }; return 'source-missing'; }
  const prompt = buildPrompt(f, ev);
  let gem = null, oai = null;
  try { gem = parseVerdict(await callGemini(prompt)); } catch (e) { gem = { verdict: 'error', evidence: e.message }; }
  try { oai = parseVerdict(await callOpenAI(prompt)); } catch (e) { oai = { verdict: 'error', evidence: e.message }; }

  // Agreement gate: BOTH models must say "B" (the matcher's TO) at >= medium
  // confidence. Anything else stays confirm:false.
  const strong = v => v && v.verdict === 'b' && (v.confidence === 'high' || v.confidence === 'medium');
  const bothConfirmB = strong(gem) && strong(oai);
  const eitherSaysA = (gem && gem.verdict === 'a') || (oai && oai.verdict === 'a');

  let decision;
  if (bothConfirmB) decision = 'confirmed-to';
  else if (eitherSaysA) decision = 'reject-belongs-in-from';
  else decision = 'needs-human';

  f.verifierVerdict = {
    decision,
    reviewUrl: ev.reviewUrl,
    hadText: ev.text.length > 0,
    gemini: gem,
    openai: oai,
  };
  if (decision === 'confirmed-to') f.confirm = true;
  return decision;
}

async function runPool(items, worker, size) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
  return results;
}

(async () => {
  const todo = eligible.slice(0, LIMIT);
  console.log(`Verifying ${todo.length} confirm-eligible findings (2-model agreement: Gemini + GPT-4o)...`);
  const counts = {};
  let done = 0;
  await runPool(todo, async (f) => {
    const d = await verifyOne(f);
    counts[d] = (counts[d] || 0) + 1;
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${todo.length}...`);
    return d;
  }, CONCURRENCY);

  // Persist updated whitelist (confirm:true now set on confirmed-to rows).
  fs.writeFileSync(OUT, JSON.stringify(Array.isArray(raw) ? findings : { ...raw, findings, verifiedAt: new Date().toISOString() }, null, 2));

  // Human-readable report.
  const BT = String.fromCharCode(96);
  const L = ['# Slug-misroute content verification', ''];
  L.push(`Verified ${todo.length} confirm-eligible findings with 2-model agreement (Gemini + GPT-4o).`);
  L.push('A move is auto-confirmed (confirm:true) ONLY when BOTH models say the review is about');
  L.push('the matcher\'s TO show at >= medium confidence.');
  L.push('');
  for (const [k, v] of Object.entries(counts)) L.push(`- **${k}**: ${v}`);
  const groups = {
    'confirmed-to': '## ✅ CONFIRMED — both models agree, confirm:true set (safe to apply, still gated)',
    'reject-belongs-in-from': '## ❌ REJECTED — review belongs in its CURRENT show; matcher TO is wrong (do NOT move)',
    'needs-human': '## ⚠️ NEEDS HUMAN — models disagreed / unclear / neither',
    'source-missing': '## (source file missing)',
  };
  for (const [key, header] of Object.entries(groups)) {
    const rows = todo.filter(f => f.verifierVerdict && f.verifierVerdict.decision === key);
    if (!rows.length) continue;
    L.push('', header, '');
    L.push('| from | to | file | gemini | openai | evidence |');
    L.push('|---|---|---|---|---|---|');
    for (const f of rows) {
      const vv = f.verifierVerdict;
      const g = vv.gemini ? `${vv.gemini.verdict}/${vv.gemini.confidence || '?'}` : '-';
      const o = vv.openai ? `${vv.openai.verdict}/${vv.openai.confidence || '?'}` : '-';
      const evi = ((vv.openai && vv.openai.evidence) || (vv.gemini && vv.gemini.evidence) || '').replace(/\|/g, '/').slice(0, 90);
      L.push(`| ${f.from} | ${f.to} | ${BT}${f.file}${BT} | ${g} | ${o} | ${evi} |`);
    }
  }
  const reportPath = OUT.replace(/\.json$/, '') + '-verification-report.md';
  fs.writeFileSync(reportPath, L.join('\n') + '\n');

  console.log('\n=== Verification summary ===');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(26)}: ${v}`);
  console.log(`\nUpdated whitelist: ${OUT}`);
  console.log(`Report:            ${reportPath}`);
})();
