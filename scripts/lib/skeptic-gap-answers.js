#!/usr/bin/env node
// scripts/lib/skeptic-gap-answers.js (BRO-7872): every gap the skeptic reviewer lists needs an answer.
//
// The skeptic reviewer (BRO-7839, scripts/lib/skeptic-review-stop.mjs --ship-check) asks the owner's question, "Is this
// fully tested?", and lists material gaps with the check that would prove each one. Real sessions ignored the list: one
// recorded a ship-check pass 23 seconds after 5 gaps were listed, then landed. This module decides, from the transcript
// alone, whether each listed gap got an answer. review-coverage.mjs uses it to refuse `--record` (and the land gate and
// Stop coverage check); session-retro.js uses skepticStats() so the digest can read "0" as passed / never ran / failed.
//
// An answer is one line in the session's own text (chat or closing message), after the skeptic run:
//   GAP <n>: ran <command>                 the command must have run after the first skeptic run of this ship-check,
//                                          succeeded, start a command segment, and name a file the gap's check names
//   GAP <n>: cannot run here: <reason>     a concrete reason (real email, real money, the owner's device); "after the
//                                          next cron run" is not one
//   GAP <n>: not a gap: <reason>           the reviewer is wrong; the next skeptic run judges that
// It forces an answer, not a perfect verdict: whether a run really covered the gap is the reviewer's call on its re-read.
//
// PURE (no fs, no clock, no env reads). Events are walkTranscript() events (scripts/lib/transcript-scan.mjs).
'use strict';

// Reason rule shared with the NO-SKEPTIC bypass in skeptic-review-stop.mjs (one source).
const SCHEDULE_ONLY_REASON_RE = /\b(?:cron|schedul\w*|tomorrow|tonight|overnight|next run|nightly|later)\b/i;
const REAL_COST_REASON_RE = /\b(?:e-?mail|broadcast|subscribers?|send(?:s|ing)?|\$\d|money|paid|spend\w*|cost\w*|credits?|device|phone|owner)\b/i;
const PLACEHOLDER_RE = /<[^>\n]{2,}>|\b(?:todo|tbd)\b/i;
const MIN_REASON = 15;
const MIN_RAN_CMD = 12;

/** PURE. Is this a concrete reason (not empty, not an echoed template, not schedule-only)? */
function concreteReason(reason) {
  const r = String(reason || '').trim();
  if (r.length < MIN_REASON || PLACEHOLDER_RE.test(r)) return false;
  return !SCHEDULE_ONLY_REASON_RE.test(r) || REAL_COST_REASON_RE.test(r);
}

const HEADER_GAPS_RE = /^SKEPTIC REVIEW: (\d+) material gap\(s\)/m;
const HEADER_CLEAN_RE = /^SKEPTIC REVIEW: no material gaps/m;
const UNAVAILABLE_RE = /^SKEPTIC REVIEW UNAVAILABLE\b/m;

/**
 * PURE. Read a `--ship-check` report. The gap count comes from the header, because the output is often piped through
 * `| tail` and the list can be cut. -> { verdict: 'gaps'|'clean'|'unavailable'|'none', count, gaps: [{ n, what, check }] }
 */
function parseSkepticReport(text) {
  const s = String(text || '');
  if (UNAVAILABLE_RE.test(s)) return { verdict: 'unavailable', count: 0, gaps: [] };
  if (HEADER_CLEAN_RE.test(s)) return { verdict: 'clean', count: 0, gaps: [] };
  const h = HEADER_GAPS_RE.exec(s);
  if (!h) return { verdict: 'none', count: 0, gaps: [] };
  const count = Number(h[1]);
  const body = s.slice(h.index).split(/^Minor \(optional\):/m)[0];
  const listed = new Map();
  let cur = null;
  for (const line of body.split('\n')) {
    const item = /^(\d+)\. (.+)$/.exec(line);
    if (item) { cur = { n: Number(item[1]), what: item[2].trim(), check: '' }; listed.set(cur.n, cur); continue; }
    const chk = /^\s+check: (.*)$/.exec(line);
    if (chk && cur) cur.check = chk[1].trim();
  }
  const gaps = [];
  for (let n = 1; n <= count; n++) gaps.push(listed.get(n) || { n, what: '(cut from the output you read; see the full report)', check: '' });
  return { verdict: 'gaps', count, gaps };
}

