#!/usr/bin/env node
/**
 * BRO-7188: page the owner when Buffer's plan has locked our social channels.
 *
 * 2026-11-08 the Buffer plan dropped to 3 channels with 7 connected; Buffer locked
 * four and Social Autopost failed for 6 hours with nobody told, because this
 * workflow's failures only reach the morning digest. Only the owner can pay, so a
 * plan lock is a page-worthy key (scripts/lib/page-worthy-alerts.js).
 *
 *   node scripts/social-autopost/plan-alert.js <status.json>
 *
 * <status.json> is what run.js recordPlanStatus() wrote ({state, message}); a
 * missing file means run.js never reached Buffer, so nothing is decided.
 * Exit 1 when the page should have gone out and did not.
 */
const fs = require('fs');

const PLAN_LIMIT_KEY = 'social:buffer-plan-limit';

/** status: planLimitStatus() output. Returns {sent, resolved, problem}. Never throws. */
async function routePlanStatus(status, { router } = {}) {
  try {
    const r0 = router || require('../lib/owner-alert-router.js');
    if (status.state === 'clear') return { resolved: !!r0.resolveCondition(PLAN_LIMIT_KEY) };
    if (status.state !== 'alert') return {};
    const r = await r0.routeAlert({
      conditionKey: PLAN_LIMIT_KEY,
      title: 'Buffer plan lapsed: social posts are not going out',
      description: status.message,
      severity: 'critical',
      disposition: 'human',
      cooldownHours: 24,
      url: 'https://publish.buffer.com/settings/billing',
    });
    // A page-worthy key is never downgraded to the digest; a 'digest' or cooldown
    // result means it was already sent (or will be) and needs nothing here.
    return r && r.delivered === false ? { problem: 'the email to the owner did not send' } : { sent: r && r.action };
  } catch (e) {
    return { problem: `alerting the owner failed: ${e.message.slice(0, 160)}` };
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.log('[plan-alert] no Buffer plan status this run; nothing to do'); return; }
  const status = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = await routePlanStatus(status);
  console.log(`[plan-alert] ${status.state}: ${JSON.stringify(out)}`);
  if (out.problem) { console.log(`::error::Buffer plan lapsed and ${out.problem}`); process.exitCode = 1; }
}

if (require.main === module) main();

module.exports = { routePlanStatus, PLAN_LIMIT_KEY };
