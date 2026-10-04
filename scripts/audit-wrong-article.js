#!/usr/bin/env node
'use strict';

/**
 * Daily wrong-article audit (BRO-4383).
 *
 * Finds included + scored review files whose fullText the cheap screen
 * (lib/wrong-article-screen.js) cannot tie to the show: no cast/creative/venue
 * evidence and the title named at most once. Each suspect must have been
 * LLM-verified (Opus, not Gemini) — verified texts are recorded by content hash
 * in data/audit/wrong-article-verified.json, so an edited/replaced text
 * re-surfaces. Exit 1 on any unverified suspect = new wrong-article risk.
 *
 *   node scripts/audit-wrong-article.js              # check (CI)
 *   node scripts/audit-wrong-article.js --list       # print unverified suspects as JSON
 *   node scripts/audit-wrong-article.js --record-verified   # merge ALL current suspects into the verified baseline
 *                                                    # (only after an Opus pass over --list)
 *   node scripts/audit-wrong-article.js --adjudicate [--max=N]   # the daily LLM pass (BRO-4603, default N=20): asks
 *                                                    # Opus via content-verifier about each unverified suspect,
 *                                                    # writes data/audit/wrong-article-adjudicated.json
 *
 * A suspect is cleared by EITHER file: the manual baseline above, or a
 * 'same-show' adjudication for the same text hash. A 'wrong-article'
 * adjudication keeps failing and is printed as CONFIRMED.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { screenWrongArticle } = require('./lib/wrong-article-screen');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { adjudicateSuspects, isClearedByAdjudication, describeConfirmed } = require('./lib/wrong-article-adjudicate');

const ROOT = path.join(__dirname, '..');
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const VERIFIED_PATH = path.join(ROOT, 'data', 'audit', 'wrong-article-verified.json');
const ADJUDICATED_PATH = path.join(ROOT, 'data', 'audit', 'wrong-article-adjudicated.json');
// 20 x 40s = 13.3 min worst case, inside the workflow step's 15-minute cap.
const DEFAULT_ADJUDICATE_MAX = 20;
const CALL_TIMEOUT_MS = 40_000;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

async function runAdjudication(suspects, shows, argv) {
  const maxArg = argv.find((a) => a.startsWith('--max='));
  const parsedMax = maxArg ? Number(maxArg.slice(6)) : DEFAULT_ADJUDICATE_MAX;
  const max = Number.isFinite(parsedMax) && parsedMax >= 0 ? Math.floor(parsedMax) : DEFAULT_ADJUDICATE_MAX;
  if (max === 0) {
    console.log('wrong-article adjudication: --max=0 — skipped.');
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('wrong-article adjudication: ANTHROPIC_API_KEY not set — skipped (suspects stay unverified).');
    return 0;
  }
  const { verifyContent, callAnthropic, resolveCvMarket } = require('./lib/content-verifier');
  const { isLongRunningProduction } = require('./lib/long-runner-registry');
  const { CLAUDE_OPUS } = require('./lib/models');
  const provider = { name: CLAUDE_OPUS, call: callAnthropic(CLAUDE_OPUS, { timeoutMs: CALL_TIMEOUT_MS }) };
  const verified = readJson(VERIFIED_PATH);
  const existing = readJson(ADJUDICATED_PATH);
  const pending = suspects.filter((s) => verified[s.file] !== s.hash);
  const live = { ...existing };
  const { attempted, counts } = await adjudicateSuspects({
    suspects: pending,
    shows,
    model: CLAUDE_OPUS,
    existing,
    max,
    readReview: (file) => { try { return JSON.parse(fs.readFileSync(path.join(TEXTS, file), 'utf8')); } catch { return null; } },
    // Same argument mapping as collect-review-texts.js's verifyContent call.
    // venue-write-guard-ok: venue is prompt context for verifyContent, never written to data.
    verify: ({ review, show }) => verifyContent({
      scrapedText: review.fullText,
      excerpt: review.excerpt || null,
      showTitle: show.title,
      criticName: review.criticName || review.critic || null,
      outletName: review.outlet || review.outletId || null,
      url: review.url || null,
      venue: show.venue || null,
      openingDate: show.openingDate || null,
      publishDate: review.publishDate || null,
      market: resolveCvMarket(show),
      isLongRunningProduction: isLongRunningProduction(show),
      show,
      provider,
    }),
    log: (line) => console.log(line),
    // Persist after every verdict: a step timeout must not lose the run's work.
    onEntry: (file, entry) => {
      live[file] = entry;
      fs.writeFileSync(ADJUDICATED_PATH, JSON.stringify(live, null, 2) + '\n');
    },
  });
  console.log(`wrong-article adjudication: ${attempted} of ${pending.length} unverified suspect(s) asked (${CLAUDE_OPUS}): ${counts['same-show']} same-show, ${counts['wrong-article']} wrong-article, ${counts.unsure} unsure, ${counts.skipped} skipped → ${path.relative(ROOT, ADJUDICATED_PATH)}`);
  return 0;
}

// Whitespace-normalized so a re-fetch that only reflows the text keeps its verdict.
const hashText = (t) => crypto.createHash('sha1').update(t.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

function loadShows() {
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  return new Map((Array.isArray(parsed) ? parsed : parsed.shows).map((s) => [s.id, s]));
}

function findSuspects(textsDir, shows) {
  const out = [];
  let scanned = 0;
  for (const showId of fs.readdirSync(textsDir)) {
    const show = shows.get(showId);
    if (!show || showId.startsWith('_')) continue;
    for (const f of fs.readdirSync(path.join(textsDir, showId))) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(textsDir, showId, f), 'utf8')); } catch { continue; }
      if (!j.fullText || (j.llmScore?.score ?? j.assignedScore) == null) continue;
      let included;
      try { included = isIncludableForRebuild(j); } catch { continue; }
      if (included !== true) continue;
      scanned++;
      const r = screenWrongArticle(j.fullText, show);
      if (r.suspect) {
        out.push({ file: `${showId}/${f}`, hash: hashText(j.fullText), show: show.title, url: j.url, source: j.source, titleMentions: r.titleMentions, head: j.fullText.slice(0, 160).replace(/\s+/g, ' ') });
      }
    }
  }
  return { scanned, suspects: out };
}

async function main(argv) {
  if (require('./lib/cli-help').hasHelpFlag(argv)) {
    console.log('Usage: node scripts/audit-wrong-article.js [--list | --record-verified | --adjudicate [--max=N]]  (no flag = CI check)');
    return 0;
  }
  const shows = loadShows();
  const { scanned, suspects } = findSuspects(TEXTS, shows);
  if (argv.includes('--adjudicate')) return runAdjudication(suspects, shows, argv);
  const verified = readJson(VERIFIED_PATH);
  const adjudicated = readJson(ADJUDICATED_PATH);

  if (argv.includes('--record-verified')) {
    const next = { ...verified }; // merge: a partial checkout must never shrink the baseline
    for (const s of suspects) next[s.file] = s.hash;
    fs.writeFileSync(VERIFIED_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`recorded ${suspects.length} verified suspects → ${path.relative(ROOT, VERIFIED_PATH)}`);
    return 0;
  }

  const unverified = [];
  let cleared = 0;
  for (const s of suspects) {
    if (verified[s.file] === s.hash) continue;
    if (isClearedByAdjudication(adjudicated[s.file], s.hash)) cleared++;
    else unverified.push(s);
  }
  console.log(`wrong-article audit: scanned ${scanned} included+scored, ${suspects.length} suspects, ${cleared} cleared by LLM adjudication, ${unverified.length} unverified`);
  if (argv.includes('--list')) console.log(JSON.stringify(unverified, null, 2));
  if (unverified.length) {
    const confirmed = unverified.filter((u) => adjudicated[u.file]?.hash === u.hash && adjudicated[u.file]?.verdict === 'wrong-article');
    for (const u of confirmed) console.error(`  CONFIRMED WRONG ARTICLE ${u.file} (${u.show}): ${describeConfirmed(adjudicated[u.file])}`);
    for (const u of unverified.filter((x) => !confirmed.includes(x)).slice(0, 25)) console.error(`  UNVERIFIED ${u.file} (${u.show}, title x${u.titleMentions}, ${u.source}): ${u.head}`);
    console.error(confirmed.length
      ? 'Flag each CONFIRMED file wrongShow (data/pending-fixes plan, review-field-edit). UNVERIFIED ones get the LLM pass next run (--adjudicate).'
      : 'UNVERIFIED suspects get the LLM pass next run (--adjudicate), or run Opus over --list and --record-verified.');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
module.exports = { findSuspects, hashText };
