/**
 * BRO-7448 class guard: a Playwright script that AUTOMATION runs must be able
 * to launch Chromium in a cloud session.
 *
 * scripts/generate-biz-og-images.js called a bare `chromium.launch()`. The
 * repo pins playwright ^1.58, which looks for chromium build 1234 under
 * PLAYWRIGHT_BROWSERS_PATH; the cloud image ships build 1243 and sets
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so that call dies with "Executable doesn't
 * exist". scripts/lib/playwright-exe.js (BRO-6258) exists precisely to fix
 * that, and returns {} on the Mac and in GitHub Actions, so adopting it is a
 * no-op everywhere else.
 *
 * The consequence was not a crash anyone saw: it was a health row nobody could
 * clear. "Commercial: season share cards" warned that season-2006-2007.png was
 * missing, the only renderer was a Chromium script, and the only automated
 * hands available (a cloud worker) could not run it. Nine more scripts that
 * workflows invoke had the same bare launch.
 *
 * This test is the check that should have caught that and did not exist. It is
 * a STATIC source scan: it never imports or runs the scripts, so a scraper
 * cannot fire a network call from the test suite.
 *
 * EXEMPT: scripts that need a human at a screen — they drive the owner's real,
 * logged-in Chrome profile (`channel: 'chrome'`) or open a headful window for
 * someone to log in by hand (`headless: false`). Those are Mac-only by design:
 * a cloud container has no human and no paywall session, and an executablePath
 * override would fight the `channel` option. They are listed by name below, so
 * adding a new one is a deliberate act, not an oversight, and the second test
 * fails if a listed script stops carrying one of those two markers (which is
 * how scripts/test-paywalled-access.js was caught being on this list while
 * being an ordinary headless launch — it is now fixed, not exempt).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(ROOT, 'scripts');
const WORKFLOWS = path.join(ROOT, '.github/workflows');

/** Scripts needing a human at a screen: Mac-only by design, see the header. */
const NEEDS_A_HUMAN = new Set([
  'export-cookies.js',
  'newspapers-com-extract.js',
  'recover-wsj-browser.js',
  'wsj-otp-login.js',
]);

/** The two markers that justify an exemption. */
const REAL_CHROME = /channel:\s*['"]chrome['"]/;
const HEADFUL = /headless:\s*false/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name) && !/\.test\.(m|c)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function workflowText() {
  if (!fs.existsSync(WORKFLOWS)) return '';
  return fs.readdirSync(WORKFLOWS)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'))
    .join('\n');
}

/**
 * The other kind of automated caller: a health-check row whose hint tells
 * whoever picks up the card which command to run. generate-biz-og-images.js is
 * run by NO workflow — its only caller is the hint on the "Commercial: season
 * share cards" row ("Run node scripts/generate-biz-og-images.js"). A worker
 * handed that command in a cloud session must be able to run it, or the row
 * can never be cleared by anything but a human on a Mac. That is exactly how
 * BRO-7448 sat open.
 */
function remediationText() {
  const files = [path.join(SCRIPTS, 'health-check.js')];
  const libDir = path.join(SCRIPTS, 'lib');
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) {
      if (/^audit-.*\.js$/.test(f) && !/\.test\./.test(f)) files.push(path.join(libDir, f));
    }
  }
  return files.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

const LAUNCH_CALL = /chromium\s*\.\s*launch(?:PersistentContext)?\s*\(/g;

/**
 * Blank out comments, keeping every byte position (so reported line numbers
 * stay true). Without this, a doc comment that EXPLAINS the bug — playwright-exe.js
 * and collect-review-texts.js both narrate "chromium.launch()" in prose — is
 * scanned as a bare launch site and the guard cries wolf at the very files
 * that implement the fix.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * The argument text of one call, from its open paren to the matching close.
 * Per-CALL-SITE, not per-file: a file that handles its first launch and then
 * adds a bare second one was invisible to a whole-file `handled` test, which
 * is precisely how a regression would slip back in (ship-check finding).
 */
function callArgs(src, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
  }
  return src.slice(openParenIndex + 1);
}

