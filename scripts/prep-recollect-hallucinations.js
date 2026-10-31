#!/usr/bin/env node

/**
 * prep-recollect-hallucinations.js
 *
 * Before running collect-review-texts.js on the quarantined hallucination files,
 * we need to unset showNotMentioned so the script treats them as normal
 * "needs rescrape" files instead of routing them through URL-discovery (which
 * is rightly gated for garbage-producing URLs).
 *
 * Now that scripts/collect-review-texts.js has a write-path keyword gate via
 * checkLlmVerificationAgainstKeywords(), re-fetching the original URL is safe:
 * if the content is still garbage, the gate will quarantine it again.
 *
 * Target set: union of
 *   A) the 15 reverted files from Notion card 33f637c5-416f-8194-9d6c-ff5d2f567ea4
 *   B) the 16 files newly quarantined by apply-llm-hallucination-fix.js
 *     minus RoI/thestage (legit false positive, kept as-is)
 *
 * Action per file:
 *   - showNotMentioned: undefined (deleted)
 *   - _showNotMentionedDiscoveryAttempted: undefined (deleted)
 *   - suspectedLlmHallucination: undefined (deleted; will be re-set if still bad)
 *   - contentTier: 'needs-rescrape' (keep)
 *   - wrongFullText: preserved (safety backup)
 *   - needsReview: kept true (caller will clear on successful re-collect)
 *   - fullText: kept null (so queue sees it as incomplete)
 *   - assignedScore: preserved (until rebuild decides what to do)
 *
 * Usage:
 *   node scripts/prep-recollect-hallucinations.js          # dry run
 *   node scripts/prep-recollect-hallucinations.js --apply  # write
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');

const TARGETS = [
  // 15 reverted files (card 33f637c5-416f-8194-9d6c-ff5d2f567ea4)
  'an-act-of-god-2016/wsj--terry-teachout.json',
  'choir-boy-2019/out-magazine--trevell-anderson.json',
  'escape-to-margaritaville-2018/bloomberg--chris-rovzar.json',
  'hamilton-2015/chicagotribune--chris-jones.json',
  'ink-2019/thestage--naveen-kumar.json',
  'lucky-guy-2013/backstage--erik-haagensen.json',
  'memphis-2009/variety--charles-isherwood.json',
  'rent-1996/newyorker--john-lahr-1996.json',
  'starlight-express-west-end-2024/thestage--paul-vale.json',
  'sweat-2017/axscom--kyle-osborne.json',
  'the-importance-of-being-earnest-2011/bloomberg--jeremy-gerard.json',
  'the-kite-runner-2022/thewrap--robert-hofler.json',
  'the-scottsboro-boys-2010/time--richard-zoglin.json',
  'time-stands-still-2010/bloomberg--john-simon.json',
  'women-on-the-verge-of-a-nervous-breakdown-2010/backstage--erik-haagensen.json',
  // 6 NEW from apply-llm-hallucination-fix (not already in the reverted list)
  'here-lies-love-2023/talkinbroadway--matthew-murray.json',
  'the-last-ship-2014/talkinbroadway--matthew-murray.json',
  'the-peewee-herman-show-2010/ap--david-rooney.json',
  'wit-2012/bloomberg--jeremy-gerard.json',
  'wit-2012/usatoday--elysa-gardner.json',
  'grease-2007/amny--matt-windman.json',
];

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

let prepped = 0;
let missing = 0;
let alreadyPrepped = 0;

console.log(`Target files: ${TARGETS.length}`);
console.log('');

for (const rel of TARGETS) {
  const filePath = path.join(REVIEW_TEXTS_DIR, rel);
  if (!fs.existsSync(filePath)) {
    console.log(`  MISSING  ${rel}`);
    missing++;
    continue;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const had = data.showNotMentioned === true || data._showNotMentionedDiscoveryAttempted === true || data.suspectedLlmHallucination === true;
  if (!had) {
    console.log(`  SKIP     ${rel} (already prepped)`);
    alreadyPrepped++;
    continue;
  }
  console.log(`  PREP     ${rel}`);
  if (APPLY) {
    delete data.showNotMentioned;
    delete data._showNotMentionedDiscoveryAttempted;
    delete data.suspectedLlmHallucination;
    data.contentTier = 'needs-rescrape';
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    prepped++;
  }
}

console.log('');
console.log(`Prepped:          ${prepped}`);
console.log(`Already prepped:  ${alreadyPrepped}`);
console.log(`Missing:          ${missing}`);
if (!APPLY) console.log('');
if (!APPLY) console.log('DRY RUN. Re-run with --apply to write.');
