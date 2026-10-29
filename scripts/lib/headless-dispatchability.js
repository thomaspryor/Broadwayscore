/**
 * headless-dispatchability.js — "can an UNATTENDED session actually FINISH
 * this card?", asked at SELECTION time.
 *
 * WHY THIS EXISTS (task #1004, 2026-08-04)
 *   The backlog drain went 0-for-4 on 2026-08-04 and the first postmortem
 *   blamed a red trunk. Reading ~/Library/Logs/bsc-jobs/ disproved that:
 *   neither failing session ever hit a push rejection. Both COMPLETED their
 *   work and then stopped at a gate that structurally requires a human.
 *
 *     30-msdaql3v ($9.34) — root-caused the bug, fixed it, 5/5 tests, tsc +
 *       lint clean, visual QA done, live-verified in Playwright, review gate
 *       PASS. Ended: "waiting on your visual-qa approval to push commits
 *       c2627bc0db0 + 04fcc4fa70b". The pre-push visual gate
 *       (.claude/hooks/pre-push-visual-gate.sh) blocks every push of a UI
 *       diff until the OWNER types a plain affirmative. An unattended run can
 *       never satisfy that — no owner is reading. #30 was a rage-click card,
 *       i.e. UI by construction; it should never have been picked.
 *     57-msdjb8do ($5.40) — work complete, ended "waiting on the Reddit
 *       re-scrape workflow (run 30839879048) to finish before final
 *       verification and merge". Nothing resumes a finished headless session.
 *
 *   Both were scored card-fail. $14.74 was charged as "zero completions" when
 *   two sessions had produced finished, verified work that merely could not
 *   land. bsc-next.js already refuses cards with no runnable verify command;
 *   this is the same refusal one class over — refuse the cards whose
 *   COMPLETION, not whose verification, needs a human.
 *
 * POLICY (the answer to "resume mechanism or don't start?"): don't start.
 *   A resume mechanism would have to re-enter a dead session's context hours
 *   later and re-derive why it stopped. Refusing at selection costs nothing,
 *   is checkable, and leaves the card for an attended cmux dispatch where the
 *   owner is present to clear the gate.
 *
 * USED BY
 *   - scripts/bsc-next.js       (the --headless dispatch gate)
 *   - scripts/backlog-drain.js  (candidate scan, before it spends anything)
 *
 * CLI
 *   node scripts/lib/headless-dispatchability.js --subject=... --notes=...
 *   Exits 0 when dispatchable, 1 when a human gate blocks it.
 */

'use strict';

