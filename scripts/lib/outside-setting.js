'use strict';
// BRO-7994: shared, pure detection for launches that depend on a setting held OUTSIDE the repo (an OAuth client's
// authorized origins, DNS records, a third-party dashboard, an app-store setting, a key the owner holds) that the
// session could not check from its container.
//
// Incident (2026-11-21, BRO-6917 Part 5): Google One Tap went live on desktop. It only works if the Google OAuth web
// client lists both site origins. The session wrote "Not checkable from a cloud session", looked at PostHog 3 minutes
// after go-live, saw 0 events and closed SAFE TO ARCHIVE. It paused the card with RECHECK-AFTER 30 days out and the
// acceptance `test -f src/lib/google-one-tap.ts` (always passes). Real traffic: 14 of 14 desktop attempts refused
// (unregistered_origin) within 24 hours.
//
// Used by: scripts/lib/live-run-stop.mjs (the Stop check), scripts/lib/linear-done-gate.js (the Done gate) and
// scripts/lib/recheck-report-preview.js (the paused-report preview). Pinned by outside-setting.test.mjs.

// The session's own words admitting it could not check an outside setting. Measured on 600 real Linear comments
// (2026-11-20/21, see outside-setting.test.mjs header) before it was wired.
// Narrow on purpose (ship-check): bare origin (origin/main), console (console output), client and dashboard read as
// ordinary engineering words, so they count only when qualified.
const OUTSIDE_NOUN = String.raw`(?:(?:authorized |javascript |js |site |allowed )origins?|origins?(?![\/\w-])(?=[^.\n]{0,40}\b(?:google|oauth|client|console|allow|authoriz))|o-?auth|(?:oauth|web|google|apple|sign-?in) client(?: id)?|client id|console(?![ .](?:output|logs?|errors?|warnings?|window|messages?|statements?)\b|\.\w)|(?:vercel|supabase|posthog|resend|google|apple|stripe|cloudflare|sentry|impact|formspree|provider|admin) dashboard|dns|domain|registrar|cname|txt record|spf|dkim|app store|app-store|testflight|associated domains?|redirect uri|google cloud|apple developer|vercel (?:project|setting|env)|supabase (?:auth|provider|dashboard|setting)|resend domain|third-party setting|outside setting|external setting|provider setting)`;
const ADMIT_RE = new RegExp([
  String.raw`\bnot (?:checkable|verifiable|testable|visible) from (?:a |the |this )?(?:cloud|container|sandbox|session|here)\b`,
  String.raw`\b(?:can(?:no|')t|cannot|could(?: not|n't)|unable to|no way to)\s+(?:be\s+)?(?:verif(?:y|ied)|check(?:ed)?|confirm(?:ed)?|see|tell|reach|access|get (?:in)?to|open|log (?:in)?to|sign (?:in)?to)\b[^.\n]{0,80}?\b` + OUTSIDE_NOUN + String.raw`\b`,
  String.raw`\b` + OUTSIDE_NOUN + String.raw`\b[^.\n]{0,60}?\b(?:can(?:no|')t|cannot|could(?: not|n't)) (?:be )?(?:verif(?:y|ied)|check(?:ed)?|confirm(?:ed)?)\b`,
  String.raw`\b(?:only the owner|the owner must|needs the owner to|owner has to)\b[^.\n]{0,60}?\b(?:add|set|register|enable|change|list|configure|save)\b[^.\n]{0,60}?\b` + OUTSIDE_NOUN + String.raw`\b`,
].join('|'), 'i');

// Text the session quotes or fences is not its claim.
const stripQuoted = (t) => String(t || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”/g, ' ')
  .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');

// Lazy (hook-replay scope): only the recheck route needs these readers.
function parseRecheckAfter(t) {
  return require('./recheck-stamp.js').parseRecheckAfter(t);
}
function evaluateVerifiability(t, a) {
  return require('./verify-gate.js').evaluateVerifiability(t, a);
}

