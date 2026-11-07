#!/usr/bin/env node
/**
 * coordinator-check.js — show the coordinator card for an area, and check a land
 * acknowledged its latest note (BRO-6083). Registry: scripts/lib/coordinator-registry.js.
 *
 *   node scripts/coordinator-check.js --card BRO-N        start reminder for the area a card works on
 *   node scripts/coordinator-check.js --paths a.js,b.js   start reminder for files you plan to touch
 *   node scripts/coordinator-check.js --text "..."        start reminder for free text
 *   node scripts/coordinator-check.js --land [--base origin/main] [--head HEAD] [--branch land/x]
 *                                         [--github] [--json] [--strict]
 *   node scripts/coordinator-check.js --list
 *
 * --land is advisory (CLAUDE.md §19): exit 0 unless --strict and the verdict is warn.
 * A card Linear cannot read is reported as unknown, never as ok.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const reg = require('./lib/coordinator-registry');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.resolve(__dirname, '..');
const LINEAR_OPTS = { timeoutMs: 8000, maxAttempts: 1, onRetry: () => {} };

const CARD_QUERY = `query($id: String!) { issue(id: $id) { identifier url title description
  comments(first: 100) { nodes { id body createdAt } } } }`;

/** { ok, url, title, description, comments } or { ok: false, error }. Never throws. */
async function fetchCard(card) {
  try {
    const { graphql } = require('./lib/linear-client');
    const data = await graphql(CARD_QUERY, { id: card }, LINEAR_OPTS);
    const issue = data && data.issue;
    if (!issue) return { ok: false, error: `${card} not found` };
    return { ok: true, identifier: issue.identifier, url: issue.url, title: issue.title, description: issue.description || '', comments: (issue.comments && issue.comments.nodes) || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).split('\n')[0].slice(0, 200) };
  }
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}

function parseArgs(argv) {
  const opts = { base: 'origin/main', head: 'HEAD', branch: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--land' || k === '--github' || k === '--json' || k === '--strict' || k === '--list') opts[k.slice(2)] = true;
    else if (k === '--base' || k === '--head' || k === '--branch' || k === '--card' || k === '--text' || k === '--cwd') opts[k.slice(2)] = val();
    else if (k === '--paths') opts.paths = String(val() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function readNotes(cards, getCard) {
  const out = new Map();
  await Promise.all([...new Set(cards)].map(async (c) => out.set(c, await getCard(c))));
  return out;
}

/** Land mode: diff + commit messages base...head, judged against the coordinator cards. */
async function landVerdict(opts, deps) {
  const cwd = opts.cwd || ROOT;
  const runGit = deps.git || ((args) => git(args, cwd));
  const mb = runGit(['merge-base', opts.base, opts.head]).trim();
  const files = runGit(['diff', '--name-only', `${mb}..${opts.head}`]).split('\n').map((s) => s.trim()).filter(Boolean);
  const commitText = runGit(['log', '--format=%B', `${mb}..${opts.head}`]);
  const areas = reg.areasForFiles(files, deps.registry);
  const notesByCard = areas.length ? await readNotes(areas.map((a) => a.entry.card), deps.fetchCard || fetchCard) : new Map();
  return reg.judgeLand({ files, commitText, branch: opts.branch, notesByCard }, deps.registry);
}

function ghEscape(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function run(argv, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err || ((s) => process.stderr.write(`${s}\n`));
  const env = deps.env || process.env;
  if (hasHelpFlag(argv)) {
    out(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim());
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`coordinator-check: ${e.message}`);
    return 2;
  }
  const registry = deps.registry || reg.REGISTRY;

  if (opts.list) {
    for (const e of registry) out(`${e.area}: ${e.card}\n  ${e.globs.join('\n  ')}`);
    return 0;
  }

  if (opts.land) {
    let verdict;
    try {
      verdict = await landVerdict(opts, { ...deps, registry });
    } catch (e) {
      // Advisory: a git failure must never fail the land. Say so and move on.
      err(`coordinator-check: could not read the branch (${String(e.message).split('\n')[0]}); skipping.`);
      return 0;
    }
    const message = reg.formatLandMessage(verdict);
    if (opts.json) out(JSON.stringify({ status: verdict.status, message, findings: verdict.findings.map((f) => ({ area: f.area, card: f.card, status: f.status, files: f.files, note: f.note ? f.note.id : null })) }));
    else if (message) err(message);
    else out(`coordinator-check: ${verdict.status === 'skip' ? 'no coordinated area touched' : 'acknowledged'}.`);
    if (opts.github && message) {
      out(`::warning title=Coordinator card not acknowledged (advisory)::${ghEscape(message)}`);
      if (env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Coordinator check (advisory)\n\n\`\`\`\n${message}\n\`\`\`\n`); } catch { /* summary is best effort */ }
      }
    }
    return opts.strict && verdict.status === 'warn' ? 1 : 0;
  }

  // Start reminder: --card, --paths and --text all resolve to areas.
  const getCard = deps.fetchCard || fetchCard;
  const areas = new Map();
  if (opts.paths) for (const a of reg.areasForFiles(opts.paths, registry)) areas.set(a.entry.card, a.entry);
  if (opts.text) for (const e of reg.areasForText(opts.text, registry)) areas.set(e.card, e);
  if (opts.card) {
    const card = await getCard(String(opts.card).toUpperCase());
    if (!card.ok) {
      err(`coordinator-check: could not read ${opts.card} (${card.error}). Check the registry yourself: node scripts/coordinator-check.js --list`);
      return 0;
    }
    for (const e of reg.areasForText(`${card.title}\n${card.description}`, registry)) areas.set(e.card, e);
    // The coordinator card itself needs no reminder to read itself.
    areas.delete(String(opts.card).toUpperCase());
  }
  if (!opts.card && !opts.paths && !opts.text) {
    err('coordinator-check: pass --card, --paths, --text, --land or --list');
    return 2;
  }
  if (!areas.size) {
    out('coordinator-check: no coordinated area.');
    return 0;
  }
  const notes = await readNotes([...areas.keys()], getCard);
  for (const [card, entry] of areas) out(reg.formatReminder(entry, notes.get(card)));
  return 0;
}

/**
 * Start reminder for a card's text ('' when it touches no coordinated area).
 * Used by linear-brain.js create/get. Never throws.
 */
async function startReminder(text, { exclude = '', fetchCard: getCard = fetchCard, registry = reg.REGISTRY } = {}) {
  try {
    const areas = reg.areasForText(text, registry).filter((e) => e.card !== String(exclude).toUpperCase());
    if (!areas.length) return '';
    const notes = await readNotes(areas.map((e) => e.card), getCard);
    return areas.map((e) => reg.formatReminder(e, notes.get(e.card))).join('\n');
  } catch {
    return '';
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write(`coordinator-check: ${e && e.message}\n`);
    process.exit(0);
  });
}

module.exports = { run, parseArgs, fetchCard, landVerdict, startReminder };