const { findDecisionQuestion } = require('./decision-card-parse.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { OWNER_JUDGMENT_RE } = require('./owner-judgment-marker.js');
const { hasNoDispatchMarker } = require('./no-dispatch-marker.js');
const { hasAutofixFiledMarker } = require('./autofix-filed-marker.js');
const { parseVisualApproval } = require('../../src/lib/owner-decision-link.js');
const { classifyStatus: visualApprovalStatus } = require('./visual-approval.js');
const { AUTO_FILED_MARKER: ALERT_ROUTER_FILED_MARKER } = require('./linear-drain-parked.js');

// Anchored to the leading `PARKED:` line, same reasoning and same shape as
// autofix-filed-marker.js's own AUTOFIX_PARKED_RE (BRO-2499 ship-check): an
// unanchored `.includes()` misclassifies any issue that merely QUOTES the
// marker while discussing this pipeline (a meta-issue about BRO-3060 itself,
// for instance) as automation-parked. That would have been a message-only
// bug when this predicate only picked the wording of an operator hint — but
// BRO-3060's own fix reuses this SAME predicate to gate --allow-automation-
// parked's PARKED_SENTINEL waiver, where the same false positive would let
// an operator bypass a genuine owner park (ship-check finding).
const ALERT_ROUTER_PARKED_RE = new RegExp(`^PARKED:[^\\n]*${ALERT_ROUTER_FILED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const BLOCKERS = Object.freeze({
  PARKED_SENTINEL: 'PARKED_SENTINEL',
  NO_DISPATCH_MARKER: 'NO_DISPATCH_MARKER',
  VISUAL_QA_GATE: 'VISUAL_QA_GATE',
  ASYNC_WAIT_GATE: 'ASYNC_WAIT_GATE',
  OWNER_DECISION_GATE: 'OWNER_DECISION_GATE',
  NO_VERIFY_CMD: 'NO_VERIFY_CMD',
});

// The repo's own do-not-dispatch sentinel. `scripts/lib/linear-issue-create.js:141` writes
// it verbatim on every `--park`:
//     `PARKED: ${disposition.reason}\n\n${description || ''}`
// so this is an exact match on a generated marker, not a heuristic on prose.
//
// MULTILINE (/m) is load-bearing, not tidiness. Notion-mirrored issues carry two
// generated header lines — `[notion:<uuid>] …` and a bare URL — BEFORE the
// sentinel, so a string-anchored /^\s*PARKED\s*:/i misses them. Measured against
// all 432 live open P0/P1 issues on 2026-09-03:
//
//     contains PARKED anywhere :  211 total / 163 dispatchable
//     /^\s*PARKED\s*:/i        :  160 total / 127 dispatchable
//     /^\s*PARKED\s*:/im       :  200 total / 158 dispatchable   <- this
//     gained by /m             :   40 total /  31 dispatchable
//
// The 11 that even /m misses are correctly missed: they are prose mentions
// ("Auto-parked by bsc-reconcile", "linear-drain-parked.js", a `## Parked
// 2026-08-08` heading). Dropping the anchor entirely would catch those too and
// refuse cards nobody parked, so line-start is the right stopping point.
//
// Note `\s*` spans newlines, so a card that QUOTES `PARKED:` at a line start
// blocks itself — the same self-exclusion hazard owner-judgment-marker.js:38-44
// documents. For a default-deny gate that is the safe direction to fail.
const PARKED_SENTINEL_RE = /^\s*PARKED\s*:/im;

// Byte-identical to UI_PATTERN in .claude/hooks/pre-push-visual-gate.sh (the
// hook that actually blocks the push), modulo the shell-vs-JS escaping of the
// literal '/'. The test asserts the two stay in sync by parsing the hook —
// if the gate widens to a new extension and this doesn't, headless sessions
// silently start picking cards they can't land again.
const UI_PATH_RE = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)/;

// Path-ish tokens in free card text: `src/components/Foo.tsx`,
// "scripts/lib/bar.js", src/**/*.{tsx,css}, tailwind.config.ts.
// '*' is allowed inside a directory segment so the `src/**/*.tsx` form a card
// author actually writes is captured, not just concrete paths.
const PATH_TOKEN_RE = /(?:[\w.@*-]+\/)+[\w.*{},[\]-]+|(?:tailwind|postcss)\.config\.\w+/g;

// Card classes whose remit is UI by construction, so they trip the visual
// gate even when the card names no file. Both are machine-generated card
// families (PostHog rage-click cards, the mobile/desktop UX audit sweep), so
// matching the phrase is precise, not a keyword guess.
//
// Matched anywhere in the SUBJECT, not anchored to its start (ship-check
// finding, Codex 2026-08-04): an anchored version let pending #63 "Homepage
// rage clicks persist beyond known labeled issues" through — same card
// family, phrase just isn't first. Subject-scoped, never notes: a backend
// card that merely cites a rage-click card as context must stay dispatchable.
const UI_CARD_CLASS_RE = /(?:rage[- ]clicks?\b|\bux audit\s*:|\bvisual qa\b)/i;

// An explicit instruction to run the visual-QA ritual is the same gate.
const VISUAL_QA_MENTION_RE = /(?:^|[^\w-])(?:\/visual-qa\b|visual[- ]qa\b|VISUAL-OK\b)/i;

// Completion deliberately deferred past this session: a cron that hasn't run,
// a date that hasn't arrived, N clean runs that haven't accumulated. These are
// PAUSED-with-RECHECK-AFTER cards by CLAUDE.md's own rule — an unattended
// session can only sit on them until it dies.
const ASYNC_WAIT_RES = [
  /RECHECK[- ]AFTER\s*:/i,
  // /m so it fires on a deferral line anywhere in the notes, not only when it
  // opens the subject (ship-check finding: without /m, `^` anchored to the
  // very start of the joined subject+notes string).
  /^\s*after\s+\d{4}-\d{2}-\d{2}\b/im,
  /\bwait(?:s|ing)?\s+for\s+(?:the\s+)?(?:next\s+)?(?:cron|nightly|scheduled\s+run|workflow\s+run)\b/i,
  /\b(?:verify|confirm|prove|recheck)[^.\n]{0,80}\b(?:after|once)\b[^.\n]{0,80}\b(?:the\s+)?(?:next\s+)?(?:cron|nightly\s+run|next\s+run|tomorrow|overnight|next\s+opening\s+night)\b/i,
  /\b\d+\s+(?:consecutive\s+)?clean\s+(?:runs?|weeks?|days?|nights?)\b/i,
];

// The card itself says a human has to decide. VERIFY: owner-judgment is
// handled separately (it satisfies the verify gate but still needs an owner
// to judge the outcome, so it is a headless blocker here even though
// bsc-next's verify gate accepts it).
const OWNER_DECISION_RES = [
  // BRO-6234: a line-start block only (optional bold/list marker). A card that
  // quotes or discusses the phrase mid-sentence or in backticks (BRO-5371,
  // BRO-6180) is not asking for a decision.
  /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?DECISION NEEDED\b/im,
  // Same regex object autonomous-eligibility.js and verify-gate.js use — it
  // was a third handwritten copy until task #1154 pulled it into a leaf module.
  OWNER_JUDGMENT_RE,
  /\bowner\s+(?:must|needs?\s+to|has\s+to|should)\s+(?:decide|choose|approve|pick|sign off)\b/i,
  /\b(?:needs?|requires?|awaiting)\s+(?:an?\s+)?owner\s+(?:decision|judgment|judgement|approval|call)\b/i,
  // BRO-4868: "needs the owner's answer" / "requires the owner's input" phrasing.
  /\b(?:needs?|requires?|awaiting|waiting\s+(?:on|for))\s+(?:the\s+)?owner(?:'s|\u2019s)\s+(?:answer|input|decision|call|approval|judg(?:e)?ment|go-ahead)\b/i,
];

// Expand a brace group once: src/**/*.{tsx,css} -> [src/**/*.tsx, src/**/*.css]
function expandBraces(token) {
  const m = /^(.*)\{([^{}]*)\}(.*)$/.exec(token);
  if (!m) return [token];
  return m[2].split(',').map(part => `${m[1]}${part.trim()}${m[3]}`);
}

// A glob can't be tested against a concrete-path regex, so substitute a
// placeholder segment for the wildcards: src/**/*.tsx -> src/x/x.tsx.
function concretize(token) {
  return token.replace(/\*\*\/?/g, 'x/').replace(/\*/g, 'x').replace(/\/{2,}/g, '/');
}

function looksLikeUiPath(rawToken) {
  const cleaned = String(rawToken || '').replace(/^[`'"(\[]+/, '').replace(/[`'"),.;:\]]+$/, '');
  if (!cleaned) return false;
  for (const variant of expandBraces(cleaned)) {
    if (UI_PATH_RE.test(concretize(variant))) return true;
  }
  return false;
}

function extractPathTokens(text) {
  return String(text || '').match(PATH_TOKEN_RE) || [];
}

function uiPathsIn(text) {
  const hits = [];
  for (const token of extractPathTokens(text)) {
    const cleaned = token.replace(/^[`'"(\[]+/, '').replace(/[`'"),.;:\]]+$/, '');
    if (looksLikeUiPath(cleaned) && !hits.includes(cleaned)) hits.push(cleaned);
  }
  return hits;
}

function firstMatch(res, text) {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0].trim().slice(0, 120);
  }
  return null;
}

/**
 * @param {object} card
 * @param {string} card.subject   card title (task-mirror subject / Notion name)
 * @param {string} [card.notes]   full card body; falls back to card.description
 * @param {object} [opts]
 * @param {string|null} [opts.verifyCmd]  verify command already extracted by the
 *   caller (bsc-next extracts it once at its dispatch gate). Omit to derive it
 *   from notes via the canonical verify-gate.
 * @param {boolean} [opts.requireVerifyCmd=true]  set false when the caller has
 *   its own reason to dispatch unarmed (--allow-unverifiable, truncated mirror).
 * @returns {{dispatchable: boolean, blockers: Array<{code: string, detail: string}>, reason: string|null}}
 */
// Exported (BRO-3060 ship-check finding, Codex adversarial review): a
// blindly-trusted --allow-automation-parked flag — waived purely because the
// caller passed it, the same convention --allow-autofix-filed already uses —
// would also unpark a genuine owner park if a caller ever passed the flag on
// the wrong issue (by mistake, or a future careless caller). PARKED_SENTINEL
// is the one guard this fix exists to get past correctly, so linear-next.js
// re-verifies the description against this SAME predicate before honouring
// the flag, rather than trusting it blindly like the autofix-filed waiver
// does. One function, so the classifier's own detail text and linear-next.js's
// waiver check can never drift apart on what counts as "automation-parked".
function isAutomationParked(notes) {
  const n = String(notes || '');
  return hasAutofixFiledMarker(n) || ALERT_ROUTER_PARKED_RE.test(n);
}

// BRO-4535: a session that wrote "PARKED: <reason>" by hand is usually waiting
// on something a headless worker can supply itself (a rule-18 review, a
// worktree, a monitor window), and nothing ever came back to unpark it. Those
// cards may go to the drain. Default-deny: EVERY PARKED line must name a
// technical reason from the allowlist and none may name an owner hold, so an
// ambiguous or unfamiliar reason stays parked. Only the sentinel lines are
// read, never the card body, so a card that merely discusses "approval" in
// passing is judged on its park reason alone.
const OWNER_HOLD_PARK_RE = /owner|go-ahead|approv|policy|human|judg|decision|design call|taste|manual|credits|sequenced|strongest model|do not dispatch|don't dispatch|not auto-dispatch|blind-dispatch|unattended|this session|superseded|blocked|decid|deliberately|picking between|choose between|owned by|lands? first|after .*reset|simulator|interactive|by-hand|by hand/i;
const TECHNICAL_PARK_RE = /rule.?18|second-opinion|plan-review|worktree|mid-window|monitor (pass|window)|next (working )?(session|pass)|scoring-delta|review-texts checkout|swap at|cloud (session|container)|classifier/i;
const PARK_REASON_LINES_RE = /^\s*PARKED\s*:(.*)$/gim;

function isDrainableSessionParked(notes) {
  const n = String(notes || '');
  if (isAutomationParked(n)) return false;
  const reasons = [...n.matchAll(PARK_REASON_LINES_RE)].map((m) => m[1].trim());
  return reasons.length > 0 && reasons.every((r) => r && TECHNICAL_PARK_RE.test(r) && !OWNER_HOLD_PARK_RE.test(r));
}

// BRO-5372: OWNER_HOLD_PARK_RE is a deliberately wide deny list, so a technical
// park worded "per-outlet naming judgment" or "needs human triage" reads as the
// owner's call and no worker ever takes the card (72 such cards on 2026-10-14,
// about 50 of them plain technical work). The words below name what only the
// owner can supply: money, a login or account, a product/taste call, an
// irreversible bulk change, their calendar, or their Mac. Used only to keep the
// advisory quiet; it never widens what drains.
const OWNER_ONLY_PARK_RE = /\bmac\b|launchd|simulator|money|spend|subscription|credits|\bpaid\b|payment|price|login|log[- ]in|sign[- ]?in|oauth|cookie|password|account|calendar|schedul|taste|owner-review|product (?:call|decision)|irreversib|bulk|quota|budget|iphone|device|different repo|other repo|legal|thomas|duplicate of/i;

// BRO-5626: what a session park can name that a worker really cannot get past:
// a key or credential, a date or event to wait for, a card that is a log and
// not work, work deferred to whoever next touches the code, a risky change, or
// the private review-texts corpus a cloud container may not carry.
// Word-bounded so "tokenizer" or "untilted" don't hold a card.
const REAL_BLOCK_PARK_RE = /\b(?:api[- ]?keys?|keys?|tokens?|secrets?|credentials?|creds?)\b|review-texts|\ba week of\b|\bdays of\b|\bduring a real\b|\bnot work\b|\b(?:audit|watch) log\b|\bwhen (?:we|the)\b|\bbefore dispatching\b|\b(?:nothing|not actionable|waits?|waiting|hold|held|parked)\b[^.;]{0,30}\buntil\b|\buntil (?:then|\d)|\bwaits? (?:on|for)\b|\bnot yet\b|\bconfirm(?:ing)? (?:the )?pattern\b|\bdeliberate look\b|\blive provider\b|\brisky\b|\bnever auto|\bwaiting (?:on|for)\b|\bwait (?:for|until)\b|\bafter (?:the |a |\d)|\bin \d+ (?:days?|weeks?)\b|\b\d{4}-\d{2}-\d{2}\b|\breset\b/i;

/**
 * True when a session's park reason names no owner hold, nothing only the owner
 * can supply, and no real block (BRO-5626). The Mac drain's allowlist
 * (isDrainableSessionParked) left 89 such cards unpicked on 2026-10-18:
 * "triaged from retired Notion backlog", "needs its own session", "§18 review
 * first". Only the unpark drain (scripts/linear-unpark-drain.js) uses this; the
 * picker keeps its default-deny rule and sees the card once the drain has
 * moved it to Todo.
 */
// BRO-5626 ship-check: actions a worker must not take just because a card reached
// Todo (spend, prod writes, email, deploys, other repos, dependencies, waits).
// The drain is default-allow on park reasons, so this list errs wide: a false
// hold only leaves a card parked, a miss moves an unsafe one.
const RISKY_ACTION_PARK_RE = /\baccess\b|\bdeploy|\bprod(?:uction)?\b|\bdelet|\bdrop\b|\bmigrat|\be-?mails?\b|\bbroadcast|\bsend\b|\bre-?scor|\bbulk\b|\bmass\b|force[- ]push|\bios\b|app store|testflight|\bdepends? on\b|\bblocked by\b|\bafter BRO-\d+|\bBRO-\d+\s+(?:lands?|merges?|ships?|is done)\b(?!-)|\bonce\b|opening night|reviews? drops?|\bsupabase\b|\bvercel\b|~\/\.claude|\bhooks?\b|\bmac\b|\bdispatch(?:es)? \d+|(?<![-§])\b\d{2,}\s+(?:runs|reviews|cards|shows|dispatches|issues|rows|files)\b|prompt change|§ ?13|\ba\/b\b|\bspend|\bcredits?\b|\bcost|\bpaid\b|\bbilling\b|\bowner\b|\bhuman\b|\bmanual|\bby hand\b|irreversible|destructive|\brunning in\b|in[- ]flight|\bstarted by\b|another session|being worked/i;

// BRO-5626 (parent review of the 108 held cards): text that reads as a hold but is not one.
// A negated hold ("no spend", "not an owner decision"), a field name ("humanAction"), and a wait
// on a date that has already passed.
const NEGATED_HOLD_RE = /\b(?:not an owner decision|no owner input|no (?:spend|cost)(?: or [\w-]+)? impact)\b/gi;
const DATED_WAIT_RE = /(?:\b(?:waits?|waiting)\s+)?(?:\b(?:until|after|since|before)\s+)?\b(\d{4}-\d{2}-\d{2})\b/g;
// BRO-6238: wording that only describes work already done and tripped the spend or
// dependency holds ("BRO-5426 raised the poller step budget", "tax-credit
// shows"). "needs its own session", "research batch" and "profiling pass" are work
// reasons (BRO-5626) with no hold word of their own. "after BRO-N <verb>" is
// deliberately NOT neutralized: written in past tense it is often a future dependency.
const INCIDENTAL_HOLD_RE = /(?<!\bafter\s+)\bBRO-\d+\s+(?:raised|added|fixed|covered)\b|\bstep budgets?\b/gi;

function neutralizeParkReason(reason, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return String(reason || '')
    .replace(/humanAction/gi, 'action')
    .replace(NEGATED_HOLD_RE, ' ')
    .replace(INCIDENTAL_HOLD_RE, ' ')
    .replace(/\btax[- ]credits?\b/gi, 'tax')
    .replace(DATED_WAIT_RE, (m, date) => (date < today ? ' ' : m));
}

function isWorkerTakeableParkReason(reason, now = new Date()) {
  const raw = String(reason || '').trim();
  if (!raw || isAutomationParked(`PARKED: ${raw}`)) return false;
  const r = neutralizeParkReason(raw, now).trim();
  return !OWNER_HOLD_PARK_RE.test(r) && !OWNER_ONLY_PARK_RE.test(r) && !REAL_BLOCK_PARK_RE.test(r) && !RISKY_ACTION_PARK_RE.test(r);
}

/** Every PARKED line on the card is worker-takeable (at least one line). */
function hasOnlyWorkerTakeableParks(notes, now = new Date()) {
  const reasons = [...String(notes || '').matchAll(PARK_REASON_LINES_RE)].map((m) => m[1].trim());
  return reasons.length > 0 && reasons.every((r) => isWorkerTakeableParkReason(r, now));
}

/**
 * BRO-5626, warn-only, session filers: the park reason names nothing that stops
 * a worker, so --park only delays the card until the daily unpark drain. Null
 * when the reason holds the card for a real reason.
 */
function takeableParkAdvisory(reason) {
  if (!isWorkerTakeableParkReason(reason)) return null;
  return 'PARK-ADVISORY: this park reason names nothing a worker cannot do (no owner call, key, date, spend or Mac). '
    + 'File it with --dispatch and a VERIFY line so it lands in Todo, or with --child "<session title>" if a child session is starting on it now (BRO-6359). Parked, it waits for the daily unpark drain, '
    + 'which moves it to Todo only if it has a safe VERIFY (BRO-5626).';
}

/**
 * Warn-only filing advisory: the park reason reads as an owner hold but names
 * nothing only the owner can supply. Returns the warning text, or null.
 */
function parkReasonAdvisory(reason) {
  const r = String(reason || '').trim();
  if (!r || isAutomationParked(`PARKED: ${r}`)) return null;
  const hit = r.match(OWNER_HOLD_PARK_RE);
  if (!hit || OWNER_ONLY_PARK_RE.test(r)) return null;
  return `PARK-ADVISORY: the park reason contains "${hit[0]}", so every worker reads this card as waiting on the owner and never takes it. `
    + 'If a worker can do it, file it with --dispatch and a VERIFY line instead. Park for the owner only when it needs money, '
    + "a login or account only the owner has, a product or taste call, an irreversible bulk change, or the owner's Mac (BRO-5372).";
}

// BRO-3536: which classifier blockers actually still refuse a headless
// dispatch once the caller's flags are applied. --force / --allow-automation-
// parked / --allow-session-parked waive PARKED_SENTINEL ONLY; every other
// blocker (OWNER_DECISION_GATE, VISUAL_QA_GATE, ...) needs --allow-human-gated.
// The refusal used to print the whole blocker list, so a card with a sentinel
// AND another gate looked like --force had failed to clear the sentinel.
function remainingHeadlessBlockers(blockers, { force = false, automationParked = false, sessionParked = false } = {}) {
  const sentinelWaived = !!(force || automationParked || sessionParked);
  return (blockers || []).filter((b) => b.code !== BLOCKERS.NO_VERIFY_CMD
    && !(b.code === BLOCKERS.PARKED_SENTINEL && sentinelWaived));
}

// BRO-6234: a later comment can say the owner gate does not apply. Explicit
// negation at line start only ("a paused report that says 'this is not an owner
// decision, it is blocked on X'" must not clear it), or a dedicated
// OWNER-CLEARED: line. A later line-start DECISION NEEDED or owner-judgment
// marker re-gates. Comments arrive oldest-first (sortedCommentBodies); the
// newest decisive comment wins. Comment age vs. description edits is not
// known here, so a comment always counts as later than the description.
// BRO-6443: also the two lines the board's own tooling writes: the triage's "Owner gate removed"
// comment and the answer path's "**Owner decision** (answered by the owner ...)" comment. Both left
// the card gated before, because the description still carried the original owner wording.
const OWNER_CLEAR_COMMENT_RE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?(?:not an owner decision\b|OWNER-CLEARED\s*:|owner gate removed by BRO-\d+)/im;
// The answer path writes this once per answered question, so it clears the gate only while no
// DECISION NEEDED line is left in the description (another question may still be open).
const OWNER_ANSWERED_COMMENT_RE = /^[ \t]*(?:\*\*|__)?owner decision(?:\*\*|__)?[ \t]*\(answered by the owner/im;

/** True when the newest decisive comment (oldest-first array) clears the owner gate. */
function commentClearsOwnerGate(comments, description = '') {
  // Any owner wording left in the card (not just a DECISION NEEDED line) means another hold is
  // still open; lines the answer path already rewrote to "ANSWERED by the owner" do not count.
  const live = String(description || '').split('\n').filter((l) => !/^\s*(?:[-*]\s+)?(?:\*\*)?ANSWERED by the owner/i.test(l)).join('\n');
  const stillAsking = !!findDecisionQuestion(description) || OWNER_DECISION_RES.some((re) => re.test(live));
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const body = String(list[i] || '');
    // A comment that both clears and re-asserts an owner pattern stays gated.
    if (OWNER_DECISION_RES.some((re) => re.test(body))) return false;
    if (OWNER_CLEAR_COMMENT_RE.test(body)) return true;
    if (!stillAsking && OWNER_ANSWERED_COMMENT_RE.test(body)) return true;
  }
  return false;
}

// BRO-6357: a card whose visual approval is still waiting on the owner (or approved and
// waiting for the lander) is the owner's, whatever a later comment says. Comments here
// are plain bodies, so the latest-ask filter in classifyStatus is not applied; markers
// from an earlier ask can only make the card look answered, never the reverse.
function visualAskOpen(notes, comments) {
  if (!parseVisualApproval(notes)) return false;
  // Bodies carry no timestamps, so apply classifyStatus's latest-ask cutoff by position (callers pass oldest first).
  const bodies = (comments || []).map((body) => String(body || ''));
  let from = 0;
  bodies.forEach((b, i) => { if (/^Asked the owner to look at/.test(b.trim())) from = i; });
  const state = visualApprovalStatus(notes, bodies.slice(from).map((body) => ({ body })));
  return state === 'waiting' || state === 'approved';
}

function classifyHeadlessDispatchability(card = {}, opts = {}) {
  const subject = String(card.subject || '');
  const notes = String(card.notes != null ? card.notes : (card.description || ''));
  const text = `${subject}\n${notes}`;
  const blockers = [];

  // Checked against `notes`, NOT `text`. `text` is `subject + "\n" + notes`, and
  // the sentinel is only ever written into the DESCRIPTION — matching against
  // `text` would still work under /m but would also let a subject line that
  // merely starts "PARKED:" refuse a card nobody parked.
  if (PARKED_SENTINEL_RE.test(notes)) {
    // BRO-3060: the sentinel doesn't only mean "an owner parked this
    // deliberately" — owner-alert-router.js and digest-autofix.js both park
    // issues THEY file, pending their own drain (scripts/linear-drain-parked.js,
    // digest-autofix.js's own dispatchDetached call). Telling an operator "an
    // owner parked this deliberately" for one of those is false and is why
    // 126 automation-parked issues sat untouched — nobody read past that
    // sentence to check who actually wrote the sentinel.
    const filedByAutofix = hasAutofixFiledMarker(notes);
    const filedByAlertRouter = !filedByAutofix && ALERT_ROUTER_PARKED_RE.test(notes);
    const detail = filedByAutofix
      ? 'description carries the repo\'s PARKED: do-not-dispatch sentinel — parked by digest-autofix, awaiting its own drain (not an owner decision); override with --allow-automation-parked, --force, or --allow-human-gated'
      : filedByAlertRouter
      ? 'description carries the repo\'s PARKED: do-not-dispatch sentinel — parked by owner-alert-router, awaiting linear-drain-parked.js (not an owner decision); override with --allow-automation-parked, --force, or --allow-human-gated'
      : 'description carries the repo\'s PARKED: do-not-dispatch sentinel — an owner parked this deliberately; override with --force (the documented unpark) or --allow-human-gated';
    blockers.push({ code: BLOCKERS.PARKED_SENTINEL, detail });
  }

  // BRO-4868: the NO-DISPATCH marker (notion-brain --no-spawn) means "no
  // dispatcher may launch this card". Only the cloud picker honoured it
  // (BRO-2204); here every dispatcher shares one check. Notes only: like
  // PARKED, a subject line must not carry it.
  if (hasNoDispatchMarker(notes)) {
    blockers.push({
      code: BLOCKERS.NO_DISPATCH_MARKER,
      detail: 'description carries the NO-DISPATCH: marker — the card was filed to not be launched by any dispatcher; override with --allow-human-gated',
    });
  }

  // BRO-6241: UI cards are dispatchable. The worker runs visual QA itself and
  // asks the owner through the decision list (scripts/visual-approval.js), so
  // the old VISUAL_QA_GATE blocker (which parked every UI card) is gone.

  const asyncHit = firstMatch(ASYNC_WAIT_RES, text);
  if (asyncHit) {
    blockers.push({
      code: BLOCKERS.ASYNC_WAIT_GATE,
      detail: `completion is deferred past this session ("${asyncHit}") — nothing resumes a finished headless job`,
    });
  }

  const comments = Array.isArray(card.comments) ? card.comments : [];
  let ownerHit = firstMatch(OWNER_DECISION_RES, text);
  if (ownerHit && comments.length) {
    if (visualAskOpen(notes, comments)) { /* only the owner's tap answers a visual ask */ }
    else if (commentClearsOwnerGate(comments, text)) ownerHit = null;
    else if (OWNER_JUDGMENT_RE.test(ownerHit)) {
      // A newer safe VERIFY supersedes the owner-judgment marker only (the
      // marker says "no command"); it never answers a DECISION NEEDED.
      const ev = evaluateVerifiability(notes, comments);
      const onlyJudgment = OWNER_DECISION_RES.every((re) => re === OWNER_JUDGMENT_RE || !re.test(text));
      if (onlyJudgment && ev.cmd && !ev.ownerJudgment) ownerHit = null;
    }
  }
  if (ownerHit) {
    blockers.push({
      code: BLOCKERS.OWNER_DECISION_GATE,
      detail: `card defers to the owner ("${ownerHit}")`,
    });
  }

  const requireVerify = opts.requireVerifyCmd !== false;
  if (requireVerify) {
    const verifyCmd = opts.verifyCmd !== undefined ? opts.verifyCmd : evaluateVerifiability(notes).cmd;
    if (!verifyCmd) {
      blockers.push({
        code: BLOCKERS.NO_VERIFY_CMD,
        detail: 'no runnable verify command in the acceptance criteria — the nightly recheck would have nothing to re-run',
      });
    }
  }

  return {
    dispatchable: blockers.length === 0,
    blockers,
    reason: blockers.length
      ? blockers.map(b => `${b.code}: ${b.detail}`).join('; ')
      : null,
  };
}

function parseCliArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node scripts/lib/headless-dispatchability.js --subject="..." [--notes="..."]');
    console.log('Exits 0 if an unattended headless session could finish the card, 1 if a human gate blocks it.');
    process.exit(0);
  }
  const result = classifyHeadlessDispatchability({ subject: args.subject, notes: args.notes });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.dispatchable ? 0 : 1);
}

module.exports = {
  commentClearsOwnerGate,
  visualAskOpen,
  BLOCKERS,
  UI_PATH_RE,
  UI_CARD_CLASS_RE,
  isAutomationParked,
  isDrainableSessionParked,
  isWorkerTakeableParkReason,
  hasOnlyWorkerTakeableParks,
  REAL_BLOCK_PARK_RE,
  RISKY_ACTION_PARK_RE,
  OWNER_ONLY_PARK_RE,
  parkReasonAdvisory,
  takeableParkAdvisory,
  OWNER_HOLD_PARK_RE,
  OWNER_ONLY_PARK_RE,
  TECHNICAL_PARK_RE,
  // Exported so a test can assert this array holds the SHARED owner-judgment
  // regex object rather than a fourth handwritten copy (task #1154).
  OWNER_DECISION_RES,
  // Exported for the same reason as OWNER_DECISION_RES above, so the test can
  // assert the /m flag on the SHARED object rather than on a copy. Note the
  // test asserts the flags and, separately, that the regex and the classifier
  // AGREE on a table of inputs — it does not assert object identity, which the
  // classifier's use of a module-scope const already guarantees.
  PARKED_SENTINEL_RE,
  classifyHeadlessDispatchability,
  remainingHeadlessBlockers,
  looksLikeUiPath,
  extractPathTokens,
  uiPathsIn,
};
