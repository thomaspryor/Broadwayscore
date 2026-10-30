/**
 * Page-worthy allowlist — the ONLY conditionKeys owner-alert-router.js will
 * actually email the owner for directly (disposition: 'human'). Everything
 * else requesting disposition: 'human' is downgraded to 'digest' at the
 * router level, regardless of what the caller asked for.
 *
 * Owner mandate 2026-07-28 (card #611), the owner's ~8th email-noise
 * escalation: per-sender demotions (#352/#409/#475/#514/#515/#531) each fixed
 * a named sender, but a new one always reappeared, because disposition:
 * 'human' was still an open door — any script could ask for it and get an
 * immediate email. This file closes that door structurally: the door only
 * opens for conditionKeys listed here. Add/remove entries directly; this
 * file IS the config the owner reads to see what's allowed to page them.
 *
 * Owner-approved categories (2026-07-28):
 *   1. Production site down
 *   2. Opening-night pipeline dead ON an opening night
 *   3. Data-loss in progress
 *   + Meta: the alert/dispatch pipeline's own self-tests. These must always
 *     page on failure — if THEY were gated by this same allowlist and lost,
 *     a broken alert pipeline would have no way to ever tell anyone it's
 *     broken (health-check.js's 7-day deadman check, the e2e canary).
 *
 * No sender currently emits a dedicated "production site down" or
 * "data-loss in progress" conditionKey (deploy failures fold into the
 * morning digest's health section per #608/#610) — those two categories
 * have no entries below yet. Add one here the day a sender for either
 * exists; do not pre-populate with a key nothing emits.
 *
 * BRO-1699: opening-night-poller.js and .github/workflows/opening-night-
 * broadcast.yml used to bypass routeAlert() entirely (direct sendAlert()
 * calls), on the theory that they must keep paging even if the router itself
 * is broken. That theory turned out to be the noise-regression bug, not a
 * safety feature — see the card for the two live bypasses it caught. Both
 * now call routeAlert(disposition:'human') like every other page candidate;
 * opening-night-broadcast.yml's overdue-broadcast alert IS Category 2 (below),
 * and opening-night-poller.js's SERP-burst-tripwire condition is a deliberate
 * carve-out below it (not one of the 3 categories, but preserving its
 * pre-migration real-time-page behavior — see that entry's comment).
 */
'use strict';

