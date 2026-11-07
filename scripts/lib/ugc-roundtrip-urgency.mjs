/**
 * Which UGC round-trip failures are worth an immediate owner email (BRO-4603).
 *
 * The owner got five "[CRITICAL] UGC Auth Round-trip Failed" emails on
 * 2026-10-01..03 saying "user ratings may be leaking across accounts". The
 * only failing check was 'plans: GET on get_shared_plans is refused', a
 * hardening rule on a feature that had shipped that day; a fix session closed
 * it (BRO-4525) without the owner. The owner wants email only when it is
 * urgent and they must act.
 *
 * Every check is urgent unless its call site passes NOT_URGENT, so a new check
 * pages by default and only a deliberate opt-out goes quiet. Urgent means a
 * signed-in user cannot sign in or save/read back a rating, or someone can see
 * or change data that is not theirs. Opt out everything else: watchlist/list
 * features, owner edit/delete/reset actions, input validation, token format,
 * GET-vs-POST hardening. tests/unit/ugc-roundtrip-urgency.test.mjs refuses an
 * opt-out on a sign-in, rating save/read-back or visibility check. Non-urgent
 * failures still fail the workflow and reach the digest.
 */

export const NOT_URGENT = Object.freeze({ urgent: false });

/**
 * @param {{name: string, ok: boolean, urgent?: boolean}[]} results
 * @returns {{failed: number, urgent: boolean, urgentNames: string[], otherNames: string[]}}
 */
export function summarizeFailures(results) {
  const failed = results.filter((r) => !r.ok);
  const urgentNames = failed.filter((r) => r.urgent !== false).map((r) => r.name);
  const otherNames = failed.filter((r) => r.urgent === false).map((r) => r.name);
  return { failed: failed.length, urgent: urgentNames.length > 0, urgentNames, otherNames };
}

/**
 * Lines for $GITHUB_OUTPUT. The names end up inside a JS template literal in
 * notify-failure's github-script step, so newlines, backticks and `$` are
 * stripped (an error message in the abort path could carry any of them).
 */
export function githubOutputLines(summary) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/[`$\\]/g, '');
  const names = [...summary.urgentNames, ...summary.otherNames].map(clean).join('; ');
  return [`urgent=${summary.urgent ? 'true' : 'false'}`, `failed_checks=${names}`];
}
