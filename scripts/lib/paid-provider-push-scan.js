'use strict';
/**
 * BRO-2984 — "a unit-test workflow must not spend money at paid providers on
 * every push."
 *
 * The incident: `.github/workflows/test.yml`'s `data-validation` job ran
 * `node scripts/validate-show-venue.js --all-provisional --fail-on-mismatch`
 * with SCRAPINGBEE_API_KEY + BRIGHTDATA_TOKEN in its step `env:`, on EVERY push
 * to main. `data/audit/scraper-spend-ledger.jsonl` carried 222 rows attributed
 * to workflow "Test Suite" in a ~2-day window (219 Bright Data serp-unlocker +
 * 3 ScrapingBee SERP at 25 credits each), all from that one script, and the
 * step re-fetched ~86 Playbill pages at ~12s each per push.
 *
 * This module is the permanent prevention. It answers one question about one
 * workflow file: *if this workflow runs on push, can any of its steps spend
 * money at a paid provider?* Two independent signals, because either alone has
 * a hole:
 *
 *   1. CREDENTIALS (the money signal). A step whose `env:` maps a paid-provider
 *      secret INTO the process. Without a key a scraper cannot bill anything,
 *      so this is the invariant that actually controls spend — and it catches
 *      the next script nobody has written yet, not just today's.
 *
 *   2. KNOWN SPENDY COMMANDS (the intent signal). A `run:` line invoking a
 *      command known to sweep paid providers. Redundant with (1) today, kept
 *      because a future job-level or workflow-level `env:` block would hand a
 *      step credentials without any step-level mapping for (1) to see.
 *
 * Deliberately NOT flagged: a `secrets.X != ''` PRESENCE TEST. test.yml's own
 * `HAS_SCRAPE_SECRETS: ${{ (secrets.SCRAPINGBEE_API_KEY != '' && ...) }}`
 * gate compares a secret to the empty string to decide whether to skip; it
 * never passes the VALUE to a process, so it cannot bill. Flagging it would
 * have made the rule unusable on the exact file it exists to protect.
 *
 * Scope note (known, deliberate): only `on.push` counts as "every push".
 * `pull_request` is excluded — fork PRs do not receive secrets, and this repo's
 * merge flow pushes to main directly (memory/feedback_branch_protection_direct_push).
 * A workflow that spends on `pull_request` is a real but different problem.
 *
 * Escape hatch: `# paid-provider-ok: <reason>` anywhere in the workflow file.
 * As of BRO-2984 no workflow uses it — of this repo's 11 push-triggered
 * workflows, test.yml was the ONLY one exposing any paid-provider secret, so
 * the allowlist is empty by construction rather than by policy. Adding an entry
 * should require explaining why a push must cost money.
 */

/**
 * Secrets that map to metered, billed third-party APIs. Grounded in what this
 * repo actually references (`grep -o 'secrets\.[A-Z_]*' .github/workflows/`),
 * not a speculative list. Non-billing companions of the same providers
 * (BRIGHTDATA_ZONE, BROWSERBASE_PROJECT_ID, BRIGHTDATA_CUSTOMER_ID) are
 * deliberately absent: they are routing/identity config, useless without the
 * token beside them, and including them would only produce duplicate findings
 * on a step the token already flags.
 */
const PAID_PROVIDER_SECRETS = [
  // Scraping / SERP — fetchPage()'s provider chain (scripts/lib/scraper.js).
  'SCRAPINGBEE_API_KEY',
  'BRIGHTDATA_TOKEN',
  'SCRAPINGDOG_API_KEY',
  'BROWSERBASE_API_KEY',
  // LLM inference — metered per token. None are exposed in any push-triggered
  // workflow today; listed so wiring an LLM scorer into CI trips this rule
  // instead of quietly becoming a per-push bill.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
];

/**
 * Commands that sweep a paid provider across an unbounded target list. Matched
 * as script + flag together: `validate-show-venue.js --show=<id>` is a single
 * lookup an operator runs by hand per CLAUDE.md §3 and is NOT the sweep this
 * rule is about.
 */
const PAID_SWEEP_COMMANDS = [
  {
    pattern: /validate-show-venue\.js[^\n]*--all-provisional/,
    label: 'validate-show-venue.js --all-provisional (BRO-2984: ~86 Playbill fetches/run)',
  },
];

const EXEMPTION_MARKER = 'paid-provider-ok:';

const indentOfLine = (line) => line.length - line.replace(/^ +/, '').length;

/** Strip a YAML comment, honoring `#` inside quotes so a URL fragment isn't eaten. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/**
 * True when the workflow's top-level `on:` block declares a `push:` trigger.
 *
 * Text-scanned rather than YAML-parsed on purpose: `on` is the YAML 1.1
 * boolean `true`, so `yaml.load()` returns it under the key `true`, and every
 * consumer has to special-case that. A small scanner of the `on:` block avoids
 * the footgun and keeps this module dependency-free (js-yaml is not a declared
 * dependency of this repo — it is only present transitively).
 */