// Category 2: opening-night pipeline dead ON an opening night. All four are
// prefixes because the real conditionKey carries a per-night/per-show
// suffix (date or show-window key).
const PAGE_WORTHY_PREFIXES = [
  'lane-live-timeout:', // opening-night lane (real-ports.js, BRO-6649): a publish pushed to core data is still not on the live site after 20 minutes on a press night
  'on-monitor-launch-failed-', // opening-night-monitor-launch.js: the launcher could not start a monitor session tonight
  'on-monitor-auth-failed-', // opening-night-monitor-launch.js: claude auth preflight failed — zero coverage tonight
  'on-monitor-auth-starved-sustained-', // opening-night-monitor-launch.js: Mac too starved to start ANY pass for 3 ticks (~1h) in an opening window (BRO-4141; single blips go to digest as on-monitor-auth-starved-)
  // 'on-monitor-attempts-exhausted-' REMOVED 2026-09-30 (BRO-4141): every
  // escalate reason is a deliberate stop (spend cap / attempt cap / no-progress
  // brake), e.g. "[CRITICAL] … spend cap reached ($202.66 >= $200)" — not a
  // dead pipeline and nothing the owner can act on. It routes to the digest.
  // 'on-monitor-escalation-' was here and REMOVED (BRO-5490): nothing emits it;
  // the window-end escalation is the per-show final report below.
  'on-monitor-dead-session-', // opening-night-monitor-launch.js: the launcher kept dying (SIGKILL/OOM) until the attempt cap — monitor is dead for the rest of the window
  'broadcast:draft-creation-failed:', // send-opening-night-broadcast.js: the time-sensitive opening-night email draft failed to create
  // BRO-886: the draft itself was created and tracked fine — only the
  // "hey, go review this in Resend" notification email failed. Without an
  // immediate page here, the owner has no other heads-up that a time-
  // sensitive opening-night draft is sitting unsent, and would only find out
  // via the next morning's digest — same urgency class as
  // 'broadcast:draft-creation-failed:' above, just a different failure point.
  'broadcast:owner-notification-failed:',
  'broadcast:overdue:', // opening-night-broadcast.yml: broadcast hasn't sent 6+h after a show's opening — the pipeline (gather/rebuild/score) may be stuck
  // check-missed-broadcasts.js: a show opened, qualified on scored reviews, and
  // then left the 2-day broadcast window without an email ever going out. This
  // is the TERMINAL form of the line above: 'broadcast:overdue:' can only fire
  // while the show is still in the window, so a show blocked for longer than
  // that used to exit the pipeline in total silence (Electra / Persona, The
  // Story and Abigail's Party all did, 2026-08/09 — found only because the
  // owner noticed one show's email arriving and another's never had). Nothing
  // retries these automatically, so the page IS the recovery mechanism.
  'broadcast:never-sent:',
  // check-missed-broadcasts.js (BRO-2935): a Resend draft has sat unsent 3+
  // days. Only the owner can press Send or decide to discard it.
  'broadcast:draft-unsent:',
  // BRO-4417: the draft deadline passed, so the draft was created over QA-gate
  // findings. The owner must read them before pressing Send, and the draft is
  // sitting in Resend right now, so the next morning's digest is too late.
  'broadcast:deadline-draft:',
  // 'opening-night-drift:' was listed here 2026-09 and REMOVED 2026-09-23
  // (owner email-noise complaint): it emailed once per show every 6h for the
  // whole ±7-day opening window, ~40 emails in one week across 5 shows. A
  // review-count mismatch between review-texts, reviews.json and live prod is
  // a data-reconciliation gap, not "the pipeline is dead tonight" — the
  // opening-night pipeline's real dead-man signals are the on-monitor-* and
  // broadcast:* keys above. check-opening-night-drift.yml now routes it with
  // disposition:'digest' (morning digest; a drift open 14+ notifications is
  // escalated to a Linear issue by the router), so nothing goes silent.
  //
  // renew-cookies.js (BRO-4183; owner request 2026-09-27: "if a CAPTCHA or
  // emailed code appears, stop and alert me with one link"). Fires only on a
  // sticky needs-human stop (CAPTCHA, emailed code, rejected login, 2 logins
  // in 7 days, missing Keychain creds). The stop blocks every further login
  // until the owner acts, so it cannot re-fire on its own; the router's
  // per-key cooldown dedups too. All other renewal signals go to the digest.
  'cookie-renew:needs-human:',

  // check-signin-redirects.mjs (BRO-4615, accounts live since 2026-10-04): the
  // daily synthetic click on "Continue with Google" / "Continue with Apple"
  // no longer reaches the provider's sign-in page, so nobody can sign in that
  // way. The usual fix is in the Google Cloud / Apple Developer / Supabase
  // consoles, which only the owner can reach. One key per provider (suffix
  // google|apple). Pages only on a definite failure after two tries; a flaky
  // run (timeout, 429/5xx, browser error) is "inconclusive" and neither pages
  // nor resolves. Resolved by the next passing run. The softer PostHog
  // signals (ugc:signin-stalled, ugc:save-failures, ugc:error-spike from
  // account-metrics.js) stay digest-tier: abandoned sign-ins and offline
  // phones make them noisy at a handful of sign-ups a day.
  'ugc:signin-redirect-broken:',
  // BRO-5477: the auto-fix-first sweep's one email per fix card that did not
  // work (scripts/lib/auto-fix-first.js escalationConditionKey). The fix was
  // already tried, so this is the owner's page.
  'auto-fix-first:escalation:',
];

