#!/usr/bin/env node
/**
 * Backfill aggregatorStars on lbo-individual review files where it's missing.
 *
 * Root cause: extractIndividualReviewFromLBO() previously hardcoded stars=null
 * (fixed 2026-04-26). Existing files ingested before the fix have no stars
 * field even though the source LBO page has a `class="bstarsN"` rating.
 *
 * Strategy:
 *   1. Walk data/review-texts/{show}/london-box-office--*.json
 *   2. For each lbo-individual file with a real LBO URL and no aggregatorStars,
 *      fetch the page and extract bstarsN.
 *   3. Write canonical aggregatorStars="X/5" + scoreSource="lbo-css-stars"
 *      + originalScoreNormalized.
 *   4. Do NOT set humanReviewScore — let rebuild handle scoring with the
 *      now-correct aggregator data.
 *
 * Use: node scripts/backfill-lbo-individual-stars.js [--dry-run] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { isRoundupUrl } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-lbo-individual-stars.js — backfill aggregatorStars on lbo-individual review files.

Usage:
  node scripts/backfill-lbo-individual-stars.js [--dry-run] [--limit N]
  node scripts/backfill-lbo-individual-stars.js --help, -h    print this usage and exit
`;

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// NOT migrated to scripts/lib/review-texts-dir.js (task #1749): unlike the
// other review-texts scripts, this one deliberately scans AND WRITES BOTH
// clones every run (see selectCandidate() below) rather than picking a single
// default — the "stale legacy default" bug class does not apply here. The
// main-repo path is hardcoded absolute so it always resolves to the real
// checkout regardless of cwd/worktree, unlike the bare `os.homedir()` default
// the other scripts had.
// `private: true` marks the source-of-truth repo — see selectCandidate().
const REVIEW_TEXTS_DIRS = [
  { dir: '/Users/tompryor/Broadwayscore/data/review-texts', private: false },
  { dir: '/Users/tompryor/broadway-review-texts', private: true },
];

// Pure predicate so the private-repo-wins rule is unit-testable without fs.
// The private repo is authoritative (see file header); a candidate found
// there must win over one found earlier in main-repo scan order.
function selectCandidate(existing, incoming) {
  if (!existing) return incoming;
  if (incoming.private && !existing.private) return incoming;
  return existing;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractStars(html) {
  const m = html && html.match(/class="[^"]*\bbstars(\d)\b[^"]*"/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 5) ? n : null;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  // Dedupe candidates by showId+filename across both dirs. Both dirs are
  // scanned (main repo copy may lag the private repo's most current URL),
  // but selectCandidate() always prefers the private-repo entry regardless
  // of scan order — the private repo is source of truth.
  const candidates = new Map();
  for (const { dir: baseDir, private: isPrivate } of REVIEW_TEXTS_DIRS) {
    if (!fs.existsSync(baseDir)) continue;
    for (const showDir of fs.readdirSync(baseDir)) {
      const fullDir = path.join(baseDir, showDir);
      let stat; try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const lboFiles = fs.readdirSync(fullDir).filter(f => f.startsWith('london-box-office'));
      for (const f of lboFiles) {
        const fp = path.join(fullDir, f);
        let d; try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        // `source` is only the LAST writer to touch the file; the full
        // provenance lives in `sources[]`. 30 first-party LBO bylines carry
        // 'lbo-individual' there under a different primary source, and this
        // scalar-only check skipped every one of them — the same gap the
        // getBestScore exemption had (audit 2026-08-02, see rebuild-helpers.js
        // isLBOFirstParty). Star backfill must see them too.
        const sources = Array.isArray(d.sources) ? d.sources : [];
        if (d.source !== 'lbo-individual' && !sources.includes('lbo-individual')) continue;
        if (!d.url || !d.url.includes('londonboxoffice.co.uk')) continue;
        // `sources[]` is append-only history, so widening the filter above also
        // admits files that were later merged with an LBO ROUNDUP. Backfilling
        // a roundup page's headline star into aggregatorStars would hand the
        // scoring engine a relayed aggregate dressed as a critic's rating.
        // Gate on the current URL, same content-identity check getBestScore's
        // isLBOFirstParty uses.
        if (isRoundupUrl(d.url).isRoundup) continue;
        if (d.aggregatorStars) continue;
        const key = `${showDir}/${f}`;
        candidates.set(key, selectCandidate(candidates.get(key), { showDir, file: f, url: d.url, private: isPrivate }));
      }
    }
  }

  const list = Array.from(candidates.values()).slice(0, LIMIT);
  console.log(`Found ${candidates.size} lbo-individual files missing aggregatorStars (processing ${list.length})`);
  console.log();

  let updated = 0, noStars = 0, fetchFailed = 0;
  for (const { showDir, file, url } of list) {
    process.stdout.write(`${showDir}/${file} ... `);
    let html;
    try { html = await fetchHtml(url); } catch (e) { html = null; }
    if (!html) { console.log('FETCH FAILED'); fetchFailed++; continue; }
    const stars = extractStars(html);
    if (stars === null) { console.log('no bstarsN class'); noStars++; continue; }

    // Update both dirs (main repo + private repo)
    for (const { dir: baseDir } of REVIEW_TEXTS_DIRS) {
      const fp = path.join(baseDir, showDir, file);
      if (!fs.existsSync(fp)) continue;
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      d.aggregatorStars = `${stars}/5`;
      d.scoreSource = 'lbo-css-stars';
      // aggregatorStars is the canonical field rebuild-helpers.js's
      // getBestScore() reads for aggregator scoreSource (never
      // originalScoreNormalized) — see effectiveOriginalScore. If the file
      // already carries a legacy non-null originalScore, safeWriteReview's
      // own aggregator-contamination guard nulls originalScoreNormalized
      // back out after this write (originalScore is a PROTECTED_FIELD, so
      // clearing it here would just get restored by the merge); that's the
      // guard's documented, corpus-wide invariant and does not affect scoring.
      d.originalScoreNormalized = Math.round((stars / 5) * 100);
      d._notes = (d._notes || '') + `[2026-04-26 backfilled aggregatorStars=${stars}/5 from LBO page (extractor previously hardcoded null)] `;
      if (!DRY_RUN) safeWriteReview(fp, d, { merge: true });
    }
    console.log(`${stars}/5`);
    updated++;

    // Polite rate limit
    await new Promise(r => setTimeout(r, 800));
  }

  console.log();
  console.log(`Updated: ${updated}, No bstarsN: ${noStars}, Fetch failed: ${fetchFailed}`);
  if (DRY_RUN) console.log('(dry run — no files written)');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { selectCandidate, main };
