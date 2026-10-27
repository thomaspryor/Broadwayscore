#!/usr/bin/env node
/**
 * Brief posts (BRO-6368): a one-off social post the owner asks for in a session
 * (/social-post), built from a template and posted only after the owner approves
 * the exact image and captions.
 *
 *   node scripts/social-autopost/brief.js --preview --template=compare --a=ID --b=ID [--hook="..."]
 *       Builds the card and the five captions, hosts the image, stores the manifest
 *       in Supabase and prints the image URL, the captions and the brief's hash.
 *       Add --local to render and print only (nothing hosted or stored).
 *   node scripts/social-autopost/brief.js --post=HASH --approved="<the owner's words>"
 *       Stores the approval, dispatches social-autopost.yml with only the hash and
 *       waits for it; the workflow re-checks every fact and posts through Buffer.
 *   node scripts/social-autopost/brief.js --status=HASH
 *       What the ledger on main says about the brief (scheduled, sent, failed).
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (poster
 * check), SOCIAL_CHROMIUM_PATH (defaults to /opt/pw-browsers/chromium when present).
 * No Buffer key is needed here: only the workflow talks to Buffer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const briefs = require('./briefs');

const ROOT = path.resolve(__dirname, '..', '..');
const NETWORKS = ['instagram', 'facebook', 'twitter', 'threads', 'bluesky'];

const args = process.argv.slice(2);
const arg = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = name => args.includes(`--${name}`);

if (!process.env.SOCIAL_CHROMIUM_PATH && fs.existsSync('/opt/pw-browsers/chromium')) process.env.SOCIAL_CHROMIUM_PATH = '/opt/pw-browsers/chromium';

async function preview() {
  const template = arg('template');
  if (!briefs.TEMPLATES.includes(template)) throw new Error(`--template must be one of: ${briefs.TEMPLATES.join(', ')}`);
  const run = require('./run');
  const { closeBrowser } = require('./render');
  const { encodeForSocial, hostImage, putBriefFile } = require('./host');
  const now = Date.now();
  const ctx = run.loadContext();
  const find = id => {
    const s = ctx.shows.find(x => x.id === id);
    if (!s) throw new Error(`${id}: not in data/shows.json`);
    return s;
  };
  const built = briefs.buildCompare({ descA: run.describe(find(arg('a')), ctx), descB: run.describe(find(arg('b')), ctx), hook: arg('hook') || '', now });
  const { older, newer } = built;

  const outDir = arg('out') || path.join(require('os').tmpdir(), 'social-brief');
  fs.mkdirSync(outDir, { recursive: true });
  const png = path.join(outDir, `compare-${older.show.id}--${newer.show.id}.png`);
  try {
    await run.renderCompareFor(built, ctx, png);
  } finally {
    await closeBrowser();
  }
  if (flag('local')) {
    console.log(`Local PNG: ${png}`);
    for (const net of NETWORKS) console.log(`\n--- ${net} (${[...built.captions[net]].length} chars) ---\n${built.captions[net]}`);
    return;
  }
  const jpeg = await encodeForSocial(png);
  const sha = crypto.createHash('sha1').update(jpeg.buffer).digest('hex').slice(0, 10);
  const imageUrl = await hostImage(jpeg.buffer, `brief/${new Date(now).toISOString().slice(0, 7)}/${template}-${newer.show.id}-${sha}.jpg`);

  // Everything the workflow posts, and nothing it does not: the hash covers it all.
  const manifest = {
    v: 1, template, ids: [older.show.id, newer.show.id], older: older.show.id, newer: newer.show.id,
    hook: (arg('hook') || '').trim(), captions: built.captions, facts: built.facts, delta: built.delta, imageUrl,
  };
  const hash = briefs.hashManifest(manifest);
  await putBriefFile(hash, 'manifest.json', manifest);

  console.log(`\nBRIEF ${hash} (${template}: ${older.show.id} vs ${newer.show.id})`);
  console.log(`Image: ${imageUrl}`);
  console.log(`Local PNG: ${png}`);
  for (const net of NETWORKS) console.log(`\n--- ${net} (${[...built.captions[net]].length} chars) ---\n${built.captions[net]}`);
  console.log(`\n--- alt text ---\n${built.captions.altText}`);
  console.log(`\nTo post after the owner approves: node scripts/social-autopost/brief.js --post=${hash} --approved="<their exact words>"`);
}

/** The brief's ledger entry on origin/main (the workflow commits it there), or null. */
function ledgerEntry(hash) {
  execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
  const raw = execFileSync('git', ['show', 'origin/main:data/social-autopost-ledger.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return (JSON.parse(raw).posts || []).find(p => p.type === 'brief' && p.hash === hash) || null;
}

function printEntry(hash, e) {
  if (!e) { console.log(`brief ${hash}: not in the ledger on main`); return false; }
  console.log(`brief ${hash}: ${e.title}, goes out ${e.dueAt} (approved "${e.approved}")`);
  for (const net of NETWORKS) {
    const c = (e.channels || {})[net];
    const err = (e.errors || {})[net];
    console.log(`  ${net.padEnd(10)} ${c ? `${c.result || 'scheduled'} (${c.postId})${c.link ? ` ${c.link}` : ''}` : `NOT SCHEDULED${err ? `: ${err}` : ''}`}`);
  }
  return true;
}

/**
 * Buffer's remaining daily quota, read from the headers of one cheap query (it costs
 * one request). Uses BUFFER_API_KEY when set; in a cloud session the proxy signs it.
 * Null when Buffer answers without rate-limit headers (the workflow re-checks anyway).
 */
async function bufferQuota() {
  const buffer = require('./buffer');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.BUFFER_API_KEY) headers.Authorization = `Bearer ${process.env.BUFFER_API_KEY}`;
  try {
    const res = await fetch(process.env.BUFFER_API_URL || 'https://api.buffer.com', { method: 'POST', headers, body: JSON.stringify({ query: 'query { account { id } }' }), signal: AbortSignal.timeout(30000) });
    return buffer.parseRateHeaders(h => res.headers.get(h));
  } catch { return null; }
}

async function post(hash) {
  if (!briefs.HASH_RE.test(hash)) throw new Error(`--post=${hash}: not a brief hash`);
  const words = String(arg('approved') || '').trim();
  if (!words) throw new Error('--approved="<the owner\'s exact words>" is required');
  // Do not spend a run the workflow would refuse: it needs the brief's requests plus its own.
  const rate = await bufferQuota();
  if (!rate) console.log('Could not read the Buffer quota here; the workflow checks it before posting');
  else {
    const problem = require('./buffer').quotaProblem(rate, require('./run').briefQuotaNeed(Object.values(require('./config').CHANNEL_SETS).reduce((n, ids) => n + Object.keys(ids).length, 0), NETWORKS.length));
    if (problem) throw new Error(`not dispatching: ${problem}`);
    console.log(`Buffer quota: ${rate.remaining} request(s) left`);
  }
  const { getBriefFile, putBriefFile } = require('./host');
  const manifest = await getBriefFile(hash, 'manifest.json');
  if (!manifest) throw new Error(`brief ${hash}: no manifest stored; run --preview first`);
  if (briefs.hashManifest(manifest) !== hash) throw new Error(`brief ${hash}: stored manifest does not match its hash`);
  await putBriefFile(hash, 'approval.json', { words, at: new Date().toISOString() });
  console.log(`Approval stored for ${hash}; dispatching social-autopost.yml`);
  // GitHub keeps one pending run per concurrency group: a brief run waiting behind a
  // running one is cancelled when the next hourly run queues. Dispatch again then.
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync('node', [path.join(ROOT, 'scripts', 'cloud-dispatch.js'), 'social-autopost.yml', '-f', `brief=${hash}`, '--wait', '--timeout=60'], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (!/Conclusion: cancelled/.test(r.stdout || '')) break;
    if (attempt < 3) console.log(`The run was cancelled while queued; dispatching again (attempt ${attempt + 1} of 3)`);
  }
  const ok = printEntry(hash, ledgerEntry(hash));
  if (r.status !== 0) throw new Error(`the workflow run did not succeed (exit ${r.status}); see the run above`);
  if (!ok) throw new Error('the run finished but wrote no ledger entry for this brief');
}

async function main() {
  if (flag('preview')) return preview();
  if (arg('post')) return post(arg('post'));
  if (arg('status')) { printEntry(arg('status'), ledgerEntry(arg('status'))); return; }
  throw new Error('use --preview, --post=HASH or --status=HASH (see the header of this file)');
}

if (require.main === module) {
  main().catch(err => { console.error(`[brief] ${err.message}`); process.exit(1); });
}

module.exports = { printEntry };
