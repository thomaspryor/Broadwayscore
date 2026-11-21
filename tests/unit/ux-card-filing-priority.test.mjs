// BRO-340: UX-audit and rage-click cards were filed at P1 (Linear priority 2)
// into a class the headless dispatcher refuses (headless-dispatchability.js
// UI_CARD_CLASS_RE: the fix is a UI change that needs owner visual QA). 18
// cards piled up with a 1-in-18 real-defect rate. Neither filer may file this
// class above normal priority (3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UI_CARD_CLASS_RE } = require('../../scripts/lib/headless-dispatchability.js');
const { planFilings, priorityFor } = require('../../scripts/lib/ux-walkthrough-filing.js');
const { qualifyingRageRows, isBackedRageClickIssue } = require('../../scripts/lib/rage-click-summary.js');
const { effectiveCreatePriority } = require('../../scripts/lib/linear-issue-create.js');

const NORMAL = 3; // Linear: 1 urgent, 2 high (old "P1 Next"), 3 normal, 4 low.
const okBoard = { ok: true, titles: ['Unrelated existing card about grosses'] };

test('UX walkthrough never files its cards above normal priority', () => {
  for (const severity of ['high', 'medium', 'low', undefined]) {
    assert.ok(priorityFor({ severity }) >= NORMAL, `severity ${severity} -> ${priorityFor({ severity })}`);
  }
  const plan = planFilings({
    findings: [
      { summary: 'Dead control on the diary sheet date picker', severity: 'high', deterministic: true, models: ['dead-control'] },
      { summary: 'Rate stars overlap the poster bookmark on mobile', severity: 'high', agreementCount: 3, models: ['a', 'b', 'c'] },
    ],
    existing: okBoard,
  });
  assert.equal(plan.toFile.length, 2);
  for (const item of plan.toFile) {
    // Every walkthrough card is in the class the headless lane refuses...
    assert.match(item.title, UI_CARD_CLASS_RE);
    // ...so none may sit in the P1 lane.
    assert.ok(item.priority >= NORMAL, `${item.title} filed at ${item.priority}`);
  }
});

test('the creation chokepoint caps parked UI cards from any filer at normal (friction analyzer path)', () => {
  // posthog-friction-analyzer.js passes the model's priority straight to
  // createLinearIssue({park}); BRO-4487's clamp is what keeps a model-chosen
  // "P1 Next" out of the P1 lane.
  for (const priority of [1, 2]) {
    const r = effectiveCreatePriority({ priority, mode: 'park', title: 'Rage clicks on homepage search input' });
    assert.equal(r.priority, NORMAL);
  }
  assert.equal(effectiveCreatePriority({ priority: 2, mode: 'park', title: 'UX audit: dead control' }).priority, NORMAL);
});

test('the walkthrough no longer parks its cards as an owner taste call (BRO-6478)', () => {
  const src = readFileSync(new URL('../../scripts/ux-walkthrough.mjs', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../../scripts/lib/ux-walkthrough-filing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /auto-dispatch loop picks it up/);
  assert.doesNotMatch(src, /owner taste call/);
  assert.match(src, /'--dispatch'/);
  // Priority no longer carries severity, so the card text must.
  assert.match(lib, /Severity: \$\{f\.severity/);
});

test('element-less rage-click rows never reach the model or back a card', () => {
  const rows = [
    ['/show/hamilton', '', '', '', '', 40, 9], // nothing to name: dropped
    ['/show/wicked', ' \n', null, '', undefined, 30, 7], // whitespace only: dropped
    ['/lotteries', 'Enter lottery', 'button', '', '', 12, 4], // named: kept
  ];
  const q = qualifyingRageRows(rows);
  assert.equal(q.length, 1);
  assert.equal(q[0].page, '/lotteries');
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:show-page:x' }, rows), false);
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:lotteries:enter' }, rows), true);
});