const PAGE_WORTHY_CONDITION_KEYS = new Set([
  // Meta: alert-pipeline self-tests — must always page (see file header).
  'alert-router:deadman', // health-check.js: disposition='auto' has been silently failing for 7 days
  'e2e-canary:chain-broken', // e2e-canary-alert-chain.js: the real (unmocked) alert→card→dispatch chain is broken
  'alert-router:usage-limit-exceeded', // BRO-281: dispatchCard() hit Linear's USAGE_LIMIT_EXCEEDED — every 'auto' alert fails the same way until the workspace is archived/upgraded
  // Meta (BRO-4373): the alert pipeline itself is down. The digest, the opening-night
  // monitor and the Friday sync all run from launchd on the Mac Studio; after a
  // reboot FileVault holds it at the login screen and all of them stop silently
  // (4.5 days, 2026-09-25..29). Emitted from CI (check-morning-digest-sent.js)
  // when no morning digest reached the owner by ~9:30 ET, so it works while the
  // Mac is dead. It cannot go through the digest: the digest is what is missing.
  'mac:morning-digest-missing',

  // Owner request 2026-10-05 (BRO-4719): "How will I ever know that they're
  // waiting on me for a decision? I didn't even know they existed!" and "don't
  // rely on the Mac Studio". scripts/notify-owner-decisions.js (CI, daily)
  // emails only when a card NEWLY carries a "DECISION NEEDED:" line or the
  // awaiting-owner label; each card is announced once, max one email per 20h.
  'owner-decisions:new',

  // Production feature down for real users (BRO-4603): signed-in users cannot
  // sign in or save ratings, or can see data that is not theirs, and the
  // self-heal did not fix it. test-ugc-roundtrip.yml routes this only when an
  // urgent check failed (hardening checks are NOT_URGENT in
  // scripts/test-ugc-roundtrip.mjs) and resolves it on the next green run.
  'ugc-roundtrip:users-affected',

  // Category (owner-approved 2026-08-03, affiliate hardening session — "it's
  // our only revenue stream, I do want it really strong"): affiliate revenue
  // pipeline BROKEN. Only the checks that mean money is actively being lost
  // page; softer anomalies (bot divergence, payout drift, collapses) stay
  // digest-tier. check-affiliate-health.js additionally runs a 14-day shadow
  // burn-in during which even these route to the digest.
  'affiliate:dead-man', // both click signals near-zero — shared-fate tracking/site breakage
  'affiliate:zero-conversions', // 0 conversions for 7 straight days, beyond any observed variance
  'affiliate:conversions-flatline', // conversions silent beyond own baseline WHILE clicks flow
  'affiliate:handoff-break', // site clicks flowing but Impact stopped recording them
  'affiliate:provider-auth:impact', // Impact API/credentials failing — monitor is blind
  'affiliate:provider-auth:posthog', // PostHog API/credentials failing — monitor is blind

  // 'opening-night-sla:pages-stuck' was here (Category 2) and REMOVED
  // 2026-10-16 (BRO-5480, owner: "Should I even get emails about this at
  // all?"). Reviews stuck in the pipeline have no owner action; it now files
  // a High worker card (disposition 'auto') that closes itself on drain.

  // Category 2 (task #1076): a revoked/unusable local Claude OAuth token
  // disables cmux-launch.js's launch gate entirely — not just tonight's
  // monitor — so this pages immediately rather than waiting in the digest
  // for the owner to discover it by accident on the next launch attempt (as
  // happened 2026-08-05, five shows before opening). Emitted by
  // check-claude-auth-health.js (launchd, runs on the Mac — the token never
  // reaches CI).
  'claude-auth:revoked',
  // 'claude-spawn-starved' / 'claude-spawn-error' (BRO-2971) were listed here
  // and REMOVED 2026-09-25 (BRO-4141, owner: "confusing and un-actionable").
  // They mean the Mac is overloaded or the claude binary is missing, not that
  // the owner must do something: re-login is 'claude-auth:revoked' above.
  // The owner received "[CRITICAL] Claude spawn failing from resource
  // starvation" twice in two days with nothing they could do. They still
  // route (downgraded to the morning digest), so nothing goes silent.

  // 'serp-burst:tripwire' and the four 'guard-escalation:*' keys were here
  // and REMOVED 2026-10-16 (BRO-5490, owner chose option A: technical
  // alerts stop emailing). serp-burst routes to the morning digest (its hard
  // daily cap stops the runaway by itself); the guards file a worker card
  // (disposition 'auto') that the CI sweep cancels once the guard recovers.

  // 'test-yml:main-streak-escalation' was listed below and REMOVED 2026-09-25
  // (BRO-4141). The history is kept for context. Its "24h cooldown caps this
  // to one email per day" claim was false in practice: test.yml's "Resolve
  // escalation alert on failing-job-set change" step resolves the condition
  // whenever the red job set flickers (e.g. "Lint Workflows, Unit Tests" ->
  // "Unit Tests"), so each flicker re-paged. The ledger shows notifyCount 102;
  // the owner got it at 22:46 and 22:52 on 2026-09-24. A red trunk is for the
  // automated fixers (the 2-failure 'auto' tier files the card), not the
  // non-technical owner; it still reaches the digest's "trunk: RED" line.
  //
  // (was) Category 3 carve-out (BRO-1333): main's Test Suite went undetected-red for
  // ~2 days (2026-06-13 → 06-15) because the only signal was a daily digest
  // line nobody read in time — direct pushes to main are not gated by
  // required checks (memory/feedback_branch_protection_direct_push.md), so
  // broken code keeps landing the whole time it stays red. This is the
  // "escalation" tier of that same detector (test.yml's own "Route alert —
  // main test.yml red on consecutive pushes" step, disposition:'human' at 4+
  // consecutive failures) — the 2-failure 'auto' tier still just files a
  // Linear card. Verified still live and needed on 2026-09-16: with this key
  // NOT yet on the allowlist, the 4+ tier had silently fired 73 times over
  // three weeks with zero real pages, its ledger entry pointing at BRO-3030
  // (an unrelated noise-audit issue matched by Linear's own substring search
  // finding the conditionKey quoted in that issue's body, not a dedicated
  // fix-main tracker) — i.e. the exact "digest line nobody reads" failure
  // mode this card exists to close. 24h cooldown (routeAlert call site) caps
  // this to at most one email per day while main stays red.
  // 'test-yml:main-streak' (health-check.js's "no confirmed-green run in Nh"
  // backstop) was listed here by BRO-3865 and REMOVED 2026-09-23 (owner
  // email-noise complaint). It paged the SAME condition as
  // 'test-yml:main-streak-escalation' above under a second conditionKey with
  // its own cooldown, so a red trunk produced two independent email streams.
  // Since BRO-4141 removed the escalation key too, neither emails: both reach
  // the morning digest as error rows (router downgrade human -> digest).
]);

