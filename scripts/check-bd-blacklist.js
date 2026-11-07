#!/usr/bin/env node
/**
 * check-bd-blacklist.js — auto-clear Bright Data zone blacklist entries that
 * are actually GitHub Actions runner IPs.
 *
 * Why: Bright Data's "unknown IP" detector auto-blacklists new source IP
 * ranges on the zone and emails an ACTION REQUIRED alert. GitHub-hosted
 * runners rotate through Azure ranges constantly, so BD repeatedly blocks
 * our own CI (2026-07-27: 158.23.190.0/24 on web_unlocker2, inside GitHub's
 * published 158.23.0.0/16). Every such block silently degrades the scraping
 * fallback chain until someone clicks the removal link in the email.
 *
 * What it does (runs hourly as a step in commercial-rss-poll.yml):
 *   1. GET the zone blacklist (empty response {} = nothing blacklisted).
 *   2. GET GitHub's published Actions ranges from api.github.com/meta
 *      (authenticated when GITHUB_TOKEN is set — unauthenticated /meta is
 *      rate-limited per source IP, which CI runners share).
 *   3. Entries fully inside an Actions IPv4 range → DELETE (our own CI).
 *   4. Parseable IPv4 entries that are NOT GitHub runners → keep + owner
 *      digest (possible credential leak — the one case worth a look).
 *   5. Entries we can't parse (IPv6, odd syntax) → keep + a softer digest
 *      line, without the leak accusation.
 *
 * Usage:
 *   node scripts/check-bd-blacklist.js [--dry-run] [--zone=NAME]
 */

const { hasHelpFlag } = require('./lib/cli-help.js');
const { cidrContains, classifyBlacklistEntries } = require('./lib/ip-cidr.js');

const USAGE =
  'Usage: node scripts/check-bd-blacklist.js [--dry-run] [--zone=NAME]\n\n' +
  'Removes Bright Data zone blacklist entries that fall inside GitHub\n' +
  "Actions' published runner ranges (api.github.com/meta). Non-GitHub\n" +
  'entries are kept and routed to the owner digest. --dry-run reports\n' +
  'without deleting. Zone defaults to $BRIGHTDATA_ZONE or web_unlocker2.';

const DRY_RUN = process.argv.includes('--dry-run');
const zoneArg = process.argv.find((a) => a.startsWith('--zone='));
const ZONE =
  (zoneArg && zoneArg.split('=')[1]) || process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
const TOKEN = process.env.BRIGHTDATA_TOKEN;
const FETCH_TIMEOUT_MS = 20000;
const CONDITION_PREFIX = () => `bd-blacklist-unknown:${ZONE}:`;