function hasPushTrigger(raw) {
  const lines = raw.split('\n');
  let inOn = false;
  let minTriggerIndent = null;
  for (const line of lines) {
    // `on` is the YAML 1.1 boolean true, so some authors quote it. Accept
    // "on":/'on': as well as bare on: — scripts/audit-workflow-hygiene.js's own
    // trigger finder already tolerates the quoted form, and disagreeing with it
    // would let a workflow read as push-triggered by one gate and not the other.
    if (/^['"]?on['"]?\s*:/.test(line)) {
      // Inline forms: `on: push` / `on: [push, schedule]`, possibly with a
      // trailing comment (`on: push  # every merge`).
      const inline = stripComment(line.slice(line.indexOf(':') + 1)).trim();
      if (inline) {
        if (/^\[.*\]$/.test(inline)) {
          return inline
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim())
            .includes('push');
        }
        return inline === 'push';
      }
      inOn = true;
      continue;
    }
    if (!inOn) continue;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // A non-indented line ends the `on:` block.
    if (!/^\s/.test(line)) break;
    // The first indented key establishes the trigger-name depth; anything
    // deeper is a trigger's OPTIONS (e.g. `workflow_run: workflows: [push]`),
    // not a trigger.
    if (minTriggerIndent === null) minTriggerIndent = indentOfLine(line);
    // An indented key directly under `on:` is a trigger name. Matched at any
    // depth >= 1 rather than exactly 2 spaces: a 4-space-indented workflow is
    // valid YAML and would otherwise read as NOT push-triggered, which fails
    // open (the dangerous direction for a spend gate).
    if (/^\s+push\s*:/.test(line) && indentOfLine(line) <= minTriggerIndent) return true;
  }
  return false;
}

/**
 * Find `env:` mappings that hand a paid-provider secret's VALUE to a process.
 *
 * Matches `NAME: ${{ secrets.PAID_KEY }}` (with optional `||` fallbacks), and
 * skips any expression containing a comparison operator — that is a presence
 * test, not a credential hand-off. See the module docblock.
 */
function findPaidSecretEnvLines(raw) {
  const hits = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    // Hyphens are allowed in the key: `api-key: ${{ secrets.X }}` is the
    // conventional spelling for a composite-action `with:` input, and excluding
    // `-` silently missed that whole shape. The value may be quoted.
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*["']?(\$\{\{.*\}\})["']?\s*$/);
    if (!m) continue;
    const [, envName, expr] = m;
    // A comparison means the expression yields a boolean about the secret,
    // never the secret itself. `!=` / `==` are the only forms in use here.
    if (/[!=]=/.test(expr)) continue;
    for (const secret of PAID_PROVIDER_SECRETS) {
      if (new RegExp(`secrets\\.${secret}\\b`).test(expr)) {
        hits.push({ line: i + 1, envName, secret, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

/**
 * `secrets: inherit` on a reusable-workflow call hands the CALLED workflow every
 * secret this repo has, paid providers included, without naming one. Nothing
 * else in this scanner can see that, so it is its own check.
 */
function findSecretsInherit(raw) {
  const hits = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    if (/^\s*secrets\s*:\s*inherit\s*$/.test(stripComment(lines[i]))) {
      hits.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

/** Find non-comment `run:`-block lines invoking a known paid sweep command. */
function findPaidSweepCommands(raw) {
  const hits = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const code = stripComment(line);
    for (const { pattern, label } of PAID_SWEEP_COMMANDS) {
      if (pattern.test(code)) hits.push({ line: i + 1, label, text: line.trim() });
    }
  }
  return hits;
}

/**
 * Scan one workflow's raw YAML.
 *
 * @param {string} raw       workflow file contents
 * @param {string} filename  for reporting, e.g. 'test.yml'
 * @returns {{file: string, pushTriggered: boolean, exempt: boolean,
 *            secretExposures: Array, sweepCommands: Array, violations: Array}}
 */
function scanWorkflow(raw, filename = '<workflow>') {
  const pushTriggered = hasPushTrigger(raw);
  const exempt = raw.includes(EXEMPTION_MARKER);
  const secretExposures = pushTriggered ? findPaidSecretEnvLines(raw) : [];
  const sweepCommands = pushTriggered ? findPaidSweepCommands(raw) : [];
  const secretsInherit = pushTriggered ? findSecretsInherit(raw) : [];

  const violations = [];
  if (pushTriggered && !exempt) {
    for (const h of secretExposures) {
      violations.push({
        file: filename,
        line: h.line,
        kind: 'paid-secret-in-push-workflow',
        message: `${filename}:${h.line} maps ${h.secret} into a step's env in a push-triggered workflow (${h.envName})`,
      });
    }
    for (const h of sweepCommands) {
      violations.push({
        file: filename,
        line: h.line,
        kind: 'paid-sweep-command-in-push-workflow',
        message: `${filename}:${h.line} runs ${h.label} in a push-triggered workflow`,
      });
    }
    for (const h of secretsInherit) {
      violations.push({
        file: filename,
        line: h.line,
        kind: 'secrets-inherit-in-push-workflow',
        message:
          `${filename}:${h.line} uses \`secrets: inherit\` in a push-triggered workflow — ` +
          'that forwards every secret, paid providers included, without naming one',
      });
    }
  }
  return {
    file: filename,
    pushTriggered,
    exempt,
    secretExposures,
    sweepCommands,
    secretsInherit,
    violations,
  };
}

module.exports = {
  PAID_PROVIDER_SECRETS,
  PAID_SWEEP_COMMANDS,
  EXEMPTION_MARKER,
  hasPushTrigger,
  findPaidSecretEnvLines,
  findPaidSweepCommands,
  findSecretsInherit,
  scanWorkflow,
};
