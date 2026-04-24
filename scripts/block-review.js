#!/usr/bin/env node
/**
 * block-review.js — CLI wrapper for data/review-texts/{show}/_blocklist.json.
 *
 * Operator-facing friction tool. scripts/lib/poller-blocklist.js added the
 * mechanism (Rocky Horror 2026-04-23: the poller re-created a manually deleted
 * review file 2h later under a ?triedRedirect tracking param). That only
 * helps if the operator edits the JSON correctly. This wrapper hides the file
 * path, JSON shape, and URL-normalization rules behind three flags.
 *
 * Usage:
 *   node scripts/block-review.js --show=ID --url=URL [--reason='...']
 *   node scripts/block-review.js --show=ID --list
 *   node scripts/block-review.js --show=ID --remove=URL
 *   node scripts/block-review.js --help
 *
 * Exit codes:
 *   0  success
 *   1  usage error / show dir missing / duplicate add / URL not in blocklist
 *   2  unexpected I/O or JSON error
 */

const fs = require('fs');
const path = require('path');

const {
  loadBlocklist,
  normalizeUrl,
  BLOCKLIST_FILENAME,
} = require('./lib/poller-blocklist');

const HELP = `block-review.js — add/list/remove entries in a show's _blocklist.json

  --show=ID                Show ID (required)
  --url=URL                URL to block (mode: add)
  --reason='free text'     Optional reason stored alongside the block
  --list                   Print current blocklist for the show
  --remove=URL             Remove an entry by URL (normalization-aware)
  --data-dir=PATH          Override data/review-texts root (for tests)
  --help                   Show this message

Examples:
  node scripts/block-review.js --show=the-rocky-horror-show-2026 \\
    --url='https://davidcote1.substack.com/p/the-rocky-horror-show?triedRedirect=true' \\
    --reason='duplicate of cote-notices--david-cote'
  node scripts/block-review.js --show=the-rocky-horror-show-2026 --list
  node scripts/block-review.js --show=the-rocky-horror-show-2026 \\
    --remove='https://davidcote1.substack.com/p/the-rocky-horror-show'
`;

function parseArgs(argv) {
  const out = { _flags: new Set() };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) {
      out._flags.add(a.slice(2));
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

function readRawEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw && raw.urls) ? raw.urls : [];
  const entries = [];
  for (const item of arr) {
    const url = typeof item === 'string' ? item : item && item.url;
    if (!url) continue;
    entries.push({
      url,
      reason: item && typeof item === 'object' && item.reason ? item.reason : null,
      blockedAt: item && typeof item === 'object' && item.blockedAt ? item.blockedAt : null,
    });
  }
  return entries;
}

function writeEntries(filePath, entries) {
  const canonical = {
    urls: entries.map((e) => {
      const o = { url: e.url };
      if (e.reason) o.reason = e.reason;
      if (e.blockedAt) o.blockedAt = e.blockedAt;
      return o;
    }),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(canonical, null, 2) + '\n');
}

function resolveShowDir(args) {
  const dataDir = args['data-dir'] || path.join(__dirname, '..', 'data', 'review-texts');
  return path.join(dataDir, args.show);
}

function cmdAdd(args) {
  const showDir = resolveShowDir(args);
  if (!fs.existsSync(showDir)) {
    console.error(`❌ Show dir not found: ${showDir}`);
    console.error(`   Check --show=ID — does data/review-texts/${args.show}/ exist?`);
    process.exit(1);
  }
  const filePath = path.join(showDir, BLOCKLIST_FILENAME);
  const entries = readRawEntries(filePath);

  const targetNormalized = normalizeUrl(args.url);
  const existing = entries.find((e) => normalizeUrl(e.url) === targetNormalized);
  if (existing) {
    console.error(`⚠️  Already blocked (normalized match)`);
    console.error(`   existing url:   ${existing.url}`);
    console.error(`   existing reason: ${existing.reason || '(none)'}`);
    console.error(`   existing blockedAt: ${existing.blockedAt || '(none)'}`);
    process.exit(1);
  }

  const entry = {
    url: args.url,
    reason: args.reason || 'no reason given',
    blockedAt: new Date().toISOString(),
  };
  entries.push(entry);
  writeEntries(filePath, entries);

  console.log(`✓ Blocked ${args.url}`);
  console.log(`  file:       ${path.relative(process.cwd(), filePath)}`);
  console.log(`  normalized: ${targetNormalized}`);
  console.log(`  reason:     ${entry.reason}`);
  console.log(`  blockedAt:  ${entry.blockedAt}`);
}

function cmdList(args) {
  const showDir = resolveShowDir(args);
  if (!fs.existsSync(showDir)) {
    console.error(`❌ Show dir not found: ${showDir}`);
    process.exit(1);
  }
  const bl = loadBlocklist(showDir);
  if (bl.entries.length === 0) {
    console.log(`(empty) No blocklist for ${args.show}`);
    return;
  }
  console.log(`Blocklist for ${args.show} (${bl.entries.length} entries):`);
  for (const e of bl.entries) {
    console.log(`  - ${e.url}`);
    console.log(`      reason:    ${e.reason}`);
    if (e.blockedAt) console.log(`      blockedAt: ${e.blockedAt}`);
    console.log(`      normalized: ${normalizeUrl(e.url)}`);
  }
}

function cmdRemove(args) {
  const showDir = resolveShowDir(args);
  if (!fs.existsSync(showDir)) {
    console.error(`❌ Show dir not found: ${showDir}`);
    process.exit(1);
  }
  const filePath = path.join(showDir, BLOCKLIST_FILENAME);
  const entries = readRawEntries(filePath);
  const targetNormalized = normalizeUrl(args.remove);
  const before = entries.length;
  const kept = entries.filter((e) => normalizeUrl(e.url) !== targetNormalized);
  if (kept.length === before) {
    console.error(`⚠️  URL not in blocklist: ${args.remove}`);
    console.error(`   normalized: ${targetNormalized}`);
    process.exit(1);
  }
  writeEntries(filePath, kept);
  console.log(`✓ Removed ${before - kept.length} entry — ${kept.length} remaining`);
  console.log(`  normalized: ${targetNormalized}`);
}

function main(argv) {
  const args = parseArgs(argv);

  if (args._flags.has('help') || argv.length === 0) {
    console.log(HELP);
    return;
  }

  if (!args.show) {
    console.error('❌ --show=ID is required\n');
    console.error(HELP);
    process.exit(1);
  }

  const modes = [args.url ? 'add' : null, args._flags.has('list') ? 'list' : null, args.remove ? 'remove' : null].filter(Boolean);
  if (modes.length === 0) {
    console.error('❌ Need exactly one of: --url=URL, --list, --remove=URL\n');
    console.error(HELP);
    process.exit(1);
  }
  if (modes.length > 1) {
    console.error(`❌ Conflicting modes: ${modes.join(' + ')} — pick one\n`);
    process.exit(1);
  }

  try {
    if (modes[0] === 'add') cmdAdd(args);
    else if (modes[0] === 'list') cmdList(args);
    else if (modes[0] === 'remove') cmdRemove(args);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main, parseArgs, readRawEntries, writeEntries };