async function bdRequest(method, path, body) {
  const res = await fetch(`https://api.brightdata.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`BD API ${method} ${path} → HTTP ${res.status}`);
  return res;
}

async function getBlacklist() {
  // Response shape (verified live 2026-07-27): {} when empty, otherwise
  // { "<zone>": ["ip-or-cidr", ...] }. Add/remove return 204. Any OTHER
  // shape means the API drifted — throw rather than treat it as "empty",
  // which would silently disable this check forever.
  const res = await bdRequest('GET', `/zone/blacklist?zone=${encodeURIComponent(ZONE)}`);
  const data = await res.json();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`BD blacklist API shape drift: expected object, got ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (Object.keys(data).length === 0) return [];
  if (!Array.isArray(data[ZONE])) {
    throw new Error(
      `BD blacklist API shape drift: no "${ZONE}" array in non-empty response ` +
        `(keys: ${Object.keys(data).join(', ')})`
    );
  }
  return data[ZONE];
}

async function getGithubActionsRanges() {
  const res = await fetch('https://api.github.com/meta', {
    headers: {
      'User-Agent': 'broadwayscorecard-bd-blacklist-check',
      // Unauthenticated /meta shares a 60/hr per-source-IP bucket with every
      // other tenant on the runner's egress IP — authenticate when we can.
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`api.github.com/meta → HTTP ${res.status}`);
  const meta = await res.json();
  const ranges = (meta.actions || []).filter((r) => !r.includes(':')); // IPv4 only
  if (ranges.length < 1000) {
    // GH publishes ~5,600 IPv4 Actions ranges; far fewer means a truncated/
    // wrong response. Bail rather than misclassify runner IPs as "unknown"
    // and spam the digest.
    throw new Error(`api.github.com/meta returned only ${ranges.length} IPv4 actions ranges — refusing to classify`);
  }
  return ranges;
}

/** Same network? (string formats may differ, e.g. "1.2.3.4" vs "1.2.3.4/32") */
function sameCidr(a, b) {
  return cidrContains(a, b) && cidrContains(b, a);
}

async function main() {
  // --help/-h checked BEFORE any network work (cousin of #260/#263/#264 —
  // see scripts/lib/cli-help.js). The guard lives here, not at module top:
  // audit-help-flag-safety.js's ordering check windows from main()'s
  // declaration, so a top-level guard is invisible to it (task #601).
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }
  if (!TOKEN) throw new Error('BRIGHTDATA_TOKEN not set');

  const entries = await getBlacklist();
  if (entries.length === 0) {
    console.log(`[bd-blacklist] zone ${ZONE}: blacklist empty — nothing to do`);
    resolveStaleConditions([]);
    return;
  }

  const ghRanges = await getGithubActionsRanges();
  const { ours, unknown, unclassified } = classifyBlacklistEntries(entries, ghRanges);
  console.log(
    `[bd-blacklist] zone ${ZONE}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — ` +
      `${ours.length} GitHub-runner (auto-clear), ${unknown.length} unknown (keep + digest), ` +
      `${unclassified.length} unclassified (keep + digest)`
  );

  // Digest routing runs BEFORE deletes/verification so a BD API hiccup in
  // the cleanup path can't suppress the genuinely important alert.
  if (!DRY_RUN) {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    for (const entry of unknown) {
      await routeAlert({
        conditionKey: `${CONDITION_PREFIX()}${entry}`,
        title: `Bright Data blacklisted a non-CI IP on zone ${ZONE}: ${entry}`,
        description:
          `Bright Data's unknown-IP detector blacklisted ${entry} on zone ${ZONE} and it is ` +
          `NOT inside GitHub's published Actions runner ranges, so it isn't our CI. ` +
          `If it isn't the Mac Studio or another known machine either, the zone credentials may ` +
          `be leaked: rotate the zone password at brightdata.com/cp/setting/auth. ` +
          `The entry was left on the blacklist on purpose (it blocks only that IP).`,
        severity: 'warning',
        disposition: 'digest',
      });
      console.log(`[bd-blacklist] kept ${entry} — not a GitHub range, routed to digest`);
    }
    for (const entry of unclassified) {
      await routeAlert({
        conditionKey: `${CONDITION_PREFIX()}${entry}`,
        title: `Bright Data blacklisted an entry this check can't classify on zone ${ZONE}: ${entry}`,
        description:
          `Bright Data blacklisted ${entry} on zone ${ZONE}. The auto-clear check only ` +
          `understands IPv4 addresses/CIDRs, so it can't tell whether this is a GitHub ` +
          `runner (IPv6 runner ranges exist) or a stranger. Left on the blacklist; if CI ` +
          `scraping degrades, remove it manually at brightdata.com (zone ${ZONE} security settings).`,
        severity: 'warning',
        disposition: 'digest',
      });
      console.log(`[bd-blacklist] kept ${entry} — unclassifiable (non-IPv4), routed to digest`);
    }
  } else {
    for (const entry of [...unknown, ...unclassified]) {
      console.log(`[bd-blacklist] DRY RUN: would keep ${entry} and route to digest`);
    }
  }

  for (const entry of ours) {
    if (DRY_RUN) {
      console.log(`[bd-blacklist] DRY RUN: would remove ${entry}`);
      continue;
    }
    await bdRequest('DELETE', '/zone/blacklist', { zone: ZONE, ip: entry });
    console.log(`[bd-blacklist] removed ${entry} (GitHub Actions runner range)`);
  }

  if (!DRY_RUN && ours.length > 0) {
    const after = await getBlacklist();
    // Parsed comparison, not string equality — BD may normalize the echo.
    const leftover = after.filter((e) => ours.some((o) => sameCidr(o, e)));
    if (leftover.length > 0) throw new Error(`removal did not stick for: ${leftover.join(', ')}`);
  }

  resolveStaleConditions([...unknown, ...unclassified]);
}

/**
 * Close open ledger conditions for entries that have left the blacklist
 * (owner removed them, or BD dropped them) so they don't sit open forever.
 */
function resolveStaleConditions(stillPresent) {
  if (DRY_RUN) return;
  const { loadLedger, resolveCondition } = require('./lib/owner-alert-router.js');
  const prefix = CONDITION_PREFIX();
  const present = new Set(stillPresent.map((e) => `${prefix}${e}`));
  const ledger = loadLedger();
  for (const key of Object.keys(ledger.conditions || {})) {
    if (!key.startsWith(prefix) || present.has(key)) continue;
    if (resolveCondition(key)) console.log(`[bd-blacklist] resolved stale condition ${key}`);
  }
}

main().catch((err) => {
  console.error(`[bd-blacklist] FAILED: ${err.message}`);
  process.exit(1);
});