// A negated admission ("there is no outside setting it can't verify") is not an admission.
// Same clause only: "No problem: I can't verify the DNS" is still an admission.
const NEG_BEFORE_RE = /\b(?:no|not|never|nothing|without)\b[^.\n:;,!?]{0,25}$/i;

/** PURE. The first admission in text, or null. */
function admitsUnverifiable(text) {
  const t = stripQuoted(text);
  const re = new RegExp(ADMIT_RE.source, 'gi');
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    if (/^not\b/i.test(m[0]) || !NEG_BEFORE_RE.test(before)) return m[0];
  }
  return null;
}

// An explicit declaration line the Stop check asks for; the Done gate keys on it.
const DECLARE_RE = /^[ \t>*_-]*OUTSIDE-SETTING(?:\*\*)?[ \t]*:[ \t]*(\S.{9,})$/im;
const BYPASS_RE = /^[ \t>*_-]*NO-OUTSIDE-SETTING(?:\*\*)?[ \t]*:[ \t]*(\S.{14,})$/im;
const LIVE_CHECK_RE = /^[ \t>*_-]*LIVE-CHECK(?:\*\*)?[ \t]*:[ \t]*(\S.{9,})$/gim;

const declaration = (text) => { const m = DECLARE_RE.exec(String(text || '')); return m ? m[1].trim() : null; };
const bypass = (text) => { const m = BYPASS_RE.exec(String(text || '')); return m ? m[1].trim() : null; };

// "0 events", "no errors", "nothing broke": the absence of failure is not a success (the incident's exact evidence).
const ABSENCE_RE = /\b(?:0|zero|no|none|nothing)\b[^.\n]{0,25}\b(?:events?|errors?|failures?|complaints?|reports?|issues?|broke|refus\w*)\b|\binconclusive\b|\bno (?:sign of )?(?:errors?|problems?|failures?)\b/i;
const SUCCESS_RE = /\b(?:succe\w*|complet\w*|shown|displayed|signed[ -]?(?:in|up)|sign[ -]?(?:ins|ups)|logins?|delivered|accepted|verified|working|worked|opened|rendered|200\b|passed|ok\b)/i;

/** PURE. LIVE-CHECK lines in text: [{ line, counts:[n>=2] }] for lines that cite at least 2 successes and no absence-only claim. */
function liveCheckClaims(text) {
  const out = [];
  for (const m of String(text || '').matchAll(new RegExp(LIVE_CHECK_RE.source, 'gim'))) {
    const line = m[1];
    if (ABSENCE_RE.test(line) && !SUCCESS_RE.test(line.replace(ABSENCE_RE, ''))) continue;
    if (!SUCCESS_RE.test(line)) continue;
    const counts = [...line.matchAll(/(?<![\w.:-])(\d{1,7})(?![\w.:%-])/g)].map((x) => Number(x[1])).filter((n) => n >= 2);
    if (counts.length) out.push({ line: line.trim(), counts });
  }
  return out;
}

// Tool calls that READ real production signals (not echo/grep): PostHog/Vercel/Supabase/Sentry connectors and the
// committed read scripts. Server ids are uuids in cloud, so connector tools match on their action name.
const LIVE_READ_TOOL_RE = /__(?:exec|execute_sql|get_runtime_logs|get_runtime_errors|count_events|aggregate_events|count_pageviews|aggregate_pageviews|query_logs|list_user_events)$/;
const LIVE_READ_CMD_RE = /\b(?:cloud-run-script\.js|account-metrics(?:\.js)?|posthog[\w-]*\.(?:m?js|sh)|traffic-metrics\.js|sentry[\w-]*\.js)\b/;
// Not live reads (review B1): a curl of a page (any HTML is full of small numbers) and check-prod-deploy (deploy state,
// not user successes).
const ECHO_ONLY_RE = /^\s*(?:echo|printf|cat\s*<<|true|:)\b/;

