#!/usr/bin/env node
/**
 * reverify-with-haiku.js
 *
 * One-off retro-reverification. The content-verifier primary was switched
 * from Gemini Flash to Claude Haiku 4.5 on 2026-04-15 (commit 6b4811d046)
 * after model sweep showed 20% FP rate with Haiku vs 87% with Gemini.
 * Existing 9,147 reviews were verified under the old chain — many have
 * undetected wrongProduction/wrongArticle garbage blessed as valid.
 *
 * This script re-runs contentVerification on reviews previously verified
 * by llm:gemini or llm:openai (pre-Haiku primary) and replaces the
 * contentVerification block with the new Haiku result.
 *
 * SAFETY:
 *   - --dry-run (default) shows what would change without writing
 *   - --limit=N caps the run (start with --limit=200 for sanity)
 *   - Only re-verifies reviews already marked isValid:true by the old LLM —
 *     those are the candidates for "bless-garbage" failures. Reviews already
 *     marked invalid stay invalid.
 *   - Preserves original contentVerification in a new field
 *     `contentVerificationPrev` so reverts are possible.
 *   - Does NOT modify top-level wrongProduction / wrongShow flags — only the
 *     contentVerification block. Downstream scoring uses the flags, so
 *     human review is still the gate before those change.
 *
 * Usage:
 *   node scripts/reverify-with-haiku.js --dry-run --limit=200
 *   node scripts/reverify-with-haiku.js --live --limit=500
 *   node scripts/reverify-with-haiku.js --live    # full run
 *
 * Env: requires ANTHROPIC_API_KEY for Haiku.
 */

const fs = require('fs');
const path = require('path');
const { verifyContent } = require('./lib/content-verifier');

const BASE = 'data/review-texts';

const args = process.argv.slice(2);
const CLI = {
  live: args.includes('--live'),
  limit: parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0,
  concurrency: parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 5,
  show: (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '',
};
const DRY_RUN = !CLI.live;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — cannot run Haiku re-verification.');
  process.exit(1);
}

// Load shows.json for metadata (openingDate, venue, market)
const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
const showsMap = new Map();
for (const s of (showsData.shows || showsData)) showsMap.set(s.id, s);

// Scan review-texts for reverification candidates
function scanCandidates() {
  const items = [];
  const dirs = fs.readdirSync(BASE).filter(d => !d.startsWith('.'));
  for (const showId of dirs) {
    if (CLI.show && showId !== CLI.show) continue;
    const dir = path.join(BASE, showId);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); }
    catch { continue; }
    for (const file of files) {
      const filePath = path.join(dir, file);
      let r;
      try { r = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }

      const cv = r.contentVerification;
      // Target: LLM-verified with valid=true, NOT already verified by Haiku
      if (!cv) continue;
      if (!cv.verifiedBy || !cv.verifiedBy.startsWith('llm:')) continue;
      if (cv.verifiedBy.includes('haiku')) continue; // already done
      if (cv.isValid !== true) continue; // only retest blessed content
      if (!r.fullText || r.fullText.length < 200) continue;

      items.push({ showId, file, filePath, review: r });
    }
  }
  return items;
}

function buildVerifyInput(showId, r) {
  const show = showsMap.get(showId);
  return {
    scrapedText: r.fullText,
    excerpt: r.dtliExcerpt || r.bwwExcerpt || r.showScoreExcerpt || '',
    showTitle: show?.title || showId,
    outletName: r.outlet || r.outletId || '',
    criticName: r.criticName || '',
    openingDate: show?.openingDate || '',
    publishDate: r.publishDate || '',
    venue: show?.venue || '',
    market: show?.type === 'opera' ? 'opera' : (show?.category || 'broadway'),
    // Pass show metadata so applyTemporalOverrides can fire the named-entity bypass
    // (Hamlet 2026-05-08 FRC class). Critical for backfill flows: without `show`,
    // historical FPs of the FRC class won't get re-classified during reverify.
    show: show || null,
  };
}

function diffSummary(oldCv, newCv) {
  const oldFlags = {
    isValid: oldCv.isValid,
    wrongArticle: !!oldCv.wrongArticle,
    wrongProduction: !!oldCv.wrongProduction,
    isFilmTv: !!oldCv.isFilmTv,
    truncated: !!oldCv.truncated,
  };
  const newFlags = {
    isValid: newCv.isValid,
    wrongArticle: !!newCv.wrongArticle,
    wrongProduction: !!newCv.wrongProduction,
    isFilmTv: !!newCv.isFilmTv,
    truncated: !!newCv.truncated,
  };
  const changed = Object.keys(oldFlags).filter(k => oldFlags[k] !== newFlags[k]);
  return { oldFlags, newFlags, changed };
}

