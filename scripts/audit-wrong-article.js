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
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { screenWrongArticle } = require('./lib/wrong-article-screen');
const { isIncludableForRebuild } = require('./lib/review-guards');

const ROOT = path.join(__dirname, '..');
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const VERIFIED_PATH = path.join(ROOT, 'data', 'audit', 'wrong-article-verified.json');

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

function main(argv) {
  const { scanned, suspects } = findSuspects(TEXTS, loadShows());
  let verified = {};
  try { verified = JSON.parse(fs.readFileSync(VERIFIED_PATH, 'utf8')); } catch { /* none yet */ }

  if (argv.includes('--record-verified')) {
    const next = { ...verified }; // merge: a partial checkout must never shrink the baseline
    for (const s of suspects) next[s.file] = s.hash;
    fs.writeFileSync(VERIFIED_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`recorded ${suspects.length} verified suspects → ${path.relative(ROOT, VERIFIED_PATH)}`);
    return 0;
  }

  const unverified = suspects.filter((s) => verified[s.file] !== s.hash);
  console.log(`wrong-article audit: scanned ${scanned} included+scored, ${suspects.length} suspects, ${unverified.length} unverified`);
  if (argv.includes('--list')) console.log(JSON.stringify(unverified, null, 2));
  if (unverified.length) {
    for (const u of unverified.slice(0, 25)) console.error(`  UNVERIFIED ${u.file} (${u.show}, title x${u.titleMentions}, ${u.source}): ${u.head}`);
    console.error('Run Opus over --list, flag real wrong articles wrongShow, then --record-verified.');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { findSuspects, hashText };
