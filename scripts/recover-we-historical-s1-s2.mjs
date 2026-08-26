#!/usr/bin/env node
// Reconstructs current state for the West End historical scoring pilot
// (S0.5 smoke test -> S1/S2 tooling) from its three systems of record —
// Notion cards, git history on main, and live show data — so a session
// picking this back up (this workflow's whole reason for existing, per
// BRO-265: the prior session lost its terminal tab, not its state) gets
// the answer from one command instead of re-deriving it across three
// systems by hand.
//
// Usage: node scripts/recover-we-historical-s1-s2.mjs [--json]

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

// Stable Notion page ids for the three cards this pilot lives across.
// Card ids don't change even as status/outcome fields are edited, so
// hardcoding them here (rather than re-discovering via search every run)
// is the whole point of a "recover" script: it should work even if the
// title text has since drifted.
const NOTION_CARDS = [
  { id: '3b7637c5-416f-81cb-9871-fc2da0dfd06d', label: 'Plan card (west-end historical backfill)' },
  { id: '3b9637c5-416f-8193-88c0-f0d38e2d2de2', label: 'Task #1249 (S0.5 smoke-test + S1/S2 tooling)' },
  { id: '3b9637c5-416f-8159-b159-c27af5e21c0a', label: 'Task #1249 session-tracking card' },
  { id: '3ba637c5-416f-81f2-8b73-cc99270b1dc7', label: 'Task #1282 (aggregatorStars lost-update race)' },
];

// Files the S1/S2 tooling build is supposed to have produced (task #1249's
// own acceptance criteria named we-seasons.js explicitly).
const TOOLING_FILES = [
  'scripts/lib/we-seasons.js',
  'scripts/lib/we-historical-corroboration.js',
  'scripts/discover-historical-shows-we.js',
  'scripts/promote-historical-we.js',
  'scripts/merge-wet-stars-urls.js',
  'scripts/lib/tr-wrongshow-guard.js',
];

// The two shows the S0.5 smoke test proved the pipeline on end-to-end.
const SMOKE_TEST_SHOWS = ['juno-and-the-paycock-west-end-2024', 'barcelona-west-end-2024'];

function section(title) {
  if (JSON_OUT) return;
  console.log(`\n=== ${title} ===`);
}

function tryRun(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'function' ? fallback(err) : { error: err.message };
  }
}

function getNotionCard(id) {
  const out = execFileSync('node', ['scripts/notion-brain.js', 'get', id], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(out);
}

function gitLog(args) {
  return execFileSync('git', ['log', ...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function fileOnMain(relPath) {
  try {
    execFileSync('git', ['show', `main:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function liveComposite(showId) {
  const p = path.join(REPO_ROOT, 'public', 'data', 'shows', `${showId}.json`);
  if (!existsSync(p)) return { found: false };
  const data = JSON.parse(readFileSync(p, 'utf8'));
  // Compact show-page schema: `rc` is reviewCount (see public/data/shows/*.json).
  return { found: true, cs: data.cs ?? null, reviewCount: data.rc ?? null };
}

async function main() {
  const report = { notionCards: [], toolingFiles: {}, smokeTestShows: {}, git: {} };

  section('Notion cards');
  for (const card of NOTION_CARDS) {
    const result = tryRun(() => getNotionCard(card.id), (err) => ({ error: err.message }));
    report.notionCards.push({ ...card, ...result });
    if (!JSON_OUT) {
      if (result.error) {
        console.log(`  [ERROR] ${card.label}: ${result.error}`);
      } else {
        console.log(`  ${card.label}: ${result.status} (${result.url})`);
      }
    }
  }

  section('S1/S2 tooling files (present on main?)');
  for (const f of TOOLING_FILES) {
    const onMain = fileOnMain(f);
    report.toolingFiles[f] = onMain;
    if (!JSON_OUT) console.log(`  ${onMain ? 'OK  ' : 'MISS'} ${f}`);
  }

  section('Smoke-test shows (live composite)');
  for (const id of SMOKE_TEST_SHOWS) {
    const state = liveComposite(id);
    report.smokeTestShows[id] = state;
    if (!JSON_OUT) {
      console.log(state.found ? `  ${id}: cs=${state.cs}, reviews=${state.reviewCount}` : `  ${id}: NOT FOUND in public/data/shows/`);
    }
  }

  section('git: BRO-255 lost-update-race fix on main');
  report.git.bro255 = tryRun(() => gitLog(['--oneline', 'main', '--grep=BRO-255']), (err) => ({ error: err.message }));
  if (!JSON_OUT) console.log(report.git.bro255 || '  (no matching commits found)');

  section('git: worktree-we-historical-s1-s2 branch vs main');
  report.git.branchAheadOfMain = tryRun(
    () => gitLog(['--oneline', 'main..origin/worktree-we-historical-s1-s2']),
    (err) => ({ error: err.message })
  );
  if (!JSON_OUT) {
    const ahead = report.git.branchAheadOfMain;
    if (typeof ahead === 'string' && ahead.length === 0) {
      console.log('  Branch is fully merged into main — nothing left to recover from it.');
    } else if (typeof ahead === 'string') {
      console.log(`  Branch has commits NOT on main:\n${ahead}`);
    } else {
      console.log(`  [ERROR] ${ahead.error}`);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Summary ===');
    console.log('Read the sections above before doing any new work: the WE historical pilot');
    console.log('has repeatedly turned out to be further along than a fresh session assumes.');
    console.log('If Notion cards above are all "Done" and both smoke-test shows have a live');
    console.log('cs, S0.5 + S1/S2 tooling are complete — the open question is whether the');
    console.log('owner has approved the full 2024-25 season dispatch (~50 shows, real spend),');
    console.log('which is a scope/cost decision this script does not make for you.');
  }
}

main().catch((err) => {
  console.error(`recover-we-historical-s1-s2 failed: ${err.message}`);
  process.exit(1);
});
