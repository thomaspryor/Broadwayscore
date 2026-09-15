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
 * an interactive login. The zone `password` field rotated here is a separate,
 * legacy credential for the raw proxy protocol (host:port + zone-user:pass)
 * that this codebase does not use (grep confirms no `superproxy`/direct-proxy
 * usage — scraper.js only calls the REST /request endpoint with the Bearer
 * token), so rotating it is zero-risk to live scraping.
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

// BD accepts arbitrary password strings; keep it alnum so it needs no
// shell/JSON escaping anywhere downstream (GH secret set, .env, curl).
function generatePassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

async function getZoneInfo(zone) {
  const res = await bdRequest('GET', `/zone?zone=${encodeURIComponent(zone)}`);
  if (res.status !== 200) throw new Error(`GET /zone?zone=${zone} -> ${res.status}: ${res.body}`);
  const data = parseJson(res.body);
  if (!data) throw new Error(`GET /zone?zone=${zone} returned unparseable body: ${res.body}`);
  return data;
}

async function rotateZonePassword(zone) {
  console.log(`\n=== ${zone} ===`);
  const before = await getZoneInfo(zone);
  const oldPasswords = before.password || [];
  const compromised = before.compromised_password || [];
  console.log(`  current passwords: ${oldPasswords.length} (compromised: ${compromised.length})`);
  if (compromised.length === 0) {
    console.log('  no compromised_password flagged — rotating anyway per incident response, but noting this.');
  }

  const newPassword = generatePassword();
  const addRes = await bdRequest('POST', '/zone/add_password', { zone, password: newPassword });
  if (addRes.status < 200 || addRes.status >= 300) {
    throw new Error(`add_password failed (${addRes.status}): ${addRes.body}`);
  }

  const afterAdd = await getZoneInfo(zone);
  if (!(afterAdd.password || []).includes(newPassword)) {
    throw new Error(`new password not present after add_password — refusing to remove old password. Zone: ${zone}`);
  }
  console.log('  added new password, verified present.');

  if (oldPasswords.length > 0) {
    const removeRes = await bdRequest('POST', '/zone/remove_password', { zone, password: oldPasswords });
    if (removeRes.status < 200 || removeRes.status >= 300) {
      throw new Error(`remove_password failed (${removeRes.status}): ${removeRes.body} — new password IS active, old password was NOT removed`);
    }
    const afterRemove = await getZoneInfo(zone);
    const stillPresent = oldPasswords.filter((p) => (afterRemove.password || []).includes(p));
    if (stillPresent.length > 0) {
      throw new Error(`old password(s) still present after remove_password: ${stillPresent.length} remaining`);
    }
    console.log(`  removed ${oldPasswords.length} old password(s), verified gone.`);
  }

  return { zone, newPassword, rotatedOld: oldPasswords.length, wasCompromised: compromised.length > 0 };
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
    results.push({ zone, status: res.status, body: res.body });
    console.log(`  ${zone}: whitelist POST -> ${res.status}`);
  }
  return { applied: true, results };
}

async function main() {
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
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
