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
 *   2. GET GitHub's published Actions ranges from api.github.com/meta.
 *   3. DELETE every blacklist entry fully contained in an Actions range.
 *   4. Entries that are NOT GitHub runners are left in place and routed to
 *      the owner digest — an unknown IP using our zone credentials is the
 *      one case where BD's alert is genuinely worth a look.
 *
 * Usage:
 *   node scripts/check-bd-blacklist.js [--dry-run] [--zone=NAME]
 */

const { hasHelpFlag } = require('./lib/cli-help.js');
const { isCoveredByAny } = require('./lib/ip-cidr.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(
    'Usage: node scripts/check-bd-blacklist.js [--dry-run] [--zone=NAME]\n\n' +
      'Removes Bright Data zone blacklist entries that fall inside GitHub\n' +
      "Actions' published runner ranges (api.github.com/meta). Non-GitHub\n" +
      'entries are kept and routed to the owner digest. --dry-run reports\n' +
      'without deleting. Zone defaults to $BRIGHTDATA_ZONE or web_unlocker2.'
  );
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const zoneArg = process.argv.find((a) => a.startsWith('--zone='));
const ZONE = zoneArg ? zoneArg.split('=')[1] : process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
const TOKEN = process.env.BRIGHTDATA_TOKEN;
const FETCH_TIMEOUT_MS = 20000;

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
  // { "<zone>": ["ip-or-cidr", ...] }. Add/remove return 204.
  const res = await bdRequest('GET', `/zone/blacklist?zone=${encodeURIComponent(ZONE)}`);
  const data = await res.json();
  return Array.isArray(data[ZONE]) ? data[ZONE] : [];
}

async function getGithubActionsRanges() {
  const res = await fetch('https://api.github.com/meta', {
    headers: { 'User-Agent': 'broadwayscorecard-bd-blacklist-check' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`api.github.com/meta → HTTP ${res.status}`);
  const meta = await res.json();
  const ranges = (meta.actions || []).filter((r) => !r.includes(':')); // IPv4 only
  if (ranges.length < 100) {
    // GH publishes thousands of Actions ranges; a tiny list means a
    // truncated/wrong response. Bail rather than misclassify runner IPs
    // as "unknown" and spam the digest.
    throw new Error(`api.github.com/meta returned only ${ranges.length} IPv4 actions ranges — refusing to classify`);
  }
  return ranges;
}

async function main() {
  if (!TOKEN) throw new Error('BRIGHTDATA_TOKEN not set');

  const entries = await getBlacklist();
  if (entries.length === 0) {
    console.log(`[bd-blacklist] zone ${ZONE}: blacklist empty — nothing to do`);
    return;
  }

  const ghRanges = await getGithubActionsRanges();
  const ours = entries.filter((e) => isCoveredByAny(e, ghRanges));
  const unknown = entries.filter((e) => !isCoveredByAny(e, ghRanges));
  console.log(
    `[bd-blacklist] zone ${ZONE}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — ` +
      `${ours.length} GitHub-runner (auto-clear), ${unknown.length} unknown (keep + digest)`
  );

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
    const leftover = after.filter((e) => ours.includes(e));
    if (leftover.length > 0) throw new Error(`removal did not stick for: ${leftover.join(', ')}`);
  }

  if (unknown.length > 0) {
    for (const entry of unknown) {
      if (DRY_RUN) {
        console.log(`[bd-blacklist] DRY RUN: would keep ${entry} and route to digest`);
        continue;
      }
      const { routeAlert } = require('./lib/owner-alert-router.js');
      await routeAlert({
        conditionKey: `bd-blacklist-unknown:${ZONE}:${entry}`,
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
  }
}

main().catch((err) => {
  console.error(`[bd-blacklist] FAILED: ${err.message}`);
  process.exit(1);
});
