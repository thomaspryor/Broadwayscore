#!/usr/bin/env node
/**
 * audit-opening-dates.js
 *
 * Daily audit of `openingDate` and `previewsStartDate` for shows that
 * haven't opened yet. Detects drift via the LLM-extracted press cluster
 * pattern (see scripts/lib/closing-date-discovery.js).
 *
 * IMPORTANT — this audit is suggestion-only, NOT auto-applying.
 * The closing-date triple-signal had broadway.com schedule as a second
 * independent signal (calendar pages don't lie about future performances).
 * Opening/preview dates have no equivalent. Without a second signal, the
 * audit routes findings to Notion for human review only. No mutation of
 * shows.json.
 *
 * Eligibility:
 *   - status='previews' OR status='open' AND openingDate within ±30 days
 *     of today (i.e., either about to open, or just opened — both windows
 *     where a delay/correction is operationally relevant for the
 *     opening-night-orchestrator and broadcast workflows).
 *   - Skips shows in openRunSkip + ambiguousAllowlist (reuses the closing
 *     audit's config — same set of long-runners broadway.com can't see).
 *
 * Discovery:
 *   - For each eligible show, call discoverAnnouncedDate(title, 'opening')
 *     and discoverAnnouncedDate(title, 'previews-start').
 *   - When either returns a date != stored, flag as ambiguous.
 *
 * Output:
 *   - data/audit/opening-date-discrepancies.json
 *   - Notion card per run (dedup against open card with same prefix)
 *
 * Usage:
 *   node scripts/audit-opening-dates.js [--dry-run] [--shows=id1,id2] [--time-budget-min=N]
 */

const fs = require('fs');
const path = require('path');
const { discoverAnnouncedDate } = require('./lib/closing-date-discovery');
const { cleanup } = require('./lib/scraper');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'opening-date-discrepancies.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'closing-date-audit-config.json');
const TODAY = new Date().toISOString().slice(0, 10);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SHOWS_FILTER = (argv.find(a => a.startsWith('--shows=')) || '').replace('--shows=', '').split(',').filter(Boolean);
const timeBudget = createRunBudget(parseTimeBudgetMin(argv));

// Cap discovery attempts per run to bound cost. Each show needing both
// opening + previews-start checks costs up to 2 SERP + ~10 article fetches +
// ~10 LLM calls = ~$0.20-0.30/show. Cap of 8 shows keeps cost under ~$2/run.
const MAX_DISCOVERY_ATTEMPTS = 8;
// How many days +/- of openingDate to consider "operationally relevant".
// Shows opening more than 30 days out have plenty of time for human review
// of opening-date drift; opened more than 30 days ago have a locked date.
const OPENING_WINDOW_DAYS = 30;

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const OPEN_RUN_SKIP = new Set(CONFIG.openRunSkip.ids);
// Reuse the closing-audit's ambiguousAllowlist as a secondary skip list.
// Shows on the allowlist are pre-verified long-runners; their opening dates
// are also locked-in (Op Mincemeat opened years ago, etc.). No point burning
// LLM calls on them. Drift detection still works at the closing-audit level.
const AMBIGUOUS_ALLOWLIST_IDS = new Set(
  Object.keys((CONFIG.ambiguousAllowlist && CONFIG.ambiguousAllowlist.entries) || {})
);

function isWithinWindow(dateStr, today, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const t = new Date(today);
  const diff = Math.abs((d - t) / 86400000);
  return diff <= days;
}

