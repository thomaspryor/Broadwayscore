#!/usr/bin/env node
'use strict';
/**
 * Sweep open Notion-migrated Linear cards for work that already shipped (BRO-3576).
 *
 * Migrated cards carry a "[notion:<page-id>]" or "Migrated from Notion" line.
 * For each open one, this looks through main's commit history for commits
 * that name the card, its Notion page, or its old task number, for human
 * commits whose subject matches the card title, and for later changes to the
 * files the card names. It prints a report of flagged cards. It never closes
 * a card.
 *
 * Usage:
 *   node scripts/sweep-notion-migrated-duplicates.js            # markdown report
 *   node scripts/sweep-notion-migrated-duplicates.js --json     # machine-readable
 *   node scripts/sweep-notion-migrated-duplicates.js --comment  # also comment on flagged cards (once each)
 *   --ref=origin/main   history to search (default origin/main)
 *   --limit=N           only check the first N cards
 *   --ids=BRO-1,BRO-2   score these cards in any state (calibration; with --comment, comments on them too)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { graphql, createComment } = require('./lib/linear-client');
const sweep = require('./lib/notion-migrated-sweep');

const ROOT = path.resolve(__dirname, '..');

const ISSUE_FIELDS = `
      id identifier title description createdAt url
      state { name }
      comments(first: 250) { nodes { body } }`;

const ISSUES_QUERY = `query($after: String, $markers: [IssueFilter!]) {
  issues(first: 50, after: $after, filter: {
    or: $markers,
    state: { type: { in: ["backlog", "unstarted", "started", "triage"] } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes {${ISSUE_FIELDS}
    }
  }
}`;

// --ids: score named cards in any state, archived included (done cards are
// auto-archived), to calibrate on known duplicates.
const ISSUES_BY_NUMBER_QUERY = `query($numbers: [Float!]) {
  issues(first: 100, includeArchived: true, filter: { team: { key: { eq: "BRO" } }, number: { in: $numbers } }) {
    pageInfo { hasNextPage endCursor }
    nodes {${ISSUE_FIELDS}
    }
  }
}`;

function parseArgs(argv) {
  const opts = { json: false, comment: false, ref: 'origin/main', limit: Infinity, ids: null };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--comment') opts.comment = true;
    else if (a.startsWith('--ref=')) opts.ref = a.slice(6);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8));
    else if (a.startsWith('--ids=')) opts.ids = a.slice(6).split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!(opts.limit > 0)) throw new Error('--limit must be a positive number');
  if (opts.ids && (!opts.ids.length || opts.ids.some((id) => !/^BRO-\d+$/i.test(id)))) {
    throw new Error('--ids takes BRO-N identifiers, comma separated');
  }
  if (opts.ids && opts.ids.length > 100) throw new Error('--ids takes at most 100 cards per run');
  return opts;
}

function toCard(n) {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description || '',
    createdAt: n.createdAt,
    url: n.url,
    state: n.state && n.state.name,
    comments: ((n.comments && n.comments.nodes) || []).map((c) => c.body || ''),
  };
}

async function fetchCardsByIds(ids) {
  const numbers = ids.map((id) => Number(String(id).replace(/^BRO-/i, ''))).filter(Number.isFinite);
  const data = await graphql(ISSUES_BY_NUMBER_QUERY, { numbers });
  return data.issues.nodes.map(toCard);
}

async function fetchMigratedCards() {
  const cards = [];
  const markers = sweep.MIGRATION_MARKERS.map((m) => ({ description: { contains: m } }));
  let after = null;
  do {
    const data = await graphql(ISSUES_QUERY, { after, markers });
    cards.push(...data.issues.nodes.map(toCard));
    after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (after);
  return cards;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function loadHistory(ref) {
  const raw = git(['log', ref, '--no-merges', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e']);
  const commits = sweep.parseGitLog(raw);
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  return { commits, shallow, since: commits.length ? commits[commits.length - 1].date : null };
}

function makePathHistory(ref) {
  const cache = new Map();
  return (p) => {
    if (!cache.has(p)) {
      let raw = '';
      try {
        raw = git(['log', ref, '--no-merges', '--format=%H%x1f%cI%x1f%s%x1f%x1e', '--', p]);
      } catch {
        raw = '';
      }
      cache.set(p, sweep.parseGitLog(raw));
    }
    return cache.get(p);
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 19).join('\n'));
    return;
  }
  const cards = (opts.ids ? await fetchCardsByIds(opts.ids) : await fetchMigratedCards()).slice(0, opts.limit);
  const { commits, shallow, since } = loadHistory(opts.ref);
  const pathHistory = makePathHistory(opts.ref);
  const pathExists = (p) => fs.existsSync(path.join(ROOT, p));
  const idf = sweep.buildIdf(commits.filter((c) => !sweep.isAutomatedSubject(c.subject)).map((c) => c.subject));

  const results = cards.map((card) => ({
    ...sweep.scoreCard(card, commits, { pathExists, pathHistory, idf }),
    alreadyCommented: card.comments.some((b) => b.includes(sweep.COMMENT_MARKER)),
    issueId: card.id,
  }));

  if (opts.comment) {
    for (const r of results.filter((x) => x.flagged && !x.alreadyCommented)) {
      await createComment(r.issueId, sweep.buildComment(r));
      r.commented = true;
      console.error(`commented on ${r.identifier}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ since, shallow, checked: results.length, results }, null, 2));
  } else {
    console.log(sweep.buildReport(results, { historySince: since, shallow }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`sweep-notion-migrated-duplicates: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
