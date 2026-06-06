#!/usr/bin/env node
/**
 * Pre-share audit: verify every review about to be shared with creators.
 *
 * Two checks:
 *   A. Embarrassment check — for each PUBLISHED review, Opus re-verifies the
 *      transcript actually reviews the claimed show. Flags casting news, reply
 *      videos, multi-show roundups, film adaptations, wrong production.
 *   B. Completeness check — for each classified-as-review transcript that
 *      DIDN'T make the site, Opus re-verifies the rejection was correct. Flags
 *      real reviews that were wrongly dropped.
 *
 * Output: data/audit/video-review-audit.json with KEEP / REMOVE / RECOVER /
 * REVIEW_MANUALLY verdicts + brief reasons. Nothing is changed automatically —
 * the user reviews the report and we act on its recommendations.
 *
 * Usage:
 *   node scripts/video-reviews/audit-before-share.js
 *   node scripts/video-reviews/audit-before-share.js --side=A     # just embarrassment check
 *   node scripts/video-reviews/audit-before-share.js --side=B     # just completeness
 *   node scripts/video-reviews/audit-before-share.js --limit=10   # smoke test
 */

const fs = require('fs');
const path = require('path');
const { GPT4O, CLAUDE_OPUS } = require('../lib/models');

const ROOT = path.resolve(__dirname, '../..');
const REVIEWS_PATH = path.join(ROOT, 'data/video-reviews.json');
const SHOWS_PATH = path.join(ROOT, 'data/shows.json');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data/video-reviews-transcripts');
const CLASSIFIED_DIR = path.join(TRANSCRIPTS_DIR, 'classified');
const OUT_PATH = path.join(ROOT, 'data/audit/video-review-audit.json');

// Auditor defaults to GPT-4o — an independent second opinion on Opus's work.
// Set AUDIT_PROVIDER=anthropic + AUDIT_MODEL=claude-opus-4-7 to run with Opus
// (useful for cross-check or if OpenAI is down).
const AUDIT_PROVIDER = process.env.AUDIT_PROVIDER || 'openai';
const MODEL = process.env.AUDIT_MODEL || (AUDIT_PROVIDER === 'openai' ? GPT4O : CLAUDE_OPUS);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (AUDIT_PROVIDER === 'openai' && !OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }
if (AUDIT_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const SIDE = process.argv.find(a => a.startsWith('--side='))?.split('=')[1] || 'both';
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');

const AUDIT_PROMPT = `You are auditing a video transcript before it gets published on a Broadway scorecard site as a review of a specific live stage production. Creators trust us to only publish their actual first-hand reviews. If we publish a casting announcement, a reply-to-comments video, a movie review, or a roundup as a "review," they will be embarrassed.

Given a transcript and the show it's been assigned to, answer ONE question: is this a first-hand review of the SPECIFIC live stage production, written as a standalone video where the creator saw the show and gives their substantive opinion?

REJECT if ANY is true:
- Reviews the FILM/MOVIE adaptation, not the stage production (e.g. Wicked 2024 movie rather than stage)
- Casting announcement / news reaction ("they just announced X is joining")
- Reply or follow-up video to a previous one (primary purpose is responding to comments, not reviewing)
- Roundup/list covering 3+ shows with no single focus
- Creator discusses the show but never SAW this production (no past-tense attendance or before-and-after structure)
- Reviews a DIFFERENT production than the one assigned (wrong tour, wrong city, wrong revival year)

ACCEPT if:
- Creator attended and shares substantive opinion on the production (past-tense, before-and-after, or first-preview reaction all count)
- Present-tense critique works if the creator clearly saw it ("the staging is brilliant" after explaining they saw it)

Bias toward REJECT when uncertain. The embarrassment of publishing a non-review is worse than missing one.

Output JSON: {"verdict": "KEEP" | "REMOVE" | "REVIEW_MANUALLY", "confidence": "high"|"medium"|"low", "reason": "<one sentence — what in the transcript drove the verdict>"}`;

async function callAnthropic(user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: AUDIT_PROMPT, messages: [{ role: 'user', content: user }] })
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return data.content[0].text;
}

async function callOpenAI(user) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AUDIT_PROMPT },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function auditOne(transcript, showTitle) {
  const user = `Show: ${showTitle}\nCreator: ${transcript.creatorId}\nPlatform: ${transcript.platform}\nTitle: "${transcript.title || ''}"\n\nTranscript:\n---\n${transcript.transcript}\n---`;
  const text = AUDIT_PROVIDER === 'openai' ? await callOpenAI(user) : await callAnthropic(user);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON: ' + text.substring(0, 200));
  return JSON.parse(m[0]);
}

function loadShowMap() {
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const m = new Map();
  for (const s of shows) if (s?.id) m.set(s.id, s.title);
  return m;
}