// Category 2 (BRO-4043): the opening-night monitor's ONE final report per show
// per night, 'on-monitor-report-<NIGHT_KEY>-<show-id>-parity-final' (parity
// reached) or '...-escalation-final' (window ended without parity). Sent from
// scripts/opening-night-prompts/monitor-v2.md steps 2-3. These are their own
// conditionKeys on purpose: the router dedups per conditionKey, so an earlier
// mid-window send under the base 'on-monitor-report-<NIGHT_KEY>' key (which
// stays digest-tier) used to return action=silent for the final report, and a
// variant key was demoted to the digest because it was not allowlisted. A
// retry of the identical -final key is still deduped by the router's cooldown,
// so the owner gets exactly one final email per show per night.
const PAGE_WORTHY_FINAL_REPORT_RE = /^on-monitor-report-.+-(?:parity|escalation)-final$/;

function isPageWorthy(conditionKey) {
  if (!conditionKey) return false;
  if (PAGE_WORTHY_CONDITION_KEYS.has(conditionKey)) return true;
  if (PAGE_WORTHY_FINAL_REPORT_RE.test(conditionKey)) return true;
  return PAGE_WORTHY_PREFIXES.some((prefix) => conditionKey.startsWith(prefix));
}

/**
 * Workflows whose own failure may email the owner through
 * .github/actions/notify-failure (BRO-4603).
 *
 * notify-failure was the last open door: it called sendAlert() directly, so
 * any workflow that wrote `severity: 'critical'` + `email: 'true'` paged the
 * owner, bypassing everything above. 13 workflows did. Over 2026-10-01..04
 * that sent the owner 8 "[CRITICAL]" emails and 1 "[Investigation]" email,
 * none of which needed them (two push races, a health-check gate that needs
 * an LLM pass, and a UGC hardening check a fix session closed on its own).
 * Owner, 2026-10-04: "I only want emails if they're really urgent and need
 * me to act on them."
 *
 * The action checks this list before its cooldown/streak logic and never
 * emails for an unlisted workflow. The YAML must agree:
 * tests/unit/page-worthy-workflows.test.mjs fails unless the set of
 * workflows with a severity:'critical' notify-failure step equals this list,
 * so adding a paging workflow means editing this file, the one the owner
 * reads. Everything else fails quietly into the morning digest:
 * check-cron-health.yml keys staleness off each scheduled job's last
 * SUCCESSFUL run, and health-check.js reports repeat failures.
 */
