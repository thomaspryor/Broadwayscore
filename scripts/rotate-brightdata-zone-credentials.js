#!/usr/bin/env node
/**
 * Rotate a Bright Data zone's proxy password via the Account Management API,
 * and (optionally) report/apply an IP allowlist.
 *
 * BRO-643: Bright Data disclosed a security incident (2026-04-01) and flagged
 * specific zone passwords as `compromised_password` in their own zone-info
 * API response. This rotates that credential (add new -> verify -> remove
 * old), the same add-then-remove order the zone/add_password + remove_password
 * API requires (a zone can never be left with zero passwords).
 *
 * This does NOT touch BRIGHTDATA_TOKEN (the Bearer API key scraper.js
 * authenticates with) — that key has no self-service rotation endpoint
 * (verified: /customer/api_token, /customer/api_tokens, /user/api_token,
 * /api_token all 404 with a valid Bearer token). It must be regenerated from
 * the Bright Data dashboard (Account Settings -> API Tokens), which requires
 * an interactive login.
 *
 * The zone `password` field rotated here is a separate credential for the raw
 * proxy protocol (host:port + zone-user:pass). scraper.js (this codebase's
 * only in-app BD caller) never uses it — it only calls the REST /request
 * endpoint with the Bearer token. One workflow, .github/workflows/archive-
 * aggregator-pages.yml, DOES speak the raw proxy protocol (brd.superproxy.io:
 * 33335), but its `auth.password` is BRIGHTDATA_TOKEN, not this zone
 * `password` field (confirmed by reading the workflow — it never reads
 * zone/passwords). So rotating this field is zero-risk to both call paths;
 * verified live post-rotation by dispatching that workflow for one show
 * (BRO-643 report has the run URL).
 *
 * IP allowlist (--ip-allowlist) is report-only by default. Bright Data's own
 * docs state that adding ANY ip to a zone's allowlist blocks every other IP
 * from that zone outright, with no documented carve-out for the REST API vs
 * the proxy protocol. GitHub-hosted Actions runners draw from ~7,000 rotating
 * Azure CIDR blocks (github.com/meta) with no fixed egress IP and no
 * in-repo mechanism to keep that list current — allowlisting them today and
 * having GitHub reassign ranges next month silently 403s every CI scraping
 * workflow. --apply-ip-allowlist is required to actually call zone/whitelist;
 * without it this only prints what it WOULD do.
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const { readEnvKeys } = require('./lib/load-env');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `Usage: node scripts/rotate-brightdata-zone-credentials.js [options]

Rotates a Bright Data zone's proxy password (add new, verify, remove old).

Options:
  --zones=a,b            Comma-separated zone names (default: web_unlocker2,serp_api1)
  --ip-allowlist          Report current IP allowlist state (dry run, no changes)
  --apply-ip-allowlist    Actually restrict the zone(s) to --ip (DANGEROUS, see file header)
  --ip="1.2.3.4,5.6.7.0/24"  IPs/CIDRs to allowlist, required with --apply-ip-allowlist
  --help, -h              Show this message
`;

const _env = readEnvKeys(['BRIGHTDATA_TOKEN']);
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN || _env.BRIGHTDATA_TOKEN;

function bdRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      `https://api.brightdata.com${urlPath}`,
      {
        method,
        headers: Object.assign(
          { Authorization: `Bearer ${BRIGHTDATA_TOKEN}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
        ),
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('BD API request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// BD's zone-info/add/remove response bodies can echo back the `password`
// (and `compromised_password`) array verbatim. A rotation script that then
// stringifies that body into a thrown Error — which main() prints to
// stdout/CI logs on any failure — would leak the very credential it exists
// to protect. Redact anything that looks like a password field before it
// ever reaches an Error message or console output.
function redact(body) {
  if (typeof body !== 'string') return String(body);
  return body.replace(/"(compromised_password|password)"\s*:\s*(\[[^\]]*\]|"[^"]*")/g, '"$1":"[redacted]"');
}

// BD accepts arbitrary password strings; keep it alnum so it needs no
// shell/JSON escaping anywhere downstream (GH secret set, .env, curl).
// Loop rather than trust a single slice: filtering non-alnum chars out of a
// base64 string can (rarely) leave fewer than 20 usable characters.
function generatePassword() {
  let out = '';
  while (out.length < 20) {
    out += crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  }
  return out.slice(0, 20);
}

async function getZoneInfo(zone) {
  const res = await bdRequest('GET', `/zone?zone=${encodeURIComponent(zone)}`);
  if (res.status !== 200) throw new Error(`GET /zone?zone=${zone} -> ${res.status}: ${redact(res.body)}`);
  const data = parseJson(res.body);
  if (!data) throw new Error(`GET /zone?zone=${zone} returned unparseable body (redacted): ${redact(res.body)}`);
  if (!Array.isArray(data.password)) {
    throw new Error(`GET /zone?zone=${zone} response missing a "password" array — unexpected schema, refusing to proceed`);
  }
  return data;
}

async function rotateZonePassword(zone) {
  console.log(`\n=== ${zone} ===`);
  const before = await getZoneInfo(zone);
  const compromised = before.compromised_password || [];
  console.log(`  current passwords: ${before.password.length} (compromised: ${compromised.length})`);
  if (compromised.length === 0) {
    console.log('  no compromised_password flagged — rotating anyway per incident response, but noting this.');
  }

  const newPassword = generatePassword();
  const addRes = await bdRequest('POST', '/zone/add_password', { zone, password: [newPassword] });
  if (addRes.status < 200 || addRes.status >= 300) {
    throw new Error(`add_password failed (${addRes.status}): ${redact(addRes.body)}`);
  }

  const afterAdd = await getZoneInfo(zone);
  if (!afterAdd.password.includes(newPassword)) {
    throw new Error(`new password not present after add_password — refusing to remove old password(s). Zone: ${zone}`);
  }
  console.log('  added new password, verified present.');

  // Re-read right before removing rather than reusing the `before` snapshot:
  // makes a rerun (e.g. after a transient failure mid-rotation) idempotent —
  // it removes whatever is on the zone MINUS the password just added, never
  // a stale list that could include a previous run's replacement.
  const toRemove = afterAdd.password.filter((p) => p !== newPassword);
  if (toRemove.length > 0) {
    const removeRes = await bdRequest('POST', '/zone/remove_password', { zone, password: toRemove });
    if (removeRes.status < 200 || removeRes.status >= 300) {
      throw new Error(`remove_password failed (${removeRes.status}): ${redact(removeRes.body)} — new password IS active, old password(s) NOT removed`);
    }
    const afterRemove = await getZoneInfo(zone);
    const stillPresent = toRemove.filter((p) => afterRemove.password.includes(p));
    if (stillPresent.length > 0) {
      throw new Error(`old password(s) still present after remove_password: ${stillPresent.length} remaining`);
    }
    if (!afterRemove.password.includes(newPassword)) {
      throw new Error(`new password missing from final zone state after remove_password — zone may be left in an unexpected state. Zone: ${zone}`);
    }
    console.log(`  removed ${toRemove.length} old password(s), verified gone; new password confirmed active.`);
  }

  return { zone, newPassword, rotatedOld: toRemove.length, wasCompromised: compromised.length > 0 };
}

async function reportIpAllowlist(zones, extraIps, apply) {
  console.log('\n=== IP allowlist ===');
  const current = await bdRequest('GET', '/zone/whitelist');
  const currentData = parseJson(current.body) || {};
  for (const zone of zones) {
    console.log(`  ${zone}: currently ${JSON.stringify(currentData[zone] || [])}`);
  }

  console.log(
    '\n  NOT applying a restrictive allowlist by default: Bright Data blocks every IP not on the\n' +
    '  list the moment any IP is added, GitHub-hosted Actions runners have no fixed egress IP\n' +
    '  (github.com/meta lists ~7,000 rotating Azure CIDR blocks), and this repo has no job that\n' +
    '  refreshes that list — a GitHub range change after rotation would silently 403 every CI\n' +
    '  scraping workflow with no local reproduction. See BRO-643 report for the decision needed.'
  );

  if (!apply) {
    console.log(`  Pass --apply-ip-allowlist --ip="<ip1,ip2,...>" to actually restrict a zone. Dry run only.`);
    return { applied: false };
  }
  if (extraIps.length === 0) {
    throw new Error('--apply-ip-allowlist requires --ip="<comma-separated ips/cidrs>"');
  }
  const results = [];
  for (const zone of zones) {
    const res = await bdRequest('POST', '/zone/whitelist', { zone, ip: extraIps });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`zone/whitelist POST failed for ${zone} (${res.status}): ${res.body}`);
    }
    const verify = parseJson((await bdRequest('GET', '/zone/whitelist')).body) || {};
    const applied = verify[zone] || [];
    const missing = extraIps.filter((ip) => !applied.includes(ip));
    if (missing.length > 0) {
      throw new Error(`zone/whitelist for ${zone} does not include all requested IPs after apply — missing: ${missing.join(', ')}`);
    }
    results.push({ zone, status: res.status });
    console.log(`  ${zone}: whitelist applied and verified (${applied.length} entries).`);
  }
  return { applied: true, results };
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }
  if (!BRIGHTDATA_TOKEN) {
    console.error('BRIGHTDATA_TOKEN not set (env or .env) — cannot call Bright Data API.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const zonesArg = args.find((a) => a.startsWith('--zones='));
  const zones = zonesArg ? zonesArg.slice('--zones='.length).split(',').filter(Boolean) : ['web_unlocker2', 'serp_api1'];
  const doIpReport = args.includes('--ip-allowlist') || args.includes('--apply-ip-allowlist');
  const apply = args.includes('--apply-ip-allowlist');
  const ipArg = args.find((a) => a.startsWith('--ip='));
  const extraIps = ipArg ? ipArg.slice('--ip='.length).split(',').filter(Boolean) : [];

  const results = [];
  for (const zone of zones) {
    results.push(await rotateZonePassword(zone));
  }

  if (doIpReport) {
    await reportIpAllowlist(zones, extraIps, apply);
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.zone}: rotated ${r.rotatedOld} old password(s) (compromised: ${r.wasCompromised}), new password active.`);
  }
  console.log('\nBRIGHTDATA_TOKEN (Bearer API key) was NOT rotated — no self-service API for that, requires dashboard login.');
}

main().catch((err) => {
  console.error('\nFAILED:', redact(err.message));
  process.exit(1);
});
