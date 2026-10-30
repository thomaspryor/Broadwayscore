// Owner decisions are for owner calls only (money, irreversible actions,
// emails to real people, taste). A digest row with decision:true skips the
// auto-fix worker and lands in "N decisions for you". On 2026-10-30 the digest
// asked 93 of them, 90 being tour candidates a model could settle (owner: "these
// are all silly ones that a model can make the decision on").
//
// This pins every sender allowed to set decision:true. A new one fails here
// until it is added to OWNER_CALL_SENDERS with the owner call it asks for.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldRouteTourCandidate } = require('./tour-roundup-candidate.js');

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const OWNER_CALL_SENDERS = {
  'check-linear-cap.js': 'money: the Linear plan limit is a paid-plan choice',
  'check-provider-spend.js': 'money: raise a provider budget or cut spend',
  'codex-trust-ladder.js': 'trust: how much unreviewed work an outside model may land',
};

// A literal decision:true or a computed one (decision: !!x, decision: flag).
// decision:false and the router's own plumbing are not senders.
const DECISION_RE = /\bdecision:\s*(?!false\b|null\b|undefined\b)(true\b|!)/;
const PLUMBING = new Set(['lib/owner-alert-router.js', 'lib/digest-autofix.js', 'lib/autonomous-email-render.js']);

function sources(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sources(path.join(dir, e.name), r));
    else if (/\.(c?js|mjs)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(r);
  }
  return out;
}

test('only the allowlisted senders ask the owner for a decision', () => {
  const found = sources(SCRIPTS).filter(rel => {
    if (PLUMBING.has(rel)) return false;
    const src = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8');
    return /routeAlert|queueDigestLine/.test(src) && DECISION_RE.test(src);
  });
  const unexpected = found.filter(f => !OWNER_CALL_SENDERS[f]);
  assert.deepStrictEqual(unexpected, [], `These set decision:true but are not owner calls. Route them as fix rows (decision:false) so a worker settles them, or add them to OWNER_CALL_SENDERS with the money/irreversible/taste call they ask: ${unexpected.join(', ')}`);
  for (const f of Object.keys(OWNER_CALL_SENDERS)) assert.ok(found.includes(f), `${f} no longer asks a decision; drop it from OWNER_CALL_SENDERS`);
});

test('route-tour-candidates never asks the owner', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'route-tour-candidates.js'), 'utf8');
  assert.match(src, /decision:\s*false/);
  assert.doesNotMatch(src, /decisionPrompt/);
});

test('an ended tour is not routed; a running or two-company one is', () => {
  assert.equal(shouldRouteTourCandidate({ ended: true, segmentStart: '2023-02-11', segmentEnd: '2023-08-06' }), false);
  assert.equal(shouldRouteTourCandidate({ ended: true, needsClassification: true }), false);
  assert.equal(shouldRouteTourCandidate({ segmentStart: '2026-09-20' }), true);
  assert.equal(shouldRouteTourCandidate({ ended: true, ambiguous: 'a / b' }), true);
  assert.equal(shouldRouteTourCandidate(null), false);
});