async function processOne(item, stats) {
  const { showId, file, filePath, review } = item;
  try {
    const input = buildVerifyInput(showId, review);
    const newCv = await verifyContent(input);
    const { oldFlags, newFlags, changed } = diffSummary(review.contentVerification, newCv);

    stats.total++;
    if (changed.length > 0) {
      stats.changed++;
      stats.changesByFlag = stats.changesByFlag || {};
      for (const k of changed) {
        const key = `${k}:${oldFlags[k]}→${newFlags[k]}`;
        stats.changesByFlag[key] = (stats.changesByFlag[key] || 0) + 1;
      }
      // Pull out escalations (new flags raised)
      if (newCv.wrongProduction && !review.contentVerification.wrongProduction) stats.newlyFlaggedWrongProduction++;
      if (newCv.wrongArticle && !review.contentVerification.wrongArticle) stats.newlyFlaggedWrongArticle++;
      if (newCv.isValid === false && review.contentVerification.isValid === true) stats.flippedValidToInvalid++;
      if (stats.changeSamples.length < 20) {
        stats.changeSamples.push({
          file: `${showId}/${file}`,
          oldFlags, newFlags, changed,
          reasoning: (newCv.reasoning || '').slice(0, 180),
        });
      }
    } else {
      stats.unchanged++;
    }

    if (!DRY_RUN && changed.length > 0) {
      // Preserve old CV for rollback
      review.contentVerificationPrev = review.contentVerification;
      review.contentVerification = { ...newCv, verifiedAt: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
    }

    return { ok: true, changed: changed.length > 0 };
  } catch (err) {
    stats.errors++;
    if (stats.errorSamples.length < 5) {
      stats.errorSamples.push({ file: `${showId}/${file}`, error: err.message });
    }
    return { ok: false, error: err.message };
  }
}

async function run() {
  const startTime = Date.now();
  console.log(`Scanning ${BASE}/ …`);
  const items = scanCandidates();
  console.log(`Found ${items.length} reviews previously verified by llm:gemini/llm:openai as isValid=true.`);
  const pool = CLI.limit > 0 ? items.slice(0, CLI.limit) : items;
  console.log(`${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'} — processing ${pool.length} (concurrency=${CLI.concurrency})`);

  const stats = {
    total: 0,
    changed: 0,
    unchanged: 0,
    errors: 0,
    newlyFlaggedWrongProduction: 0,
    newlyFlaggedWrongArticle: 0,
    flippedValidToInvalid: 0,
    changeSamples: [],
    errorSamples: [],
  };

  let idx = 0;
  let lastPrinted = 0;
  async function worker() {
    while (idx < pool.length) {
      const i = idx++;
      await processOne(pool[i], stats);
      if (i - lastPrinted >= 50) {
        lastPrinted = i;
        const pct = ((i / pool.length) * 100).toFixed(1);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stderr.write(`[${i}/${pool.length} ${pct}%] changed=${stats.changed} flipped=${stats.flippedValidToInvalid} elapsed=${elapsed}s\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: CLI.concurrency }, () => worker()));

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n' + '='.repeat(60));
  console.log(`${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'} complete in ${elapsed}s`);
  console.log('='.repeat(60));
  console.log(`Total processed:             ${stats.total}`);
  console.log(`  no-change:                 ${stats.unchanged}`);
  console.log(`  changed:                   ${stats.changed}`);
  console.log(`  errors:                    ${stats.errors}`);
  console.log(`\nEscalations (old missed what Haiku catches):`);
  console.log(`  flipped valid → invalid:   ${stats.flippedValidToInvalid}`);
  console.log(`  newly flagged wrongProd:   ${stats.newlyFlaggedWrongProduction}`);
  console.log(`  newly flagged wrongArticle:${stats.newlyFlaggedWrongArticle}`);

  if (stats.changesByFlag) {
    console.log(`\nFlag transition counts:`);
    for (const [k, v] of Object.entries(stats.changesByFlag).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(40)} ${v}`);
    }
  }

  if (stats.changeSamples.length > 0) {
    console.log(`\nSample changes (up to 20):`);
    for (const s of stats.changeSamples) {
      console.log(`\n  ${s.file}`);
      console.log(`    changed: ${s.changed.join(', ')}`);
      console.log(`    old:     ${JSON.stringify(s.oldFlags)}`);
      console.log(`    new:     ${JSON.stringify(s.newFlags)}`);
      console.log(`    why:     ${s.reasoning}`);
    }
  }

  if (stats.errorSamples.length > 0) {
    console.log(`\nError samples:`);
    for (const s of stats.errorSamples) console.log(`  ${s.file}: ${s.error}`);
  }

  if (DRY_RUN) {
    console.log(`\n(DRY RUN — no files written. Re-run with --live to apply.)`);
  } else {
    console.log(`\n(LIVE — ${stats.changed} files updated. Each has contentVerificationPrev backup for rollback.)`);
  }
}

run().catch(err => { console.error(err); process.exit(2); });
