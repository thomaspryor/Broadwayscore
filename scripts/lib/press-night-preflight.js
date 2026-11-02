'use strict';
/**
 * press-night-preflight.js (BRO-6858): the verdict of the 24h and 3h press-night preflight. Pure.
 *
 * Input: check-secrets-health.js results ({name, status: pass|warn|fail|skip, message}) and the ScrapingBee
 * credit status (check-sb-credits fetchSBCreditStatus()). A press night needs every key the old path spends on
 * (scoring models, scrapers, the private data repo, deploys, the owner email). A key that fails or is not set at
 * all fails the preflight; a warning does not (warnings already reach the weekly secrets check). ScrapingBee at
 * 90% used or more fails: the poller burns ~2-5k credits on a busy night.
 */

const REQUIRED = ['Anthropic', 'OpenAI', 'Gemini', 'ScrapingBee', 'ScrapingDog', 'Bright Data', 'Private Repo PAT', 'Vercel', 'Resend'];
const SB_MAX_PCT_USED = 90;

function preflightVerdict({ results = [], sb = null } = {}) {
  const problems = [];
  // A check that threw is named after its function (checkBrightData -> "BrightData"): match on letters and digits.
  const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(results.map((r) => [norm(r.name), r]));
  for (const name of REQUIRED) {
    const r = byName.get(norm(name));
    if (!r) { problems.push({ key: name, why: 'not checked (check-secrets-health has no result for it)' }); continue; }
    const crashed = /^Check threw error/.test(String(r.message || ''));
    if (r.status === 'fail' || r.status === 'skip' || crashed) problems.push({ key: name, why: `${crashed ? 'check crashed' : r.status}: ${String(r.message || '').slice(0, 160)}` });
  }
  if (sb && sb.ok && Number.isFinite(sb.pctUsed) && sb.pctUsed >= SB_MAX_PCT_USED) {
    problems.push({ key: 'ScrapingBee credits', why: `${Math.round(sb.pctUsed)}% used (${sb.remaining} left)` });
  }
  const resendDown = problems.some((p) => p.key === 'Resend');
  return { ok: problems.length === 0, problems, resendDown };
}

module.exports = { preflightVerdict, REQUIRED, SB_MAX_PCT_USED };
