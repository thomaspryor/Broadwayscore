#!/usr/bin/env node
/**
 * audit-flagged-file-contamination.js (BRO-3219)
 *
 * BRO-3182 fixed findExistingReviewFile() matching a merge target purely by
 * outlet name whenever the incoming critic name was unresolved, which let an
 * unrelated review silently land inside an existing flagged (rejectionReason-
 * set) file, corrupting its criticName/url while the rejection verdict stayed
 * in place. That fix is forward-only; this script surveys the corpus's PAST
 * state for files the same loophole may already have corrupted.
 *
 * Two independent signals, ranked by confidence:
 *
 *   TIER A (byline-mismatch, high confidence): rejectionReasoning explicitly
 *   names who actually wrote the stored fullText ("the byline is also X",
 *   "essay by [role] X", "authored by X", ...), and that name doesn't match
 *   the file's own criticName. This is direct textual evidence the file's
 *   metadata and content disagree about authorship — the exact shape of the
 *   confirmed man-to-man-west-end-2026/guardian--stephen-unwin.json incident.
 *   Split into A-named (criticName already names someone else — likely a
 *   genuine merge-loophole hit) and A-unknown (criticName is Unknown — a
 *   byline-recovery opportunity, not necessarily contamination).
 *
 *   TIER B (sources-array signal, needs eyeball): rejectionReason is set AND
 *   sources has 2+ entries including a later-stage ingest source
 *   (submit-review-form/url-ingest/outlet-listing-poller) — the corpus-wide
 *   heuristic from the BRO-3219 ticket (64 hits). No name signal was found by
 *   Tier A's regex, so these need a human to read rejectionReasoning and
 *   judge whether the later source silently overwrote the original record's
 *   identity or just re-discovered the same rejection independently (normal,
 *   benign — most of these).
 *
 * Deliberately excluded: the ticket's other heuristic (rejectionReason-set +
 * named criticName + URL-swap breadcrumb, 532 hits) is noted in the ticket as
 * too broad to act on directly — URL corrections are a normal, frequent,
 * self-heal event unrelated to critic misattribution. Not reproduced here.
 *
 * Usage:
 *   node scripts/audit-flagged-file-contamination.js
 *   node scripts/audit-flagged-file-contamination.js --json > report.json
 *   node scripts/audit-flagged-file-contamination.js --show=some-show-id
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { normalizeCritic, areCriticsSimilar, isRegisteredOutlet } = require('./lib/review-normalization');
const { foldDiacritics } = require('./lib/title-match');
const { listShowDirs: listShowDirsSafe } = require('./lib/list-show-dirs');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').slice('--show='.length) || null;

const RT_DIR = resolveReviewTextsDir();

const LATE_STAGE_SOURCES = new Set(['submit-review-form', 'url-ingest', 'outlet-listing-poller']);

// Trigger phrases an LLM ensemble uses when it names the ACTUAL author of a
// misfiled essay/interview/article, distinct from asking "is this a review".
// No /i flag: NAME's [A-Z] must be a real capital, and these trigger words
// always appear lowercase mid-sentence in ensemble prose (case-insensitive
// matching let false positives like "no-byline pending strand" through in
// earlier calibration against the live corpus).
const NAME = "([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){1,2})";
const ROLE = '(?:director|playwright|producer|choreographer|performer|composer|author|' +
  'actor|actress|star|creator|lyricist|designer|translator|editor|novelist)';
const NAME_TRIGGERS = [
  new RegExp(`written by (?:the )?${ROLE}[^.(]*?\\(${NAME}\\)`),
  new RegExp(`\\bby (?:the )?${ROLE}[^.(]*?\\(${NAME}\\)`),
  new RegExp(`\\bby ${NAME},? the ${ROLE}`),
  new RegExp(`(?:essay|interview|piece|op-ed|reflection|statement|feature)s? (?:written )?by (?:the )?(?:${ROLE}\\s+)?${NAME}`),
  new RegExp(`authored by ${NAME}`),
  new RegExp(`byline is (?:also |actually |in fact )?${NAME}`),
  new RegExp(`(?:actual|real) (?:byline|author|critic) is ${NAME}`),
  new RegExp(`(?:attributed|credited) to ${NAME}`),
  new RegExp(`\\bby ${NAME} (?:reflecting|discussing|comparing|describing|writing about)`),
];

// Words that pass the [A-Z]-per-word check but are prose fragments, not
// names (found via full-corpus calibration, not guessed in the abstract).
const NAME_STOPWORDS = new Set([
  'the', 'this', 'it', 'a', 'an', 'not', 'just', 'article', 'strand', 'pending',
  'predates', 'title', 'token', 'off', 'broadway', 'west', 'end', 'public',
  'published', 'previews', 'months', 'review', 'byline', 'cross', 'attribution',
  'production', 'theatre', 'theater', 'stage', 'guardian', 'critic', 'staff',
]);

// Ship-check (Claude + Codex, both independently) found the trigger phrases
// also match ORGANIZATIONS, not just people: "essay by New York Times",
// "credited to Tony Award Winner" both pass the [A-Z]-per-word check. That's
// exactly the wrong direction for a signal meant to point a human at a
// re-attribution — a bogus org name is worse than no extraction. Reject any
// candidate that resolves to a real outlet, plus a small set of generic
// org/role words a person's name will never contain.
const ORG_WORDS = new Set([
  'times', 'news', 'verdict', 'award', 'awards', 'winner', 'team', 'desk',
  'board', 'committee', 'wire', 'press', 'media', 'group', 'network',
  'magazine', 'journal', 'gazette', 'chronicle', 'herald', 'marketing',
  'promotional', 'editorial', 'newsdesk', 'roundup', 'aggregator', 'sky',
  'playbill', 'variety', 'standard', 'telegraph', 'independent', 'observer',
]);

function looksLikeName(candidate) {
  const words = candidate.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  const ok = words.every((w) => {
    if (!/^[A-Z]/.test(w)) return false;
    // Fold diacritics BEFORE the ASCII strip (task #648/#781 structural
    // guard) — a critic name like "José" must not shred to "jos".
    const bare = foldDiacritics(w.toLowerCase()).replace(/[^a-z]/g, '');
    return bare.length > 0 && !NAME_STOPWORDS.has(bare) && !ORG_WORDS.has(bare);
  });
  if (!ok) return false;
  if (isRegisteredOutlet(candidate)) return false; // e.g. "New York Times", "Sky News"
  return true;
}

function extractNamedAuthor(reasoning) {
  if (!reasoning) return null;
  for (const re of NAME_TRIGGERS) {
    const m = reasoning.match(re);
    if (m && m[1] && looksLikeName(m[1])) return m[1].trim();
  }
  return null;
}

function criticNamesMatch(a, b) {
  if (normalizeCritic(a) === normalizeCritic(b)) return true;
  return areCriticsSimilar(a, b);
}

function listShowDirs() {
  return listShowDirsSafe(RT_DIR).filter((entry) => {
    if (showFilter && entry !== showFilter) return false;
    return true;
  });
}

function main() {
  if (!fs.existsSync(RT_DIR)) {
    console.error(`review-texts checkout not found at ${RT_DIR}`);
    process.exit(1);
  }

  const tierA = [];
  const tierB = [];
  let scanned = 0;
  let showDirsErrored = 0;
  let filesUnreadable = 0;

  for (const showId of listShowDirs()) {
    const showDir = path.join(RT_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch { showDirsErrored++; continue; }

    for (const file of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); } catch { filesUnreadable++; continue; }
      if (!data || !data.rejectionReason) continue;
      scanned++;

      const criticName = data.criticName || '';
      const criticIsReal = criticName && criticName.toLowerCase() !== 'unknown';
      const sources = Array.isArray(data.sources) ? data.sources : (data.source ? [data.source] : []);
      const sourcesHeuristicHit = sources.length >= 2 && sources.some((s) => LATE_STAGE_SOURCES.has(s));

      const extracted = extractNamedAuthor(data.rejectionReasoning);
      if (extracted && !criticNamesMatch(extracted, criticName)) {
        // Tier A is ranked above Tier B, but a file can independently satisfy
        // both — record that instead of hiding B's corroborating evidence
        // (ship-check finding: the `continue` this replaced silently dropped
        // it from the summary counts).
        tierA.push({
          tier: criticIsReal ? 'A-named' : 'A-unknown',
          show: showId,
          file,
          outlet: data.outletId || null,
          url: data.url || null,
          criticName: criticName || null,
          extractedAuthor: extracted,
          rejectionReason: data.rejectionReason,
          rejectionReasoning: data.rejectionReasoning,
          rejectedAt: data.rejectedAt || null,
          sources: data.sources || data.source || null,
          alsoMatchesSourcesHeuristic: sourcesHeuristicHit,
        });
        continue;
      }

      if (sourcesHeuristicHit) {
        tierB.push({
          tier: 'B-sources',
          show: showId,
          file,
          outlet: data.outletId || null,
          url: data.url || null,
          criticName: criticName || null,
          rejectionReason: data.rejectionReason,
          rejectionReasoning: data.rejectionReasoning,
          rejectedAt: data.rejectedAt || null,
          sources: data.sources || data.source || null,
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    reviewTextsDir: RT_DIR,
    scannedFlaggedFiles: scanned,
    showDirsErrored,
    filesUnreadable,
    tierA,
    tierB,
    summary: {
      tierANamed: tierA.filter((r) => r.tier === 'A-named').length,
      tierAUnknown: tierA.filter((r) => r.tier === 'A-unknown').length,
      tierBSources: tierB.length,
    },
  };

  if (showDirsErrored > 0 || filesUnreadable > 0) {
    console.error(`WARNING: ${showDirsErrored} show dirs and ${filesUnreadable} files could not be read/parsed — scannedFlaggedFiles undercounts the true corpus.`);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Scanned ${scanned} rejectionReason-set files in ${RT_DIR}\n`);
  console.log(`TIER A — byline-mismatch (${report.summary.tierANamed} named + ${report.summary.tierAUnknown} unknown-critic)`);
  for (const r of tierA) {
    console.log(`  [${r.tier}] ${r.show}/${r.file}`);
    console.log(`    criticName: ${r.criticName || '(none)'}  |  actual author per reasoning: ${r.extractedAuthor}`);
    console.log(`    outlet: ${r.outlet}  url: ${r.url}`);
    console.log(`    sources: ${JSON.stringify(r.sources)}  rejectedAt: ${r.rejectedAt}`);
    console.log(`    reasoning: ${(r.rejectionReasoning || '').slice(0, 220)}...`);
    console.log('');
  }

  console.log(`\nTIER B — sources-array signal, needs eyeball (${report.summary.tierBSources})`);
  for (const r of tierB) {
    console.log(`  ${r.show}/${r.file}  critic=${r.criticName || '(none)'}  sources=${JSON.stringify(r.sources)}  reason=${r.rejectionReason}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { extractNamedAuthor, criticNamesMatch, looksLikeName };
