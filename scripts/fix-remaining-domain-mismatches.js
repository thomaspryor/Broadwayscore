#!/usr/bin/env node
/**
 * Fix remaining 103 URL-domain mismatches in review-text files.
 *
 * Groups:
 *   A: Add domainAliases to outlet-registry.json (old/variant domains)
 *   B: Fix/add domain in outlet-registry.json (wrong/missing domain)
 *   C: Fix outletId in review-text files (mapped to wrong outlet)
 *   D: Flag wrongUrl in review-text files (aggregator/fan-site URLs)
 *   E: Skip (archive/aggregator links that are fine as-is)
 *
 * Preserves _originalOutletId for audit trail.
 *
 * Usage:
 *   node scripts/fix-remaining-domain-mismatches.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

const DRY_RUN = process.argv.includes('--dry-run');
const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

// ── Helpers ──

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  if (!DRY_RUN) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
}

function getOutletDisplayName(registry, outletId) {
  const outlet = registry.outlets[outletId];
  return outlet ? outlet.displayName : outletId;
}

// ── GROUP A: Add domainAliases to existing outlets ──

const GROUP_A = [
  { outletId: 'bloomberg', alias: 'businessweek.com' },
  { outletId: 'vulture', alias: 'newyorkmetro.com' },
  { outletId: 'standard', alias: 'thisislondon.co.uk' },
  { outletId: 'observer', alias: 'observer.co.uk' },
  { outletId: 'theater-scene', alias: 'nytheaterscene.com' },
  { outletId: 'chicagotribune', alias: 'wgnradio.com' },
  { outletId: 'playbill', alias: 'playbill.vo.llnwd.net' },
  { outletId: 'edge-media-network', alias: 'edgesandiego.com' },
];

// ── GROUP B: Fix/add domain + aliases in registry ──

const GROUP_B = [
  // domain corrections
  { outletId: 'culturesauce', domain: 'culturesauce.net' },
  { outletId: 'catholic-transcript', domain: 'catholictranscript.org', addAliases: ['dearead.com'] },
  { outletId: 'splash-magazines', domain: 'splashmags.com', addAliases: ['newyork.splashmags.com'] },
  { outletId: 'london-theatre', domain: 'londontheatrereviews.co.uk' },
  { outletId: 'contra-costa-times', domain: 'contracostatimes.com' },
  { outletId: 'fresh-fiction', domain: 'freshfiction.tv' },
  { outletId: '3news', domain: '3news.co.nz' },
  { outletId: 'next-magazine', domain: 'nextmag.ca' },
  { outletId: 'the-journal-news', domain: 'thejournalnews.com' },
  { outletId: 'broadwaynews', addAliases: ['bway.ly'] },
  { outletId: 'show-showdown', domain: 'showshowdown.blogspot.com', addAliases: ['showshowdown.blogspot.co.id'] },
  { outletId: 'gotham-playgoer', domain: 'bobs-theater-blog.blogspot.com' },
  { outletId: 'everything-theatre', addAliases: ['everythingmusicals.com'] },
];

// ── GROUP C: Fix outletId in review-text files ──
// Each entry: { file, newOutletId }
// file is relative to reviewTextsDir

const GROUP_C = [
  // the-sun → times-uk (all the-sun--dominic-maxwell files with thetimes.com URLs)
  { file: 'hercules-west-end-2025/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },
  { file: 'my-neighbour-totoro-west-end-2025/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },
  { file: 'evening-all-afternoon-west-end-2026/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },
  { file: 'les-miserables-west-end-2021/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },
  { file: 'oliver-west-end-2024/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },
  { file: 'oliver-west-end-2024/the-sun--unknown.json', newOutletId: 'times-uk' },
  { file: 'the-producers-west-end-2025/the-sun--dominic-maxwell.json', newOutletId: 'times-uk' },

  // vulture → nytimes (theater.nytimes.com)
  { file: 'la-cage-aux-folles-2010/vulture--ben-brantley.json', newOutletId: 'nytimes' },

  // nysr → huffpost (huffingtonpost.com)
  { file: 'rocky-2014/nysr--huffington-poststeven-suskin.json', newOutletId: 'huffpost' },

  // vulture → splash-magazines (newyork.splashmags.com)
  { file: 'choir-boy-2019/vulture--sid-ross.json', newOutletId: 'splash-magazines' },

  // philadelphia-inquirer → show-showdown (showshowdown.blogspot.com)
  { file: 'head-over-heels-2018/philadelphia-inquirer--elizabeth-wollman.json', newOutletId: 'show-showdown' },
  { file: 'my-fair-lady-2018/philadelphia-inquirer--elizabeth-wollman.json', newOutletId: 'show-showdown' },

  // nypost → wrongUrl flag (nysepost.com is not NY Post)
  { file: 'king-charles-iii-2015/nypost--kevin-goodings.json', newOutletId: null, wrongUrl: true },

  // nypost → broadwaynews (bway.ly domain)
  { file: 'the-encounter-2016/nypost--unknown.json', newOutletId: 'broadwaynews' },

  // thewrap → broadwaynews (bway.ly domain)
  { file: 'the-kite-runner-2022/thewrap--robert-hofler.json', newOutletId: 'broadwaynews' },

  // american-theater-web → america-magazine (americamagazine.org)
  { file: 'angels-in-america-2018/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'king-lear-2019/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'ragtime-1998/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'ragtime-2009/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'ragtime-2025/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'the-ferryman-2018/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'the-sign-in-sidney-brusteins-window-2023/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },
  { file: 'the-sign-in-sidney-brusteins-window-2023/american-theater-web--unknown.json', newOutletId: 'america-magazine' },
  { file: 'what-the-constitution-means-to-me-2019/american-theater-web--rob-weinert-kendt.json', newOutletId: 'america-magazine' },

  // american-theater-web → wrongUrl (show website URL)
  { file: 'american-psycho-2016/american-theater-web--unknown.json', newOutletId: null, wrongUrl: true },

  // new-york-sun → new-york-city-theatre (newyorkcitytheatre.com)
  { file: 'elf-2024/new-york-sun--unknown.json', newOutletId: 'new-york-city-theatre' },
  { file: 'tammy-faye-2024/new-york-sun--unknown.json', newOutletId: 'new-york-city-theatre' },

  // new-york-sun--broadway-scorecard → wrongUrl (our own site)
  { file: 'maybe-happy-ending-2024/new-york-sun--broadway-scorecard.json', newOutletId: null, wrongUrl: true },
];

// Leave as-is (no changes):
// - vulture--sandy-macdonald (newyorknotebook.substack.com) — liberation-2025
// - nysr--new-york-notebook-sandy-macdonald — oedipus-2025, queen-versailles-2025, anna-christie-1977
// - broadwayworld--roy-berko (royberko.info) — 2 files
// - zeal-nyc--chris-caggiano (chriscaggiano.com) — 1 file
// - deadline--joe-lapointe (deadlinedetroit.com) — 1 file

// ── GROUP D: Flag wrongUrl (aggregator/fan-site URLs) ──
// These are found dynamically by scanning for URL patterns

const GROUP_D_URL_PATTERNS = [
  { pattern: 'stagedoor.com', reason: 'WE aggregator URL' },
  { pattern: 'westendtheatre.com', reason: 'WE aggregator URL' },
  { pattern: 'jasonraize.net', reason: 'Fan site URL' },
  { pattern: 'wickedthemusical.com', reason: 'Show website URL' },
  { pattern: 'metrosource.com.s123317.gridserver.com', reason: 'Staging server URL' },
];

// broadwayscorecard.com is handled in Group C (maybe-happy-ending) and butley
// americanpsychothemusical.com is handled in Group C

// ── GROUP E: Skip (archive/aggregator links) ──
// web.archive.org, news.google.com, msn.com, aol.com, da.feedsportal.com — no action needed


// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════

function main() {
  console.log('=== Fix Remaining Domain Mismatches ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const registry = readJSON(registryPath);
  const stats = {
    registryAliasesAdded: 0,
    registryDomainsFixed: 0,
    outletIdFixed: 0,
    wrongUrlFlagged: 0,
    skipped: 0,
    errors: 0,
  };

  // ── Step 1: GROUP A — Add domainAliases ──
  console.log('── Group A: Add domainAliases to outlet-registry.json ──');
  for (const { outletId, alias } of GROUP_A) {
    const outlet = registry.outlets[outletId];
    if (!outlet) {
      console.log(`  ERROR: outlet "${outletId}" not found in registry`);
      stats.errors++;
      continue;
    }
    if (!outlet.domainAliases) {
      outlet.domainAliases = [];
    }
    if (outlet.domainAliases.includes(alias)) {
      console.log(`  SKIP: ${outletId} already has alias "${alias}"`);
      stats.skipped++;
      continue;
    }
    outlet.domainAliases.push(alias);
    console.log(`  ADD: ${outletId} ← alias "${alias}"`);
    stats.registryAliasesAdded++;
  }

  // ── Step 2: GROUP B — Fix/add domains and aliases ──
  console.log('\n── Group B: Fix/add domain in outlet-registry.json ──');

  // First, create america-magazine if it doesn't exist
  if (!registry.outlets['america-magazine']) {
    console.log('  CREATE: america-magazine outlet entry');
    registry.outlets['america-magazine'] = {
      displayName: 'America Magazine',
      tier: 3,
      aliases: ['america-magazine', 'america magazine'],
      domain: 'americamagazine.org',
      accessModel: 'free',
    };
    stats.registryDomainsFixed++;
  }

  // Create new-york-city-theatre if it doesn't exist
  if (!registry.outlets['new-york-city-theatre']) {
    console.log('  CREATE: new-york-city-theatre outlet entry');
    registry.outlets['new-york-city-theatre'] = {
      displayName: 'New York City Theatre',
      tier: 3,
      aliases: ['new-york-city-theatre', 'new york city theatre', 'nyc theatre'],
      domain: 'newyorkcitytheatre.com',
      accessModel: 'free',
    };
    stats.registryDomainsFixed++;
  }

  for (const { outletId, domain, addAliases } of GROUP_B) {
    const outlet = registry.outlets[outletId];
    if (!outlet) {
      console.log(`  ERROR: outlet "${outletId}" not found in registry`);
      stats.errors++;
      continue;
    }

    if (domain) {
      const oldDomain = outlet.domain;
      // Move old domain to aliases if it's being replaced and is different
      if (oldDomain && oldDomain !== domain) {
        if (!outlet.domainAliases) outlet.domainAliases = [];
        if (!outlet.domainAliases.includes(oldDomain)) {
          outlet.domainAliases.push(oldDomain);
          console.log(`  ALIAS: ${outletId} ← old domain "${oldDomain}" moved to aliases`);
        }
      }
      outlet.domain = domain;
      console.log(`  DOMAIN: ${outletId} → "${domain}" (was "${oldDomain}")`);
      stats.registryDomainsFixed++;
    }

    if (addAliases) {
      if (!outlet.domainAliases) outlet.domainAliases = [];
      for (const alias of addAliases) {
        if (!outlet.domainAliases.includes(alias)) {
          outlet.domainAliases.push(alias);
          console.log(`  ADD: ${outletId} ← alias "${alias}"`);
          stats.registryAliasesAdded++;
        } else {
          console.log(`  SKIP: ${outletId} already has alias "${alias}"`);
          stats.skipped++;
        }
      }
    }
  }

  // Write updated registry
  console.log('\n  Writing outlet-registry.json...');
  writeJSON(registryPath, registry);

  // ── Step 3: GROUP C — Fix outletId in review-text files ──
  console.log('\n── Group C: Fix outletId in review-text files ──');
  for (const entry of GROUP_C) {
    const filePath = path.join(reviewTextsDir, entry.file);
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`  SKIP: ${entry.file} not found`);
        stats.skipped++;
        continue;
      }

      const data = readJSON(filePath);
      let changed = false;

      // Flag wrongUrl if needed
      if (entry.wrongUrl) {
        if (data.wrongUrl) {
          console.log(`  SKIP: ${entry.file} already has wrongUrl`);
          stats.skipped++;
          continue;
        }
        data.wrongUrl = true;
        console.log(`  FLAG: ${entry.file} → wrongUrl: true`);
        stats.wrongUrlFlagged++;
        changed = true;
      }

      // Fix outletId if needed
      if (entry.newOutletId && data.outletId !== entry.newOutletId) {
        // Preserve original for audit trail
        if (!data._originalOutletId) {
          data._originalOutletId = data.outletId;
        }
        const oldOutletId = data.outletId;
        data.outletId = entry.newOutletId;
        data.outlet = getOutletDisplayName(registry, entry.newOutletId);
        console.log(`  FIX: ${entry.file} → outletId: "${entry.newOutletId}" (was "${oldOutletId}")`);
        stats.outletIdFixed++;
        changed = true;
      } else if (entry.newOutletId && data.outletId === entry.newOutletId) {
        console.log(`  SKIP: ${entry.file} already has outletId "${entry.newOutletId}"`);
        stats.skipped++;
        continue;
      }

      if (changed) {
        writeJSON(filePath, data);
      }
    } catch (err) {
      console.error(`  ERROR: ${entry.file}: ${err.message}`);
      stats.errors++;
    }
  }

  // ── Step 4: GROUP D — Flag wrongUrl for aggregator/fan-site URLs ──
  console.log('\n── Group D: Flag wrongUrl for aggregator/fan-site URLs ──');

  // Also flag broadwayscorecard.com URLs not already handled by Group C
  const extraWrongUrlPatterns = [
    { pattern: 'broadwayscorecard.com', reason: 'Our own site URL' },
    { pattern: 'americanpsychothemusical.com', reason: 'Show website URL' },
  ];
  const allWrongUrlPatterns = [...GROUP_D_URL_PATTERNS, ...extraWrongUrlPatterns];

  const shows = listShowDirs(reviewTextsDir);
  for (const show of shows) {
    const showDir = path.join(reviewTextsDir, show);
    if (!fs.statSync(showDir).isDirectory()) continue;

    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = readJSON(filePath);
        if (!data.url) continue;

        // Check if already handled by Group C
        const relPath = `${show}/${file}`;
        if (GROUP_C.some(c => c.file === relPath)) continue;

        for (const { pattern, reason } of allWrongUrlPatterns) {
          if (data.url.includes(pattern)) {
            if (data.wrongUrl) {
              console.log(`  SKIP: ${relPath} already has wrongUrl`);
              stats.skipped++;
              break;
            }
            data.wrongUrl = true;
            console.log(`  FLAG: ${relPath} → wrongUrl: true (${reason})`);
            stats.wrongUrlFlagged++;
            writeJSON(filePath, data);
            break;
          }
        }
      } catch (err) {
        console.error(`  ERROR: ${show}/${file}: ${err.message}`);
        stats.errors++;
      }
    }
  }

  // ── Summary ──
  console.log('\n=== Summary ===');
  console.log(`  Registry aliases added:  ${stats.registryAliasesAdded}`);
  console.log(`  Registry domains fixed:  ${stats.registryDomainsFixed}`);
  console.log(`  OutletId fixed:          ${stats.outletIdFixed}`);
  console.log(`  WrongUrl flagged:        ${stats.wrongUrlFlagged}`);
  console.log(`  Skipped (already done):  ${stats.skipped}`);
  console.log(`  Errors:                  ${stats.errors}`);
  console.log(`\nMode: ${DRY_RUN ? 'DRY RUN (no files modified)' : 'LIVE (files updated)'}`);

  if (stats.errors > 0) {
    process.exit(1);
  }
}

main();