const PAGE_WORTHY_WORKFLOWS = new Set([
  // Meta: the morning digest is the owner's only daily channel. If the check
  // that verifies it went out is itself broken, nothing else will say so.
  'check-morning-digest-sent.yml',
  // Category 2: opening-night pipeline dead on an opening night.
  'opening-night-orchestrator.yml',
  'opening-night-poller.yml',
  'opening-night-broadcast.yml', // the subscriber email the owner sends by hand
  // Sign-in is down until the owner restores the project from the Supabase
  // dashboard; nobody else holds that login.
  'restore-supabase.yml',
  // Owner 2026-10-11: "Theatr breaking should send me a direct email." Only
  // the owner can re-capture an expired Theatr login (from the iPhone app).
  // The YAML pages on 2 consecutive failures, so a one-off token race is quiet.
  'update-theatr.yml',
  // test-ugc-roundtrip.yml is deliberately NOT here: its page is the routed
  // 'ugc-roundtrip:users-affected' key (PAGE_WORTHY_CONDITION_KEYS), which
  // fires only for urgent checks and dedups per incident.
]);

/** @param {string} workflowFile basename or path, e.g. 'vercel-deploy.yml' */
function isPageWorthyWorkflow(workflowFile) {
  if (!workflowFile) return false;
  const base = String(workflowFile).split('@')[0].split('/').pop();
  return PAGE_WORTHY_WORKFLOWS.has(base);
}

/**
 * What the OWNER does when each page arrives (BRO-5480). Owner rule BRO-4603
 * (2026-10-04): "I only want emails if they're really urgent and need me to
 * act on them." The July allowlist categories asked only "is it urgent?", so
 * entries a worker can fix (opening-night-sla:pages-stuck) kept emailing.
 * page-worthy-alerts.test.mjs fails any entry (key, prefix, final-report
 * pattern, workflow) without a row here, so a page cannot be added without
 * naming the owner's action. An empty action is allowed only for the frozen
 * AWAITING_OWNER_DECISION set below, which may shrink but never grow.
 */
