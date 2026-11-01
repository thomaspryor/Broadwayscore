#!/usr/bin/env node
'use strict';

/**
 * Corpus sweep for multi-show blog posts (interestedbystander): files whose
 * stored fullText is the WHOLE post (several shows' reviews) get only this
 * show's section, a rescore, and — when the content verifier judged the whole
 * post and its reason names ANOTHER section's show — an automated clear of
 * that verdict so the rescore/CV re-judge the real section.
 *
 * Found 2026-09-29: 34 of 40 interestedbystander files held the whole post
 * (e.g. sunset-boulevard-2024 was flagged wrongShow because the CV read the
 * DRAG / Mama I'm a Big Girl Now reviews that precede "Sunset Blvd"). The
 * write-time gate is isolateMultiShowSection() in every collector path; this
 * sweep repairs what was stored before it existed. Idempotent: an isolated
 * section has < 2 headings, so a second run finds nothing.
 *
 * --refetch (BRO-6742): also re-fetch the post for flagged files whose stored
 * text is empty or already one section (stored before this gate existed, then
 * rejected on the whole post: every-brilliant-thing-2026 was judged on the
 * "Giant" section of the same post). The verdict is cleared and the section
 * stored only when the verdict named another section's show (planRefetchedIsolation).
 *
 * Usage:
 *   node scripts/isolate-multi-show-sections.js [--apply] [--refetch] [--dir=PATH] [--show=ID]
 *     (default dry run; --dir or REVIEW_TEXTS_DIR selects the corpus)
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help');
const { planIsolation, planRefetchedIsolation, needsRefetch } = require('./lib/multi-show-isolation-plan');
const { findSectionHeadings } = require('./lib/multi-show-section-extract');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = 'Usage: node scripts/isolate-multi-show-sections.js [--apply] [--refetch] [--dir=PATH] [--show=ID] [--deadline-sec=N]';

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const apply = argv.includes('--apply');
  const refetch = argv.includes('--refetch');
  const postCache = new Map();
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const showArg = argv.find((a) => a.startsWith('--show='));
  const dir = dirArg ? dirArg.slice(6) : (process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts'));
  const onlyShow = showArg ? showArg.slice(7) : null;
  // --deadline-sec: stop starting new refetches after N seconds so a caller with a
  // hard kill (execute-approved-fix run-script, 5 min) ends cleanly; skipped files
  // are listed and simply wait for the next run.
  const deadlineArg = argv.find((a) => a.startsWith('--deadline-sec='));
  const deadlineAt = deadlineArg ? Date.now() + Number(deadlineArg.slice(15)) * 1000 : Infinity;
  let skippedForDeadline = 0;
  const at = new Date().toISOString();
  let changed = 0; let refused = 0;
  // listShowDirs: a dangling symlink must not crash the daily scheduled run.
  for (const showId of listShowDirs(dir)) {
    if (showId[0] === '_' || showId[0] === '.' || (onlyShow && showId !== onlyShow)) continue;
    const showDir = path.join(dir, showId);
    for (const file of fs.readdirSync(showDir)) {
      if (!isReviewTextFile(file)) continue;
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      let plan = planIsolation(data, showId, at);
      if (!plan && refetch && needsRefetch(data) && Date.now() > deadlineAt) {
        skippedForDeadline++;
        console.log(`  skip    ${showId}/${file} (deadline reached; next run)`);
        continue;
      }
      if (!plan && refetch && needsRefetch(data)) {
        const post = await fetchPostText(data.url, postCache);
        plan = post ? planRefetchedIsolation(data, showId, post, at) : null;
        if (!plan) {
          const why = !post ? 'fetch failed'
            : findSectionHeadings(post).length < 2 ? 'refetched post has no section headings'
              : 'no unique section, or verdict does not quote another section\'s title';
          console.log(`  keep    ${showId}/${file} (refetched: ${why})`);
          continue;
        }
      }
      if (!plan) continue;
      if (plan.refused) { refused++; console.log(`  refuse  ${showId}/${file} (no unique section for this show — left as is)`); continue; }
      changed++;
      console.log(`  isolate ${showId}/${file}: ${plan.from} -> ${plan.to} chars${plan.clearedFlags.length ? `; cleared ${plan.clearedFlags.join('+')}` : ''}`);
      if (apply) safeWriteReview(filePath, plan.data, { force: true, merge: false });
    }
  }
  if (skippedForDeadline) console.log(`[isolate-multi-show-sections] ${skippedForDeadline} refetch(es) skipped at the deadline`);
  console.log(`[isolate-multi-show-sections] ${changed} file(s) ${apply ? 'rewritten' : 'would be rewritten'}, ${refused} left (no unique section)${apply ? '' : ' (dry run)'}`);
}

/**
 * The post as plain text, run through the same storage pre-clean the collector
 * applies (extractor + preCleanForStorage). Not byte-identical to the
 * collector's Playwright path; isolation only needs the photo-credit headings,
 * and a post where they are lost is kept unchanged (logged).
 */
async function fetchPostText(url, cache) {
  const key = String(url).split('?')[0];
  if (cache.has(key)) return cache.get(key);
  let text = null;
  try {
    const { fetchPage } = require('./lib/scraper');
    const { extractArticleText } = require('./lib/article-extractor');
    const { preCleanForStorage } = require('./lib/stored-text-form');
    const res = await fetchPage(key);
    const raw = res && res.format === 'html' ? extractArticleText(res.content, new URL(key).hostname) : (res && res.content);
    text = typeof raw === 'string' && raw.trim() ? preCleanForStorage(raw) : null;
  } catch (e) { console.log(`  fetch failed ${key}: ${e.message}`); }
  cache.set(key, text);
  return text;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