/** Resolve a relative require/import specifier to a file under scripts/. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * Everything automation can reach: the scripts named by a workflow step or a
 * health-check hint, PLUS every local module they require, transitively.
 * scripts/lib/autonomous-ui-capture.js is named by no workflow and no hint —
 * it is required by scripts/autonomous-run.js, which autonomous-merge.yml
 * runs — and it was calling a bare chromium.launch(). A basename-only scope
 * could never see it (ship-check finding).
 */
function automationReachable(wf, hints) {
  const all = walk(SCRIPTS);
  const seeds = all.filter((f) => {
    const base = path.basename(f);
    return wf.includes(base) || hints.includes(base);
  });
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.pop();
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/from\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(m => m[1]);
    for (const spec of specs) {
      const target = resolveLocal(file, spec);
      if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

test('every automation-reachable Playwright launch can find Chromium in a cloud session', () => {
  if (!fs.existsSync(SCRIPTS)) {
    assert.fail('scripts/ not found — the guard would pass vacuously');
  }
  const wf = workflowText();
  assert.ok(wf.length > 0, 'no workflow files read — the guard would pass vacuously');
  const hints = remediationText();
  assert.ok(hints.length > 0, 'no health-check source read — the guard would pass vacuously');

  // Only code automation actually reaches: a workflow step, a health-check
  // hint handed to whoever works the card, or anything those require. A
  // one-off local screenshot script failing in cloud costs a person one
  // command; these cost a pipeline, or a health row nothing can ever clear.
  const reachable = automationReachable(wf, hints);

  const offenders = [];
  let launchSites = 0;
  let handledSites = 0;
  for (const file of reachable) {
    if (NEEDS_A_HUMAN.has(path.basename(file))) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    LAUNCH_CALL.lastIndex = 0;
    let m;
    while ((m = LAUNCH_CALL.exec(src)) !== null) {
      launchSites++;
      const args = callArgs(src, m.index + m[0].length - 1);
      // The import alone is not enough: a file can require playwright-exe and
      // still call a bare chromium.launch(). Only THIS call's options count.
      if (/launchExtras\s*\(/.test(args) || /executablePath/.test(args) || REAL_CHROME.test(args)) {
        handledSites++;
      } else {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }
  }

  assert.ok(launchSites > 0, 'no automation-reachable Playwright launch was scanned — the guard would pass vacuously');
  assert.equal(
    handledSites + offenders.length,
    launchSites,
    'every launch site must be counted exactly once as handled or as an offender',
  );
  assert.deepEqual(
    offenders,
    [],
    `these automation-reachable launch sites call chromium.launch() with no cloud fallback, so they die with `
    + `"Executable doesn't exist" in a cloud session (BRO-7448). Fix: import launchExtras from `
    + `scripts/lib/playwright-exe.js and spread it into THAT CALL's options — it returns {} on the Mac `
    + `and in GitHub Actions, so nothing else changes:\n  ${offenders.join('\n  ')}`,
  );
});

test('the exemption list names only scripts that really need a human at a screen', () => {
  for (const base of NEEDS_A_HUMAN) {
    const matches = walk(SCRIPTS).filter(f => path.basename(f) === base);
    assert.equal(matches.length, 1, `exempt script ${base} not found exactly once under scripts/`);
    const src = fs.readFileSync(matches[0], 'utf8');
    assert.ok(
      REAL_CHROME.test(src) || HEADFUL.test(src),
      `${base} is exempt from the cloud-chromium guard but drives neither a real Chrome profile nor a `
      + 'headful window, so nothing stops it running in cloud — drop it from NEEDS_A_HUMAN and give it '
      + 'the launchExtras fallback',
    );
  }
});