async function notifyNotion(flagged, todayStr) {
  if (flagged.length === 0) return;
  if (!process.env.NOTION_API_KEY) {
    console.log('NOTION_API_KEY not set — skipping Notion card creation');
    return;
  }
  const { spawnSync } = require('child_process');
  const brain = path.join(__dirname, 'notion-brain.js');

  // Dedup: skip create if a prior opening-date audit card exists in ANY
  // non-Done state (In progress / Paused / Not started). Same rationale as
  // audit-closing-dates.js — narrow "In progress" check missed Paused cards.
  const dedupStatuses = ['In progress', 'Paused', 'Not started'];
  let dedupHit = false;
  for (const status of dedupStatuses) {
    const search = spawnSync('node', [brain, 'search', '--text=Opening-date audit', `--status=${status}`], { encoding: 'utf8' });
    if (search.status === 0 && /Opening-date audit/.test(search.stdout || '')) {
      dedupHit = true;
      console.log(`Notion: existing ${status} opening-audit card found — skipping create (dedup)`);
      break;
    }
  }
  if (dedupHit) return;

  const title = `Opening-date audit: ${flagged.length} show${flagged.length > 1 ? 's' : ''} need review (${todayStr})`;
  const rows = flagged.map(f => {
    const lines = [`- **${f.id}**: stored ${f.fieldType}=${f.stored || 'null'}`];
    if (f.discovered) {
      const c = f.discovered;
      const sourceLinks = c.sources.slice(0, 3).map(s => s.url).join(', ');
      lines.push(`  📰 Press cluster: **${c.date}** (${c.sources.length} source${c.sources.length > 1 ? 's' : ''}: ${sourceLinks})`);
      if (c.sources[0] && c.sources[0].quote) {
        lines.push(`  💬 "${c.sources[0].quote.replace(/[\n\r]+/g, ' ').slice(0, 200)}"`);
      }
    }
    return lines.join('\n');
  }).join('\n');

  const notes = [
    '## Problem',
    `Opening-date audit found ${flagged.length} show(s) where press cluster disagrees with stored openingDate or previewsStartDate. Unlike the closing-date audit, this audit has no second independent signal, so findings are suggestion-only — manually verify and update shows.json if confirmed.`,
    '',
    '## Shows flagged',
    rows,
    '',
    '## Resolution steps',
    '1. For each show, click the 📰 Press cluster source URLs to verify the discovered date is for THIS production (not a tour, regional, or other revival).',
    '2. If confirmed → update openingDate or previewsStartDate in `data/shows.json` (private repo `thomaspryor/broadway-scorecard-data`).',
    '3. If the press article is about the wrong production or the stored date is right, no action.',
    '',
    '## Acceptance criteria',
    'Each show\'s stored opening/preview-start date either matches the announced date OR has been confirmed correct.',
    '',
    `_Auto-created by scripts/audit-opening-dates.js on ${todayStr}._`,
  ].join('\n');

  const create = spawnSync('node', [
    brain, 'create', title,
    '--priority', 'P1 Next',
    '--category', 'Data',
    '--type', 'Bug',
    '--tags', 'opening-night,audit,data-quality',
    '--notes', notes,
  ], { encoding: 'utf8' });

  if (create.status === 0) {
    const match = (create.stderr || '').match(/__NOTION_CARD_ID__=([a-f0-9-]+)/);
    console.log(`Notion: created card ${match ? match[1] : '(unknown id)'}`);
  } else {
    console.warn('Notion: create failed:', (create.stderr || create.stdout || '').slice(0, 500));
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('OPENING DATE AUDIT (LLM press cluster — suggestion only)');
  console.log('='.repeat(60));
  console.log(`Date: ${TODAY}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — audit cannot run. Exiting.');
    await cleanup();
    process.exit(0);
  }

  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const candidates = data.shows.filter(s => {
    if (s.category !== 'broadway') return false;
    if (OPEN_RUN_SKIP.has(s.id)) return false;
    if (AMBIGUOUS_ALLOWLIST_IDS.has(s.id)) return false;
    if (SHOWS_FILTER.length && !SHOWS_FILTER.includes(s.id)) return false;
    // Only audit shows that are about to open OR just opened (within ±30d
    // of stored openingDate). Outside this window, opening-date drift is
    // either far-future (plenty of human review time) or locked-past.
    if (s.status === 'previews') return true;
    if (s.status === 'open' && isWithinWindow(s.openingDate, TODAY, OPENING_WINDOW_DAYS)) return true;
    return false;
  }).slice(0, MAX_DISCOVERY_ATTEMPTS);

  console.log(`Auditing ${candidates.length} candidate show(s) (cap ${MAX_DISCOVERY_ATTEMPTS}/run)...`);
  console.log('');

  const flagged = [];
  const matches = [];
  const errors = [];

  for (const show of candidates) {
    if (timeBudget.exceeded()) {
      console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — remaining candidates deferred to next run.`);
      break;
    }
    const title = show.name || show.title || show.id;
    console.log(`[${show.id}] ${title} — stored opening=${show.openingDate || 'null'}, previews=${show.previewsStartDate || 'null'}`);

    for (const fieldType of ['opening', 'previews-start']) {
      const storedKey = fieldType === 'opening' ? 'openingDate' : 'previewsStartDate';
      const stored = show[storedKey] || null;
      try {
        const discovered = await discoverAnnouncedDate(title, fieldType, { log: msg => console.log(msg) }, timeBudget);
        if (!discovered) {
          continue;  // No press signal; can't conclude anything
        }
        if (stored && discovered.date === stored) {
          matches.push({ id: show.id, fieldType, stored, discoveredDate: discovered.date });
          continue;
        }
        // Date differs OR stored was null and we got a date.
        flagged.push({
          id: show.id,
          fieldType: storedKey,
          stored,
          discovered: {
            date: discovered.date,
            sources: discovered.sources,
          },
        });
      } catch (e) {
        errors.push({ id: show.id, fieldType, message: e.message.slice(0, 120) });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    summary: {
      audited: candidates.length,
      flagged: flagged.length,
      matches: matches.length,
      errors: errors.length,
    },
    flagged,
    matches,
    errors,
  };

  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote ${AUDIT_FILE}`);

  console.log('\nResults:');
  console.log(`  ✅ Matches:    ${matches.length}`);
  console.log(`  ⚠️  Flagged:    ${flagged.length}`);
  console.log(`  ❌ Errors:     ${errors.length}`);

  for (const m of matches) console.log(`  MATCH ${m.id}: ${m.fieldType}=${m.stored} agrees with press`);
  for (const f of flagged) console.log(`  FLAG  ${f.id}: stored ${f.fieldType}=${f.stored} vs press ${f.discovered.date} (${f.discovered.sources.length} source${f.discovered.sources.length > 1 ? 's' : ''})`);

  if (flagged.length > 0) await notifyNotion(flagged, TODAY);

  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});
