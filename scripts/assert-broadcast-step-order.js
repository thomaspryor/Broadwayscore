#!/usr/bin/env node
// scripts/assert-broadcast-step-order.js
//
// Guards .github/workflows/opening-night-broadcast.yml against the #1407
// regression: the checklist_gate step ran opening-night-checklist.js before
// node_modules existed (setup-node/npm ci ran too late in the job), so any
// script needing an npm dependency (cheerio, via
// scripts/lib/page-validator.js <- scripts/gather-reviews.js <-
// scripts/opening-night-checklist.js) crashed with MODULE_NOT_FOUND on every
// run — the gate then failed closed on the crash, blocking every broadcast.
// Same bug class as task #1073 (opening-night-checklist.yml), fixed there by
// moving the shared setup-node composite action ahead of the first script
// invocation; this guard keeps that ordering from regressing here.
//
// Scans actual step lines only (`uses:`/`run:` fields), never comments — a
// prose comment mentioning "npm ci" or "checklist_gate" (this file's own
// header is a good example) must never satisfy the check. Same
// comment-skipping convention as scripts/audit-workflow-hygiene.js's
// runLineMatches().

const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'opening-night-broadcast.yml');

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

// Find the line index (0-based) of the first real node-install step: either
// the shared composite (`uses: ./.github/actions/setup-node`, which runs
// `npm ci` internally — see .github/actions/setup-node/action.yml) or a raw
// inline/block `npm ci` step, in case this ever reverts to the un-shared form.
function findNodeInstallLine(lines) {
  let inRunBlock = false;
  let runIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();
    if (stripped.startsWith('#')) continue;

    if (!inRunBlock && /^(?:-\s*)?uses:\s*\.\/\.github\/actions\/setup-node\b/.test(stripped)) {
      return i;
    }

    const runMatch = stripped.match(/^run\s*:\s*(.*?)\s*$/);
    if (runMatch) {
      const content = runMatch[1];
      const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
      if (isBlockScalar) {
        inRunBlock = true;
        runIndent = indentOf(line);
        continue;
      }
      inRunBlock = false;
      if (/^npm ci\b/.test(content.trim())) return i;
      continue;
    }

    if (inRunBlock) {
      if (stripped !== '' && indentOf(line) <= runIndent) {
        inRunBlock = false;
        i--; // re-examine this line as a fresh (possibly `uses:`) line
        continue;
      }
      if (stripped.startsWith('#')) continue;
      if (/^npm ci\b/.test(stripped)) return i;
    }
  }
  return -1;
}

function findChecklistGateLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith('#')) continue;
    if (/^id:\s*checklist_gate\b/.test(stripped)) return i;
  }
  return -1;
}

// The root checkout — install must come AFTER this, not just before
// checklist_gate, or a future edit could hoist the setup-node step above
// checkout (repo files wouldn't exist yet) while still satisfying the
// install-before-gate check below.
function findCheckoutLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith('#')) continue;
    if (/^uses:\s*actions\/checkout@/.test(stripped)) return i;
  }
  return -1;
}

function main() {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = raw.split('\n');

  const gateLine = findChecklistGateLine(lines);
  if (gateLine === -1) {
    console.error('assert-broadcast-step-order: no `id: checklist_gate` step found — workflow structure changed, update this guard.');
    process.exit(1);
  }

  const installLine = findNodeInstallLine(lines);
  if (installLine === -1) {
    console.error('assert-broadcast-step-order: no node-install step (setup-node composite or `npm ci`) found in the workflow at all.');
    process.exit(1);
  }

  const checkoutLine = findCheckoutLine(lines);
  if (checkoutLine !== -1 && installLine < checkoutLine) {
    console.error(
      `assert-broadcast-step-order: node install (line ${installLine + 1}) runs BEFORE checkout (line ${checkoutLine + 1}) — ` +
      'the repo would not be checked out yet when npm ci runs. Move the setup-node step back after the checkout steps.'
    );
    process.exit(1);
  }

  if (installLine > gateLine) {
    console.error(
      `assert-broadcast-step-order: node install (line ${installLine + 1}) runs AFTER checklist_gate (line ${gateLine + 1}) — ` +
      'node_modules will not exist when the gate script runs (task #1407 regression). ' +
      'Move the setup-node step back to right after the checkout steps, before "Check recovery hold marker".'
    );
    process.exit(1);
  }

  console.log(`OK: node install (line ${installLine + 1}) runs after checkout (line ${checkoutLine + 1}) and before checklist_gate (line ${gateLine + 1}).`);
}

main();