async function sideA(showMap) {
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const shows = Object.keys(reviews).filter(k => k !== '_meta');
  const results = [];
  const entries = [];
  for (const showId of shows) {
    for (const r of reviews[showId]) entries.push({ showId, handle: r.handle, score: r.score });
  }
  const workingSet = LIMIT > 0 ? entries.slice(0, LIMIT) : entries;
  console.log(`[A] Auditing ${workingSet.length} published reviews...`);

  for (const [i, e] of workingSet.entries()) {
    const showDirFile = path.join(TRANSCRIPTS_DIR, e.showId, e.handle + '.json');
    if (!fs.existsSync(showDirFile)) {
      results.push({ ...e, verdict: 'MISSING_TRANSCRIPT' });
      continue;
    }
    const t = JSON.parse(fs.readFileSync(showDirFile, 'utf8'));
    const showTitle = showMap.get(e.showId) || e.showId;
    process.stdout.write(`  [${i + 1}/${workingSet.length}] ${e.showId}/${e.handle} ... `);
    try {
      const v = await auditOne(t, showTitle);
      console.log(`${v.verdict} (${v.confidence})`);
      results.push({ ...e, ...v });
    } catch (err) {
      console.log('ERROR', err.message);
      results.push({ ...e, verdict: 'ERROR', reason: err.message });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

async function sideB(showMap) {
  // For each classified-as-review pair with valid showId that is NOT on the site,
  // sample-verify whether it should have been kept.
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const onSite = new Set();
  for (const [sid, arr] of Object.entries(reviews)) {
    if (sid === '_meta') continue;
    for (const r of arr) onSite.add(r.handle + '|' + sid);
  }

  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const validShowIds = new Set(shows.map(s => s.id));
  const classifiedFiles = fs.readdirSync(CLASSIFIED_DIR).filter(f => f.endsWith('.json'));
  const missing = [];
  const seenPairs = new Set();
  for (const f of classifiedFiles) {
    const c = JSON.parse(fs.readFileSync(path.join(CLASSIFIED_DIR, f)));
    if (c.reviewType !== 'review' || !c.showId) continue;
    if (!validShowIds.has(c.showId)) continue;
    const key = c.creatorId + '|' + c.showId;
    if (onSite.has(key)) continue;
    if (seenPairs.has(key)) continue; // dedupe across multiple videos per pair
    seenPairs.add(key);

    const showDirFile = path.join(TRANSCRIPTS_DIR, c.showId, c.creatorId + '.json');
    if (!fs.existsSync(showDirFile)) {
      missing.push({ showId: c.showId, handle: c.creatorId, hiddenReason: 'not-in-show-dir' });
      continue;
    }
    const t = JSON.parse(fs.readFileSync(showDirFile));
    const hiddenReason = t.wrongProduction === true ? 'wrongProduction'
      : t.scoreable === false ? 'scoreable:false'
      : t.score === undefined ? 'no-score'
      : 'below-floor-or-other';
    missing.push({ showId: c.showId, handle: c.creatorId, hiddenReason });
  }

  const workingSet = LIMIT > 0 ? missing.slice(0, LIMIT) : missing;
  console.log(`[B] Auditing ${workingSet.length} classified-but-hidden pairs...`);

  const results = [];
  for (const [i, e] of workingSet.entries()) {
    const showDirFile = path.join(TRANSCRIPTS_DIR, e.showId, e.handle + '.json');
    if (!fs.existsSync(showDirFile)) {
      results.push({ ...e, verdict: 'MISSING_TRANSCRIPT' });
      continue;
    }
    const t = JSON.parse(fs.readFileSync(showDirFile));
    const showTitle = showMap.get(e.showId) || e.showId;
    process.stdout.write(`  [${i + 1}/${workingSet.length}] ${e.showId}/${e.handle} (${e.hiddenReason}) ... `);
    try {
      const v = await auditOne(t, showTitle);
      // On side B, "KEEP" means the transcript IS a legit review → should recover
      const recovered = v.verdict === 'KEEP' ? 'RECOVER' : v.verdict;
      console.log(`${recovered} (${v.confidence})`);
      results.push({ ...e, ...v, verdict: recovered });
    } catch (err) {
      console.log('ERROR', err.message);
      results.push({ ...e, verdict: 'ERROR', reason: err.message });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

async function main() {
  const showMap = loadShowMap();
  const report = { generatedAt: new Date().toISOString(), model: MODEL, sideA: null, sideB: null };
  if (SIDE === 'A' || SIDE === 'both') report.sideA = await sideA(showMap);
  if (SIDE === 'B' || SIDE === 'both') report.sideB = await sideB(showMap);

  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);

  // Summary
  if (report.sideA) {
    const byV = {};
    for (const r of report.sideA) byV[r.verdict] = (byV[r.verdict] || 0) + 1;
    console.log('\nSide A (published):', byV);
    const toRemove = report.sideA.filter(r => r.verdict === 'REMOVE');
    if (toRemove.length) {
      console.log('\nREMOVE candidates:');
      for (const r of toRemove.slice(0, 30)) console.log(`  ${r.showId}/${r.handle}: ${r.reason}`);
    }
  }
  if (report.sideB) {
    const byV = {};
    for (const r of report.sideB) byV[r.verdict] = (byV[r.verdict] || 0) + 1;
    console.log('\nSide B (hidden):', byV);
    const toRecover = report.sideB.filter(r => r.verdict === 'RECOVER');
    if (toRecover.length) {
      console.log('\nRECOVER candidates:');
      for (const r of toRecover.slice(0, 30)) console.log(`  ${r.showId}/${r.handle} (${r.hiddenReason}): ${r.reason}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
