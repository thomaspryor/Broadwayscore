#!/usr/bin/env node
'use strict';

/**
 * repair-implausible-redirects.js — undo past rediscover-review-urls.js Phase 2
 * rewrites that followed a publisher redirect to an UNRELATED page.
 *
 * Phase 2 adopted any 301/302 target until 2026-09-30. Variety and The
 * Hollywood Reporter reuse numeric ids, so old review URLs redirect to other
 * articles (variety.com/2012/legit/reviews/dead-accounts-1118061665/ ->
 * /2012/film/news/better-days-for-indie-financing-1118061665/). The collector
 * then stored that page as the review's text and the ensemble flagged it
 * wrongShow, dropping ~40 real Variety/THR reviews. isPlausibleArticleRedirect
 * now refuses such redirects going forward; this sweep repairs the files that
 * were already rewritten (decision: lib/rediscovery-candidate.js
 * redirectRepairDecision).
 *
 * Per file: url goes back to the pre-redirect URL through
 * updateFileUrlWithInvariant (clears text, flags, dates and scores that came
 * from the wrong page), aggregator excerpts/stars/grades are kept (they
 * describe the real review), and `redirectRefused` queues the file for the
 * Phase 3 SERP search that finds the review's live URL. Scores are always
 * cleared (they may come from wrong-page text dropped since) and re-derived
 * from the kept excerpts.
 *
 * Usage:
 *   node scripts/repair-implausible-redirects.js            # dry run
 *   node scripts/repair-implausible-redirects.js --apply
 *   node scripts/repair-implausible-redirects.js --dir=PATH # other corpus (or REVIEW_TEXTS_DIR)
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { redirectRepairDecision, AGGREGATOR_FIELDS } = require('./lib/rediscovery-candidate');
const { updateFileUrlWithInvariant } = require('./lib/url-change-invariant');

const USAGE = `repair-implausible-redirects.js — restore review URLs that an earlier redirect-follow moved to an unrelated page, and queue them for SERP rediscovery.

Usage:
  node scripts/repair-implausible-redirects.js [--apply] [--dir=PATH]
`;

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const apply = argv.includes('--apply');
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const root = path.join(__dirname, '..');
  const dir = dirArg ? dirArg.slice(6) : (process.env.REVIEW_TEXTS_DIR || path.join(root, 'data/review-texts'));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
  const titles = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows).map((s) => [s.id, s.title]));

  let repaired = 0; let kept = 0;
  for (const showId of listShowDirs(dir)) {
    const showDir = path.join(dir, showId);
    for (const file of fs.readdirSync(showDir)) {
      if (!file.endsWith('.json') || !file.includes('--')) continue;
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (!data || data._locked) continue;
      const d = redirectRepairDecision(data, titles.get(showId));
      if (!d.repair) {
        if (d.reason) { kept++; console.log(`  keep    ${showId}/${file} (${d.reason})`); }
        continue;
      }
      const hadText = typeof data.fullText === 'string' && data.fullText.length > 0;
      console.log(`  repair  ${showId}/${file}: ${data.url} -> ${d.from} (${d.reason}${hadText ? ', wrong-page text cleared' : ''})`);
      repaired++;
      if (!apply) continue;
      // Scores are always cleared: a file with no text now may still have been
      // scored from the wrong page's text before it was dropped (review 2026-09-30).
      // The kept aggregator excerpts let the scorer re-score it.
      const preserve = new Set(AGGREGATOR_FIELDS);
      const updated = updateFileUrlWithInvariant(filePath, d.from, {
        urlDiscoveryMethod: undefined,
        urlDiscoveredAt: undefined,
        redirectRefused: { to: data.url, reason: d.reason, at: new Date().toISOString(), repairedBy: 'repair-implausible-redirects.js' },
      }, { preserveFields: preserve });
      if (!updated) console.log(`    ! not written (cross-outlet refusal or unreadable) — ${showId}/${file}`);
    }
  }
  console.log(`[repair-implausible-redirects] ${repaired} file(s) ${apply ? 'repaired' : 'to repair'}, ${kept} implausible-looking redirect(s) kept (text names the show)${apply ? '' : ' (dry run)'}`);
}

if (require.main === module) main();

module.exports = { main };
