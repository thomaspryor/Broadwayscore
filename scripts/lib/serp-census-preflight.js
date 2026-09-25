'use strict';

/**
 * serp-census-preflight.js — refuse to run the gap audit when its census
 * cannot possibly work.
 *
 * THE FAILURE THIS PREVENTS
 * -------------------------
 * url-discovery.js's serpSearch() early-returns `null` with a one-line `⚠ No
 * SERP API keys available` when neither SCRAPINGBEE_API_KEY nor
 * BRIGHTDATA_TOKEN is in the environment. Callers cannot distinguish that
 * `null` from "searched, found nothing", so the SERP census contributes zero
 * candidates and the audit writes a censusVerdict of 0 live / 0 candidates as
 * an ordinary, confident result.
 *
 * Observed for real on 2026-09-24. A single-show re-audit of
 * jeeves-takes-charge-west-end-2026 returned a 0/0 census against a stored
 * 18/19 — and the accompanying checkpoint entry read
 * `{at: <fresh>, gaps: 0, uncollected: 0}`, which newsletter-preflight.js
 * treats as VERIFIED COMPLETE. Bright Data page fetches succeeded throughout,
 * because fetchPage loads .env internally while this code path reads
 * process.env directly — so every surface-level signal said the run was
 * healthy. The only thing that would have stopped that reaching production
 * data at scale is the blast-radius guard, i.e. the last line of defence,
 * which is not where this class should be caught.
 *
 * The same shape in CI — a rotated secret, a dropped `env:` line in
 * audit-aggregator-gap.yml — would write hollow censuses corpus-wide.
 *
 * WHY A STARTUP CHECK AND NOT A THROW AT THE CALL SITE
 * ----------------------------------------------------
 * serpSearch's callers already catch and continue by design (a single failed
 * query must not kill a 26-show run), so throwing there would be caught and
 * silently rerouted — the failure mode memory/feedback_guard_throw_needs_
 * caller_check.md exists to warn about. A precondition checked once, before
 * any show is audited, cannot be swallowed.
 *
 * THE EXPLICIT OPT-OUT
 * --------------------
 * Running without SERP is legitimate — an offline/unit context, or a
 * deliberately cheap run. It just has to be SAID, via the kill switch that
 * already means exactly that (SERP_GAP_CENSUS_DISABLED). Then a zero census
 * is an expected consequence of an explicit choice rather than an accident.
 */

/** Env vars serpSearch() actually reads before deciding it cannot search. */
const SERP_KEY_VARS = ['SCRAPINGBEE_API_KEY', 'BRIGHTDATA_TOKEN'];

function envTrue(v) {
  return v === '1' || String(v).toLowerCase() === 'true';
}

/**
 * Decide whether a SERP-dependent script may proceed.
 *
 * Generalized (BRO-4139) from the gap-audit-only version so the other five
 * callers of serpQuery()/serpSearch() can share one predicate instead of each
 * re-deriving "is a key present" by hand. Every default reproduces the
 * original gap-audit behavior exactly (existing tests assert on the default
 * reason text), so this is additive: pass `opts` to customize the opt-out env
 * var and the downstream-consequence text for a different caller.
 *
 * @param {object} env  process.env (or a fixture)
 * @param {object} [opts]
 * @param {string} [opts.disableVar]  Env var name that opts out (default
 *   'SERP_GAP_CENSUS_DISABLED' — the gap audit's own switch).
 * @param {string} [opts.consequence]  What happens downstream when this
 *   caller silently proceeds keyless. Defaults to the gap-audit's own
 *   VERIFIED-COMPLETE consequence text.
 * @param {string} [opts.workflowHint]  Path named in the "check CI" remedy
 *   line (default: audit-aggregator-gap.yml).
 * @returns {{ok: boolean, reason: string}}
 */
function serpCensusPreflight(env = {}, opts = {}) {
  const disableVar = opts.disableVar || 'SERP_GAP_CENSUS_DISABLED';
  if (envTrue(env[disableVar])) {
    return { ok: true, reason: `SERP census explicitly disabled via ${disableVar} — a zero census is an expected consequence of that choice, not an accident` };
  }
  const present = SERP_KEY_VARS.filter((k) => env[k] && String(env[k]).trim());
  if (present.length > 0) {
    return { ok: true, reason: `SERP census can run (${present.join(', ')} present)` };
  }
  const consequence = opts.consequence
    || 'The census would contribute zero candidates and every show audited would be written with a '
      + '0-live/0-candidate verdict and a fresh zero-gap checkpoint entry, which downstream reads as '
      + 'VERIFIED COMPLETE. Refusing to run.';
  const workflowHint = opts.workflowHint || '.github/workflows/audit-aggregator-gap.yml';
  return {
    ok: false,
    reason:
      'No SERP API key in the environment (need SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN). '
      + consequence + '\n'
      + '  Locally: the keys live in .env, which fetchPage loads internally but this path does not — '
      + 'export them into the shell first, e.g. `set -a; . ./.env; set +a`.\n'
      + `  In CI: check the env: block of ${workflowHint} and the repo secrets.\n`
      + `  To run deliberately WITHOUT the census, say so: ${disableVar}=1`,
  };
}

module.exports = { serpCensusPreflight, SERP_KEY_VARS };
