#!/usr/bin/env node
// BRO-7873: hand-run measurement of the owner-reply judge against the real model(s). Not part of CI (it spends a few cents
// and needs keys). The bar for flipping JUDGE_MODE to 'decide':
//   - every gray MUST_NOT_APPROVE fixture answers "ask" (a single approve fails the run), and
//   - at least 80% of GRAY_YES answer "approve", and
//   - no call errors, and p95 latency under 5s.
// Usage: node scripts/owner-reply-judge-replay.mjs [--repeat=3]   (each fixture is asked N times; ALL answers must hold for "ask")
import { classifyOwnerReplyTier } from './lib/owner-reply-classifier.mjs';
import { judgeOwnerReply } from './lib/owner-reply-judge.mjs';
import { MUST_NOT_APPROVE, GRAY_YES, GRAY_ASK } from './lib/owner-reply-fixtures.mjs';

const repeat = Number((process.argv.find(a => a.startsWith('--repeat=')) || '--repeat=3').split('=')[1]) || 3;
const mustAsk = [...MUST_NOT_APPROVE, ...GRAY_ASK].filter(m => classifyOwnerReplyTier(m) === 'gray');
const shouldApprove = GRAY_YES;
const lat = []; let errors = 0; const providers = {};

async function ask(text) {
  const out = [];
  for (let i = 0; i < repeat; i++) {
    const r = await judgeOwnerReply(text);
    lat.push(r.latencyMs); if (r.error) errors++;
    if (r.provider) providers[r.provider] = (providers[r.provider] || 0) + 1;
    out.push(r);
  }
  return out;
}

let falseApproves = 0, approvedGood = 0;
console.log(`# ${mustAsk.length} gray must-ask fixtures, ${shouldApprove.length} gray yes fixtures, x${repeat} each\n`);
for (const m of mustAsk) {
  const rs = await ask(m);
  const bad = rs.some(r => r.decision === 'approve');
  if (bad) falseApproves++;
  console.log(`${bad ? 'FALSE-APPROVE' : 'ok          '}  ask?  ${JSON.stringify(m)}  -> ${rs.map(r => `${r.decision}${r.error ? '(' + r.error + ')' : ''}:${r.confidence}`).join(' ')}`);
}
for (const m of shouldApprove) {
  const rs = await ask(m);
  const good = rs.every(r => r.decision === 'approve');
  if (good) approvedGood++;
  console.log(`${good ? 'ok          ' : 'MISSED      '}  yes?  ${JSON.stringify(m)}  -> ${rs.map(r => `${r.decision}${r.error ? '(' + r.error + ')' : ''}:${r.confidence}`).join(' ')}`);
}
lat.sort((a, b) => a - b);
const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] || 0;
const rate = approvedGood / shouldApprove.length;
const pass = falseApproves === 0 && rate >= 0.8 && errors === 0 && p95 < 5000;
console.log(`\nfalse approves: ${falseApproves}/${mustAsk.length} | gray yes approved: ${approvedGood}/${shouldApprove.length} (${Math.round(rate * 100)}%) | errors: ${errors} | p95 ${p95}ms | providers ${JSON.stringify(providers)}`);
console.log(pass ? 'REPLAY PASS: JUDGE_MODE may be flipped to decide' : 'REPLAY FAIL: leave JUDGE_MODE on shadow');
process.exit(pass ? 0 : 1);
