#!/usr/bin/env node
// BRO-7552: dry run for the effect-pending gate. Two corpora:
//   1. Linear: the newest EFFECT value on each recently updated card, and how many the pending rule (isPendingEffect)
//      would call "not measured". Needs LINEAR_API_KEY. This is the hit rate of the card-level rule and an upper
//      bound for the Stop check (which also needs a "verified" closing claim).
//   2. Transcripts (default: ~/.claude/projects/*/*.jsonl, or paths given): every SAFE TO ARCHIVE message is replayed
//      through the Stop check with the events before it; prints how many would block and why.
// Usage: node scripts/effect-pending-dryrun.mjs [--cards=250] [--no-linear] [transcript.jsonl ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { walkTranscript } from './lib/transcript-scan.mjs';
import { claimsSafeToArchive } from './lib/review-coverage.mjs';
import { stopHookDecision, lastEffectLine } from './lib/effect-pending-stop.mjs';

const require = createRequire(import.meta.url);
const { isPendingEffect } = require('./lib/root-cause-close.js');
const argv = process.argv.slice(2);
const flag = (n, d) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;

async function linearCorpus(limit) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return { skipped: 'LINEAR_API_KEY not set' };
  const q = `query($n:Int!){issues(first:$n,orderBy:updatedAt){nodes{identifier title state{name} comments(first:60){nodes{body createdAt}}}}}`;
  let j;
  try { j = await require('./lib/linear-client.js').graphql(q, { n: Math.min(limit, 100) }); } catch (e) { return { skipped: `linear read failed: ${e.message}` }; }
  const nodes = (j?.data || j)?.issues?.nodes;
  if (!nodes) return { skipped: `no data: ${JSON.stringify(j).slice(0, 200)}` };
  const withEffect = [];
  for (const c of nodes) {
    const bodies = c.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((x) => x.body);
    const v = lastEffectLine(bodies.join('\n'));
    if (v) withEffect.push({ id: c.identifier, state: c.state?.name, value: v, pending: isPendingEffect(v) });
  }
  return { cards: nodes.length, withEffect };
}

function replay(files) {
  let claims = 0; let blocks = 0; const hits = [];
  for (const f of files) {
    const events = walkTranscript(f);
    events.forEach((e, i) => {
      if (e.kind !== 'assistant_text' || !claimsSafeToArchive(e.text)) return;
      claims++;
      const d = stopHookDecision({ lastMessage: e.text, events: events.slice(0, i), env: { CLAUDE_CODE_REMOTE: 'true' } });
      if (d.decision === 'block') { blocks++; hits.push({ file: path.basename(f), at: i, reason: d.reason }); }
    });
  }
  return { files: files.length, claims, blocks, hits };
}

const files = argv.filter((a) => !a.startsWith('--')).length ? argv.filter((a) => !a.startsWith('--')) : (() => {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try { return fs.readdirSync(root).flatMap((d) => { try { return fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.jsonl')).map((x) => path.join(root, d, x)); } catch { return []; } }); } catch { return []; }
})();

const out = { transcripts: replay(files) };
if (!argv.includes('--no-linear')) {
  const l = await linearCorpus(Number(flag('cards', 100)));
  out.linear = l.skipped ? l : { cards: l.cards, withEffect: l.withEffect.length, pending: l.withEffect.filter((x) => x.pending).length, pendingRate: l.withEffect.length ? +(l.withEffect.filter((x) => x.pending).length / l.withEffect.length).toFixed(3) : null, examples: l.withEffect.filter((x) => x.pending).slice(0, 8).map((x) => `${x.id} [${x.state}] ${x.value.slice(0, 90)}`) };
}
console.log(JSON.stringify(out, null, 2));