// Tolerates markdown (`**GAP 1:** ran x`), a list number (`1. GAP 1: ...`) and an em dash separator (ship-check review).
const ANSWER_RE = /^[ \t>*_`-]*(?:\d+[.)][ \t]+)?[*_`]*GAP[ \t]*#?(\d+)[ \t]*[*_]*[ \t]*[:.)\u2014\u2013-][ \t]*[*_]*[ \t]*(.+)$/gim;
const RAN_RE = /^ran\b[ \t]*[:\u2014-]?[ \t]*(.+)$/i;
const CANNOT_RE = /^(?:cannot|can't|can not) run(?: here)?[ \t]*[:—-][ \t]*(.+)$/i;
const NOT_GAP_RE = /^not a gap[ \t]*[:—-][ \t]*(.+)$/i;

const RECORD_CMD_RE = /review-coverage\.mjs\b[^\n]*--record\b/;
const ANSWER_ARG_RE = /--answer[= ](?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
/** PURE. The `--answer=` values of a `review-coverage.mjs --record` command (others: none). */
function answerArgs(cmd) {
  const c = String(cmd || '');
  if (!RECORD_CMD_RE.test(c)) return [];
  return [...c.matchAll(ANSWER_ARG_RE)].map((m) => (m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]));
}

/** PURE. Every `GAP n: ...` line in these texts, last answer per gap wins. -> Map<n, { kind, body, raw }> */
function answerLines(texts) {
  const out = new Map();
  for (const t of texts || []) {
    for (const m of String(t || '').replace(/```[\s\S]*?```/g, '').matchAll(ANSWER_RE)) {
      const rest = m[2].trim();
      let kind = 'invalid'; let body = rest;
      let x;
      if ((x = RAN_RE.exec(rest))) { kind = 'ran'; body = x[1]; }
      else if ((x = CANNOT_RE.exec(rest))) { kind = 'cannot'; body = x[1]; }
      else if ((x = NOT_GAP_RE.exec(rest))) { kind = 'not-a-gap'; body = x[1]; }
      out.set(Number(m[1]), { kind, body: body.trim(), raw: rest });
    }
  }
  return out;
}

const norm = (s) => String(s || '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const PATH_TOKEN_RE = /(?:[\w.-]+\/)*[\w-]+\.(?:m?[jt]sx?|cjs|sh|py|json|ya?ml|sql)\b/g;
/** File basenames a text names (`scripts/lib/x.mjs` -> `x.mjs`). */
function fileNames(text) { return new Set([...String(text || '').matchAll(PATH_TOKEN_RE)].map((m) => m[0].split('/').pop())); }
/** Command segments of a shell command (split on && || ; |), each trimmed, a leading `cd x` dropped. */
function segments(cmd) { return norm(cmd).split(/&&|\|\||;|\|/).map((s) => s.trim()).filter((s) => s && !/^cd\s/.test(s)); }

/**
 * PURE. Does `claimed` name a command that ran? It must start one segment of a successful Bash command after `from`,
 * be at least MIN_RAN_CMD chars, and (when the gap's check names files) name one of those files.
 * -> { ok: true } | { ok: false, why }
 */
// Reading a file is not running its check (ship-check review: `ran cat scripts/x.test.mjs` was accepted).
const READ_ONLY_RE = /^(?:cat|less|more|head|tail|grep|rg|sed|awk|wc|ls|echo|printf|jq|diff|git\s+(?:diff|log|show|status|grep|blame)|node\s+(?:--check|-c)\b|npx\s+tsc)\b/;
// A test run piped through `| tail` exits 0 even when it fails; its output still says so.
const FAILED_OUTPUT_RE = /^# fail [1-9]\d*\s*$|^not ok \d+/m;
/** The command a claim names: the backticked part if it starts with one, without a trailing note, its first non-cd segment. */
function claimedCommand(claimed) {
  const t = String(claimed || '').trim();
  const tick = /^`([^`]+)`/.exec(t);
  const body = (tick ? tick[1] : t).replace(/\s+\([^()]*\)\s*$/, '').replace(/[.,;:]+$/, '');
  return segments(body.replace(/^\$\s*/, ''))[0] || '';
}

function verifyRan(claimed, gap, events, from) {
  const c = claimedCommand(claimed);
  if (c.length < MIN_RAN_CMD) return { ok: false, why: `"${c}" is too short to name a command` };
  if (PLACEHOLDER_RE.test(c)) return { ok: false, why: 'it is the template, not a command' };
  if (READ_ONLY_RE.test(c)) return { ok: false, why: `"${c.slice(0, 40)}" reads a file, it does not run the check` };
  const wanted = fileNames(`${gap.check} ${gap.what}`);
  if (wanted.size && ![...fileNames(c)].some((f) => wanted.has(f))) return { ok: false, why: `the command names none of the files the check names (${[...wanted].slice(0, 3).join(', ')})` };
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash') continue;
    const r = results.get(e.id);
    if (!r || r.isError || FAILED_OUTPUT_RE.test(String(typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')))) continue;
    if (segments(e.input?.command).some((seg) => seg.startsWith(c))) return { ok: true };
  }
  return { ok: false, why: 'no successful command after the skeptic run starts with it (a run whose output shows failing tests does not count)' };
}

/**
 * PURE. Which material gaps of the latest skeptic report have no acceptable answer?
 * @param events walkTranscript events
 * @param firstIdx index of the first skeptic run of this ship-check (commands are credited from here)
 * @param lastIdx index of the latest skeptic run (its list is the one to answer; answers come after it)
 * @param reportText that run's output
 * @param lastMessage the closing message (not yet in the transcript when a Stop hook runs)
 * -> { report, answered: number[], unanswered: [{ n, what, check, why }] }
 */
function evaluateGapAnswers(events, { firstIdx, lastIdx, reportText, lastMessage = '' }) {
  const report = parseSkepticReport(reportText);
  if (report.verdict !== 'gaps') return { report, answered: [], unanswered: [] };
  const texts = [];
  for (const e of events.slice(lastIdx + 1)) {
    if (e.kind === 'assistant_text') texts.push(e.text);
    // Answers passed to `review-coverage.mjs --record --answer='GAP n: ...'`. Chat text can be missing from the session
    // transcript (BRO-7872's own answers never reached it); a tool command always does.
    else if (e.kind === 'assistant_tool_use' && e.name === 'Bash') texts.push(...answerArgs(e.input?.command));
  }
  texts.push(String(lastMessage || ''));
  const answers = answerLines(texts);
  const answered = [];
  const unanswered = [];
  for (const g of report.gaps) {
    const a = answers.get(g.n);
    let why = null;
    if (!a) why = 'no answer';
    else if (a.kind === 'ran') { const v = verifyRan(a.body, g, events, firstIdx); if (!v.ok) why = `"ran" not accepted: ${v.why}`; }
    else if (a.kind === 'cannot' || a.kind === 'not-a-gap') { if (!concreteReason(a.body)) why = `reason not accepted (15+ chars, concrete; a schedule-only reason like "next cron run" is not one): "${a.body.slice(0, 80)}"`; }
    else why = `"${a.raw.slice(0, 60)}" is not one of the three answer forms`;
    if (why) unanswered.push({ ...g, why }); else answered.push(g.n);
  }
  return { report, answered, unanswered };
}

/** PURE. The instruction block shown wherever unanswered gaps stop a pass. */
function answerInstructions(unanswered) {
  return [
    ...unanswered.map((g) => `  - gap ${g.n}: ${g.what.slice(0, 160)}${g.check ? `\n      check: ${g.check.slice(0, 200)}` : ''}\n      (${g.why})`),
    'Answer each one after the skeptic report, as an argument to the record command (chat text can be missing from the transcript):',
    '  node scripts/lib/review-coverage.mjs --record --answer=\'GAP 1: ...\' --answer=\'GAP 2: ...\'',
    'Each answer is one of:',
    '  GAP <n>: ran <the command you ran>             (it must have succeeded and name a file the check names)',
    '  GAP <n>: cannot run here: <concrete reason>    (real email, real money, the owner\'s device; not "next cron run")',
    '  GAP <n>: not a gap: <why the reviewer is wrong>',
  ].join('\n');
}

/**
 * PURE. Skeptic outcomes over a whole session, for the retro row and the digest.
 * isSkepticCall(command) decides what a run is. It is required: pass review-coverage.mjs isSkepticReviewCall, the one
 * matcher the coverage gate uses. A looser text pattern here counted heredocs that only MENTION the reviewer (a test file
 * written with `cat > x <<EOF`) as failed runs: BRO-7872's own session recorded 4 runs / 3 errors for 1 real run.
 * -> { runs, gapsFound, gapsAnswered, errors }
 *    runs = every skeptic --ship-check invocation (errors = those with no verdict); gapsFound = material gaps in the LAST report;
 *    gapsAnswered = how many of those have an accepted answer; errors = UNAVAILABLE reports.
 */
function skepticStats(events, { isSkepticCall, lastMessage = '' } = {}) {
  if (typeof isSkepticCall !== 'function') throw new TypeError('skepticStats: pass isSkepticCall (review-coverage.mjs isSkepticReviewCall)');
  const results = new Map();
  for (const e of events || []) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  let runs = 0; let errors = 0; let first = -1; let last = -1; let lastText = '';
  (events || []).forEach((e, i) => {
    if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash' || !isSkepticCall(String(e.input?.command || ''))) return;
    const r = results.get(e.id);
    const text = r && !r.isError ? String(typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')) : '';
    const v = parseSkepticReport(text).verdict;
    runs++; // every invocation; one that printed no verdict (UNAVAILABLE, crash, cut output) is also an error
    if (v !== 'gaps' && v !== 'clean') { errors++; return; }
    if (first < 0) first = i;
    last = i; lastText = text;
  });
  if (last < 0) return { runs, gapsFound: 0, gapsAnswered: 0, errors };
  const ev = evaluateGapAnswers(events, { firstIdx: first, lastIdx: last, reportText: lastText, lastMessage });
  return { runs, gapsFound: ev.report.count, gapsAnswered: ev.answered.length, errors };
}

module.exports = {
  SCHEDULE_ONLY_REASON_RE, REAL_COST_REASON_RE, concreteReason,
  parseSkepticReport, answerLines, answerArgs, verifyRan, evaluateGapAnswers, answerInstructions, skepticStats,
};
