#!/usr/bin/env node
'use strict';
/**
 * make-html-handoff-plan.js (BRO-5886): fetch a review page from THIS machine
 * (for a site that blocks GitHub runners), encrypt the HTML to the committed
 * handoff key, and write or extend a data/pending-fixes plan whose
 * ingest-html-handoff action execute-approved-fix.yml decrypts and ingests.
 * No review text is written in plain form anywhere in the repo.
 *
 * Usage:
 *   node scripts/make-html-handoff-plan.js --plan=bro-N --show=ID --url=URL \
 *     [--outlet=ID] [--critic="Name"] [--publish-date=YYYY-MM-DD] \
 *     [--html-file=PATH] [--summary="..."] [--description="..."] [--dry-run]
 *
 *   --plan          plan id; writes data/pending-fixes/<plan>.json. If that file
 *                   exists and is still "pending", the action is appended.
 *   --html-file     use HTML already saved (else Playwright fetches --url).
 *   --dry-run       fetch, check and encrypt, but write nothing.
 *
 * Refuses a page whose canonical/og:url does not name --url (CI re-checks).
 * Then `git add -f` the plan (pending-fixes is gitignored), preflight it, land
 * it (git push origin HEAD:refs/heads/land/<name>) and dispatch
 * execute-approved-fix.yml with issue_number=<plan>, plan_id=<printed planId>.
 *
 * A stale review file the ingest would only merge into (wrong byline, fragment
 * body) needs a review-file-op delete action before the handoff action.
 * CI decrypts with the HTML_HANDOFF_PRIVATE_KEY secret. After the run the
 * executor swaps the ciphertext for a hash, but older commits keep it, so a
 * leaked private key exposes every past handoff: rotate by dispatching
 * html-handoff-key.yml with rotate=true. The key is not the trust boundary
 * (any landed plan runs); who can land is. No key or no committed pem yet:
 * dispatch html-handoff-key.yml (mints the pair, saves the secret, commits the pem).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help.js');
const handoff = require('./lib/html-handoff');

const ROOT = path.join(__dirname, '..');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function fetchWithPlaywright(url) {
  const { chromium } = require('playwright');
  const exe = ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
}

function readPlan(file, id) {
  if (!fs.existsSync(file)) {
    return {
      issueNumber: id,
      planId: crypto.randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      submitter: { name: null, email: null },
      plan: { summary: '', steps: [], riskLevel: 'Low', actions: [] },
    };
  }
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.status !== 'pending') throw new Error(`${path.relative(ROOT, file)} has status "${plan.status}"; use a new --plan id`);
  return plan;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const id = arg('plan');
  const showId = arg('show');
  const url = arg('url');
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !showId || !url) {
    console.error('Usage: node scripts/make-html-handoff-plan.js --plan=bro-N --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--html-file=PATH] [--dry-run]');
    return 2;
  }
  const htmlFile = arg('html-file');
  const html = htmlFile ? fs.readFileSync(htmlFile, 'utf8') : await fetchWithPlaywright(url);
  const problem = handoff.htmlUrlProblem(html, url);
  if (problem) { console.error(`Refusing: ${problem}`); return 1; }

  const action = handoff.buildAction({
    showId, url, html,
    outlet: arg('outlet'), critic: arg('critic'), publishDate: arg('publish-date'),
    description: arg('description'),
    publicKeyPem: handoff.loadPublicKey(),
  });
  // Round-trip proof that the envelope is well formed is CI's job (only CI holds the key);
  // here we can only re-check the shape.
  const shapeProblem = handoff.actionProblem(action);
  if (shapeProblem) { console.error(`Refusing: ${shapeProblem}`); return 1; }

  const file = path.join(ROOT, 'data', 'pending-fixes', `${id}.json`);
  const plan = readPlan(file, id);
  plan.plan.actions.push(action);
  plan.plan.steps.push(`Ingest ${showId} from handed-off HTML: ${url}`);
  const summary = arg('summary');
  if (summary) plan.plan.summary = summary;
  else if (!plan.plan.summary) plan.plan.summary = `HTML handoff (BRO-5886): ingest review pages CI runners cannot fetch`;

  console.log(`Page ok: ${html.length} chars, canonical matches ${url}`);
  console.log(`Envelope: ${action.html.ct.length} base64 chars, key ${action.html.kid}`);
  if (arg('dry-run') !== null || process.argv.includes('--dry-run')) { console.log('Dry run: nothing written'); return 0; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT, file)} (${plan.plan.actions.length} action(s)); planId ${plan.planId}`);
  console.log(`Next: git add -f ${path.relative(ROOT, file)} (pending-fixes is gitignored), preflight, land, dispatch.`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { readPlan };