/** PURE. Is this tool call a read of live production data? */
// The script must be RUN (node/bash/sh/npx), not read: `cat x.js`, `grep … x.mjs`, `node --check x.js` print source
// full of digits that would "confirm" any LIVE-CHECK number (ship-check).
const RUNS_SCRIPT_RE = new RegExp(String.raw`(?:^|[;&|(]\s*|\s&&\s*)(?:[A-Z_]+=\S*\s+)*(?:node|bash|sh|npx(?:\s+tsx)?|tsx)\s+(?!(?:-c|--check)\b)(?:-\S+\s+)*\S*` + LIVE_READ_CMD_RE.source.replace(/^\\b/, ''));
function isLiveRead(name, input) {
  if (LIVE_READ_TOOL_RE.test(String(name || ''))) return true;
  if (name !== 'Bash') return false;
  const c = String((input && input.command) || '');
  return !ECHO_ONLY_RE.test(c) && RUNS_SCRIPT_RE.test(c) && !/\s(?:--check|-c)\b/.test(c);
}

// Acceptance commands that only show a file exists prove nothing about a live effect (the incident's `test -f`).
// Every segment of a chain is judged (`cd x && test -f a` is still existence-only); grep/wc/head over a file and a
// bare `node -e` read the repo, not the live effect (ship-check).
const EXISTENCE_ONLY_RE = /^\s*(?:test\s+-[efdrs]\b|\[\s+-[efdrs]\b|ls\b|true\b|echo\b|cat\b|stat\b|cd\b|grep\b|rg\b|wc\b|head\b|tail\b|node\s+-e\b|:)/;
/** PURE. Is this acceptance command a real check (not existence-only)? */
const acceptanceIsReal = (cmd) => {
  const segs = String(cmd || '').split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  return segs.length > 0 && segs.some((s) => !EXISTENCE_ONLY_RE.test(s));
};

const RECHECK_MAX_DAYS = 7;

/**
 * PURE. Does text carry a recheck that will really catch an outside-setting failure? -> { ok, reason }
 * Needs a RECHECK-AFTER within RECHECK_MAX_DAYS of now (an outside-setting failure shows within a day of real
 * traffic; the incident's 30-day date hid a failure visible on day one) and an acceptance command that is real.
 * Parsing reuses the shared readers (recheck-stamp.js, verify-gate.js) so a hand-stamped card reads the same here.
 */
function recheckAcceptanceOk(text, now = new Date()) {
  const t = String(text || '');
  const at = parseRecheckAfter(t);
  if (at == null) return { ok: false, reason: 'no RECHECK-AFTER date' };
  const day = new Date(at).toISOString().slice(0, 10);
  const days = (at - now.getTime()) / 86400e3;
  if (!(days <= RECHECK_MAX_DAYS)) return { ok: false, reason: `RECHECK-AFTER ${day} is more than ${RECHECK_MAX_DAYS} days out` };
  // A date already past is a stale stamp, not a pending recheck (ship-check).
  if (!(days >= -1)) return { ok: false, reason: `RECHECK-AFTER ${day} is already past` };
  const { cmd } = evaluateVerifiability(t, []);
  if (!cmd) return { ok: false, reason: 'no VERIFY / acceptance command the verify gate accepts next to the RECHECK-AFTER' };
  if (!acceptanceIsReal(cmd)) return { ok: false, reason: `the acceptance command only checks that a file exists (${cmd.slice(0, 80)})` };
  return { ok: true, reason: `RECHECK-AFTER ${day} with ${cmd.slice(0, 80)}` };
}

module.exports = {
  ADMIT_RE, admitsUnverifiable, declaration, bypass, liveCheckClaims, isLiveRead, acceptanceIsReal, recheckAcceptanceOk,
  RECHECK_MAX_DAYS, stripQuoted,
};