const FINAL_REPORT_ENTRY = 'on-monitor-report-*-final';
const OWNER_ACTIONS = {
  // Meta: the auto-fix route itself is down, so nothing else will say so.
  // BRO-5542 (owner 2026-10-16): never "ask Claude". Nothing the owner can do
  // fixes these; the email is the notice because the card route is what broke.
  'alert-router:deadman': 'Nothing is needed from you. The part of the automation that starts fixes is failing, so problems are not being fixed on their own right now. It retries on every scheduled health check.',
  'e2e-canary:chain-broken': 'Nothing is needed from you. The daily test of the part of the automation that starts fixes failed, so problems may not be fixed on their own right now. The test runs again every day.',
  'alert-router:usage-limit-exceeded': 'Raise or reset the Linear plan limit (a billing decision only you can make).',
  'mac:morning-digest-missing': 'Check the Mac is on, awake and signed in.',
  'owner-decisions:new': 'Answer the decision.',
  // BRO-5542: test-ugc-roundtrip.yml starts a START-NOW fix card first and the
  // email says whether it did; the owner has nothing to do either way.
  'ugc-roundtrip:users-affected': 'Nothing is needed from you. The email says whether a fix was started automatically; signed-in users may be affected until it lands.',
  // Owner opted in 2026-08-03 ("it's our only revenue stream, I do want it really strong").
  'affiliate:dead-man': 'Check the Impact account and the site\'s ticket links (your revenue, your call).',
  'affiliate:zero-conversions': 'Check the Impact account (your revenue, your call).',
  'affiliate:conversions-flatline': 'Check the Impact account (your revenue, your call).',
  'affiliate:handoff-break': 'Check the Impact account (your revenue, your call).',
  'affiliate:provider-auth:impact': 'Re-authorize the Impact API credentials (only you hold that login).',
  'affiliate:provider-auth:posthog': 'Re-authorize the PostHog API credentials (only you hold that login).',
  'claude-auth:revoked': 'Log in to Claude again on the Mac.',
  'on-monitor-auth-failed-': 'Log in to Claude again on the Mac.',
  'broadcast:draft-creation-failed:': 'Send the opening-night email yourself; the draft was not created.',
  'broadcast:owner-notification-failed:': 'Send the opening-night email yourself; the reminder to you failed.',
  'broadcast:draft-unsent:': 'Send the opening-night email draft.',
  'broadcast:deadline-draft:': 'Send the opening-night email draft before the deadline.',
  'cookie-renew:needs-human:': 'Re-capture the expired login cookie (needs your login).',
  'check-morning-digest-sent.yml': 'Check the Mac is on, awake and signed in.',
  'opening-night-broadcast.yml': 'Send the opening-night email yourself.',
  'restore-supabase.yml': 'Restore the project from the Supabase dashboard (only you hold that login).',
  'update-theatr.yml': 'Re-capture the Theatr login from the iPhone app.',
  // Owner 2026-10-16 (BRO-5479): "A except for Broadway openings. I want to know
  // then." A Broadway poll emails right away; other markets auto-fix first.
  // BRO-5541, owner 2026-10-16: "I hate getting emailed about issues that can
  // be fixed just by me pasting it into a Claude session." The three
  // auto-fix-first rows below are the owner's own exception to the must-act
  // rule (he chose to hear about these), so they say what is happening and
  // that nothing is needed, never "ask Claude" (auto-fix-first.test.mjs).
  'opening-night-poller.yml': 'Nothing is needed from you. You asked to hear about Broadway opening-night review poller failures; the automation is handling the fix.',
  // Mac-side launcher (opening-night-monitor-launch.js, launchd): only a
  // person at the Mac can fix these, and the Mac-local digest is never read.
  'on-monitor-launch-failed-': 'Check the Mac is on and not frozen; restart it if needed. Tonight\'s opening-night monitor could not start.',
  'on-monitor-auth-starved-sustained-': 'Restart the Mac or close apps: it is too short of memory to run the opening-night monitor.',
  'on-monitor-dead-session-': 'Restart the Mac: the opening-night monitor keeps getting killed for lack of memory.',
  // Kept as emails by the owner (option A, 2026-10-16).
  [FINAL_REPORT_ENTRY]: 'Read tonight\'s opening-night result for this show.',
  'broadcast:overdue:': 'Send the opening-night email; it is overdue.',
  'lane-live-timeout:': 'Check that the show page has its new reviews; if not, tell the coordinator session so it can run the old publish path.',
  'broadcast:never-sent:': 'Send the opening-night email; it never went out.',
  // BRO-5477: files a worker card first and emails only when that automatic
  // fix failed or never started.
  'opening-night-orchestrator.yml': 'Nothing is needed from you. The nightly opening-night review collection failed, so tonight\'s reviews may reach the site late.',
  // BRO-5477: sent only after the automatic fix card failed or never started.
  'auto-fix-first:escalation:': 'Nothing is needed from you. You asked to be told when the automatic fix for an opening-night failure does not work; what broke and what happens next are below.',
};

// Pages that were allowlisted as "urgent" before the must-act rule and name no
// owner action yet. Each is the owner's call (keep emailing, or move to a
// worker card like opening-night-sla). Frozen: the test pins this exact set.
const AWAITING_OWNER_DECISION = new Set([
  // Readers affected; the owner kept this as an email (option A, 2026-10-16)
  // without naming an action yet.
  'ugc:signin-redirect-broken:',
]);

