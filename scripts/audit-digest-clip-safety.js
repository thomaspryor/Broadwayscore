#!/usr/bin/env node
/**
 * Lint: every routeAlert() description/decisionPrompt with a
 * statically-checkable text (a plain string or a template literal's static
 * leading text) must pass headStandsAlone()'s structural checks
 * (scripts/lib/owner-alert-router.js).
 *
 * Card #1078: the digest clips every queued row's description to 200 chars
 * (autonomous-email-render.js). headStandsAlone() catches a bad head at
 * QUEUE TIME via console.warn — but that only fires when the code path
 * actually runs, so a violation can sit unnoticed in server logs for weeks.
 * This is the PR-time version of the same check: it statically extracts
 * what it can from every routeAlert() call site and fails CI immediately
 * if a description opens on a bracket tag or an indented detail line — the
 * exact class that shipped as [direction] in audit-tier-skip-drift.js.
 *
 * Deliberately narrow: only checks the literal source text a session wrote,
 * never the runtime-interpolated value (v.reason, r.message, etc.) — those
 * still rely on headStandsAlone()'s runtime warn. A caller whose ENTIRE
 * description is a bare variable (no template literal, no string literal)
 * is not statically checkable and is skipped, not flagged.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { headStandsAlone } = require('./lib/owner-alert-router.js');

const REPO_ROOT = path.join(__dirname, '..');

function findCallSites() {
  let grepOut;
  try {
    grepOut = execSync('grep -rl "routeAlert(" scripts/ --include="*.js"', { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (e) {
    // grep -l exits 1 (not an error) when nothing matches — e.g. every
    // routeAlert() caller is ever moved/removed. Only a genuine grep
    // failure (exit 2+) should propagate.
    if (e.status === 1) return [];
    throw e;
  }
  const files = grepOut
    .trim().split('\n').filter(Boolean)
    .filter((f) => !f.endsWith('.test.mjs') && f !== 'scripts/lib/owner-alert-router.js');

  const sites = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const re = /routeAlert\(\{/g;
    let m;
    while ((m = re.exec(src))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (depth > 0 && i < src.length) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      const body = src.slice(start, i - 1);
      // Line number of the call, for a useful error location.
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ file, line, body });
    }
  }
  return sites;
}

function extractField(body, name) {
  const re = new RegExp(`${name}:\\s*([\\s\\S]*?)(?:,\\s*\\n\\s*\\w+:|,\\s*\\w+:|\\n\\s*\\})`);
  const m = body.match(re);
  return m ? m[1] : null;
}

// Extracts the static leading text of a template/string literal expression:
// the whole string for a plain literal, or the text before the first
// ${...} for a template literal. Returns null when the expression isn't
// statically checkable at all (starts with a bare identifier/call).
function staticPrefix(expr) {
  const trimmed = expr.trim();
  if (/^`/.test(trimmed)) {
    const afterBacktick = trimmed.slice(1);
    const interpIdx = afterBacktick.indexOf('${');
    const raw = interpIdx === -1 ? afterBacktick : afterBacktick.slice(0, interpIdx);
    return raw.replace(/`[,;]?\s*$/, '');
  }
  if (/^'/.test(trimmed) || /^"/.test(trimmed)) {
    return trimmed.slice(1).replace(/['"][,;]?\s*$/, '');
  }
  return null;
}

// Returns the full literal string ONLY when the expression is entirely
// static (no ${...} anywhere) — used for `title`, which headStandsAlone()
// needs in full to check decisionPrompt's subject rule. A dynamic title
// means the real value isn't knowable at lint time, so the caller should
// skip the subject check rather than guess.
function fullStaticText(expr) {
  const trimmed = expr.trim();
  if (/^`/.test(trimmed) && !trimmed.includes('${')) {
    return trimmed.slice(1).replace(/`[,;]?\s*$/, '');
  }
  if (/^'/.test(trimmed) || /^"/.test(trimmed)) {
    return trimmed.slice(1).replace(/['"][,;]?\s*$/, '');
  }
  return null;
}

function main() {
  const sites = findCallSites();
  const violations = [];
  let checked = 0;

  for (const site of sites) {
    const titleExpr = extractField(site.body, 'title');
    const title = titleExpr ? fullStaticText(titleExpr) : null;

    // description: rendered as "<b>title</b> — description" — the
    // unclipped title always carries the subject, so no subject check here
    // (mirrors queueDigestLine()'s own call to headStandsAlone(description)).
    const descExpr = extractField(site.body, 'description');
    if (descExpr) {
      const prefix = staticPrefix(descExpr);
      if (prefix !== null && prefix.length > 0) {
        checked++;
        const result = headStandsAlone(prefix);
        if (!result.ok) violations.push({ ...site, field: 'description', reason: result.reason, prefix: prefix.slice(0, 80) });
      }
    }

    // decisionPrompt: rendered under a bare "Decision needed:" label with
    // no title prefix, so it DOES need the subject check (mirrors
    // queueDigestLine()'s headStandsAlone(decisionPrompt, title)).
    const promptExpr = extractField(site.body, 'decisionPrompt');
    if (promptExpr) {
      const prefix = staticPrefix(promptExpr);
      if (prefix !== null && prefix.length > 0) {
        checked++;
        const result = headStandsAlone(prefix, title || undefined);
        if (!result.ok) violations.push({ ...site, field: 'decisionPrompt', reason: result.reason, prefix: prefix.slice(0, 80) });
      }
    }
  }

  console.log(`audit-digest-clip-safety: checked ${checked} statically-checkable field(s) across ${sites.length} routeAlert() call site(s)`);

  if (violations.length) {
    console.error(`\n${violations.length} field(s) would clip into an unreadable digest fragment:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.field} — ${v.reason}`);
      console.error(`    "${v.prefix}${v.prefix.length >= 80 ? '…' : ''}"`);
    }
    console.error('\nFront-load the field so its own opening words name the subject — see scripts/audit-tier-skip-drift.js history for the fix pattern.');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { __test: { extractField, staticPrefix, fullStaticText } };
