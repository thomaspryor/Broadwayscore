'use strict';
/**
 * press-night-preflight.js (BRO-6858): the verdict of the 24h and 3h press-night preflight. Pure.
 *
 * Input: check-secrets-health.js results ({name, status: pass|warn|fail|skip, message}) and the ScrapingBee
 * credit status (check-sb-credits fetchSBCreditStatus()). A press night needs every key the old path spends on
 * (scoring models, scrapers, the private data repo, deploys, the owner email). A key that fails or is not set at
 * all fails the preflight; a warning does not (warnings already reach the weekly secrets check).
 *
 * ScrapingBee credits use the shared reader (sb-credit-verdict.js) and owner policy: ScrapingBee is a fallback
 * link, so ride out a thin balance and never page on it (memory/feedback_sb_quota_ride_out.md, BRO-7854). Only
 * an exhausted cycle (or a fail line an operator set via SB_READINESS_FAIL_PCT_USED) is a problem; a thin balance
 * is a note in the run summary. A local percent rule paged at 91% used with 23,738 left (2026-11-21, BRO-8009).
 */

const { foldDiacritics } = require('./url-slug');
const { sbCreditVerdict } = require('./sb-credit-verdict');

const REQUIRED = ['Anthropic', 'OpenAI', 'Gemini', 'ScrapingBee', 'ScrapingDog', 'Bright Data', 'Private Repo PAT', 'Vercel', 'Resend'];

function preflightVerdict({ results = [], sb = null } = {}) {
  const problems = [];
  // A check that threw is named after its function (checkBrightData -> "BrightData"): match on letters and digits.
  const norm = (n) => foldDiacritics(String(n || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(results.map((r) => [norm(r.name), r]));
  for (const name of REQUIRED) {
    const r = byName.get(norm(name));
    if (!r) { problems.push({ key: name, why: 'not checked (check-secrets-health has no result for it)' }); continue; }
    const crashed = /^Check threw error/.test(String(r.message || ''));
    if (r.status === 'fail' || r.status === 'skip' || crashed) problems.push({ key: name, why: `${crashed ? 'check crashed' : r.status}: ${String(r.message || '').slice(0, 160)}` });
  }
  // Unknown status (null, API error, unreadable payload) is not a problem on its own (check-secrets-health covers
  // the key), but it is not proof of credit either: sbUnknown stops a run from clearing an earlier page.
  const sbV = sb ? sbCreditVerdict(sb) : null;
  const sbUnknown = !sb || !sb.ok;
  if (sbV && !sbUnknown && sbV.level === 'fail') problems.push({ key: 'ScrapingBee credits', why: sbV.detail });
  const sbNote = sbV && (sbV.level === 'warn' || sbV.level === 'skip') ? sbV.detail : null;
  const resendDown = problems.some((p) => p.key === 'Resend');
  return { ok: problems.length === 0, problems, resendDown, sbNote, sbUnknown };
}

module.exports = { preflightVerdict, REQUIRED };