/**
 * Auto-fix first (BRO-5477, owner decision 2026-10-16): opening-night pipeline
 * failures start an automatic fix and email the owner only if that fix fails.
 * A page-worthy failure listed here files a START-NOW fix card instead of
 * emailing; the owner is emailed (key auto-fix-first:escalation:<card>) if it
 * is still failing 3h after the card was filed, if no worker started the card,
 * or if filing the card fails (scripts/lib/auto-fix-first.js decide()).
 *
 * Emails that ask the owner to act stay immediate and must never be listed:
 * broadcast:overdue: (pages before the draft deadline overrides QA gates,
 * broadcast-deadline.js), broadcast:never-sent:, broadcast:draft-unsent:,
 * broadcast:deadline-draft:. page-worthy-alerts.test.mjs pins both lists.
 *
 * To add an alert: add the workflow file here. It also needs auto_fix_first + linear_api_key on its notify-failure step
 * (tests/unit/page-worthy-workflows.test.mjs checks they agree).
 * Kill switch: repo variable AUTO_FIX_FIRST_DISABLED=true.
 */
const AUTO_FIX_FIRST_WORKFLOWS = new Set([
  'opening-night-broadcast.yml',
  'opening-night-orchestrator.yml',
  'opening-night-poller.yml',
]);


function autoFixFirstDisabled(env = process.env) {
  return String((env && env.AUTO_FIX_FIRST_DISABLED) || '').trim().toLowerCase() === 'true';
}

/** @param {string} workflowFile basename or path */
function isAutoFixFirstWorkflow(workflowFile) {
  if (!workflowFile) return false;
  const base = String(workflowFile).split('@')[0].split('/').pop();
  return AUTO_FIX_FIRST_WORKFLOWS.has(base) && isPageWorthyWorkflow(base);
}

/**
 * The owner's action for a condition key, for the first line of its email
 * (BRO-5498). Exact key first, then the longest matching prefix, then the
 * final-report pattern. null when none is named (the AWAITING entries).
 * @param {string} conditionKey
 * @returns {string|null}
 */
function ownerActionFor(conditionKey) {
  if (!conditionKey) return null;
  const base = String(conditionKey).split('@')[0].split('/').pop(); // workflow path/ref -> file
  if (Object.hasOwn(OWNER_ACTIONS, conditionKey)) return OWNER_ACTIONS[conditionKey];
  if (Object.hasOwn(OWNER_ACTIONS, base) && PAGE_WORTHY_WORKFLOWS.has(base)) return OWNER_ACTIONS[base];
  const prefix = PAGE_WORTHY_PREFIXES.filter((p) => conditionKey.startsWith(p) && OWNER_ACTIONS[p])
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return OWNER_ACTIONS[prefix];
  if (PAGE_WORTHY_FINAL_REPORT_RE.test(conditionKey)) return OWNER_ACTIONS[FINAL_REPORT_ENTRY] || null;
  return null;
}

/**
 * Email body with the owner's action as its first line, the one format every
 * owner email uses (router, notify-failure, auto-fix-first). Unchanged when no
 * action is named.
 */
function withOwnerAction(key, description) {
  const action = ownerActionFor(key);
  return action ? `What to do: ${action}\n\n${description || ''}` : description;
}

/** Every entry that can page: keys, prefixes, the final-report pattern, workflows. */
function allPageWorthyEntries() {
  return [...PAGE_WORTHY_CONDITION_KEYS, ...PAGE_WORTHY_PREFIXES, FINAL_REPORT_ENTRY, ...PAGE_WORTHY_WORKFLOWS];
}

module.exports = {
  AUTO_FIX_FIRST_WORKFLOWS,
  autoFixFirstDisabled,
  isAutoFixFirstWorkflow,
  PAGE_WORTHY_CONDITION_KEYS,
  PAGE_WORTHY_FINAL_REPORT_RE,
  PAGE_WORTHY_PREFIXES,
  PAGE_WORTHY_WORKFLOWS,
  isPageWorthy,
  isPageWorthyWorkflow,
  OWNER_ACTIONS,
  AWAITING_OWNER_DECISION,
  allPageWorthyEntries,
  ownerActionFor,
  withOwnerAction,
};
