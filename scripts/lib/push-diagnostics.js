'use strict';
/**
 * Pure helpers for diagnosing the BRO-3213 "90s push transport hang" class:
 * push-with-retry.sh's git_push() times out at GIT_NET_TIMEOUT_SEC (default
 * 90s) with rc=124/137/143 and NO git-printed error, because `timeout` kills
 * the process mid-transport. BRO-2373 added `--progress` to distinguish local
 * pack generation (CPU) from the Writing-objects network phase, but a live
 * measured hang (Opening Night Express run 34694172162, 2026-09-12) showed
 * ZERO bytes of --progress output for the full 90s — ruling out BOTH of those
 * phases (pack generation prints "Enumerating objects" near-instantly; the
 * transfer phase prints byte/throughput progress). The hang is stalling
 * earlier, in the connection/TLS/ref-advertisement round trip, before
 * pack-objects is even invoked. GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1
 * (verified against a real `git fetch` locally, format below) exposes that
 * phase; these two functions redact and classify its output.
 */

// Ported from the shell `_redact_creds()` in push-with-retry.sh so both
// call sites (bash's own stderr capture, and this JS layer for curl-trace
// capture) apply the identical threat model rather than drifting apart, PLUS
// extra passes _redact_creds() doesn't need (adversarial review, BRO-3213):
// GIT_TRACE_CURL dumps arbitrary request/response headers, not just the
// Authorization line _redact_creds() was written for, so Cookie/
// Set-Cookie/Proxy-Authorization and any query-string token/key/secret param
// are stripped too. This is still a denylist, not a formal allowlist parser
// — a genuinely novel credential-bearing header name could still slip
// through — but it covers every credential-carrying mechanism this repo's
// own git config and GitHub's endpoints actually use.
// Verified live: a `git fetch https://x-access-token:TOKEN@github.com/...`
// under GIT_TRACE_CURL leaks the full credential-bearing URL in
// "== Info: [HTTP/2] [N] OPENED stream for <url>" lines — no Authorization
// header is ever sent for this repo's URL-embedded-token auth style, so the
// URL-userinfo pass below is the one that actually fires in practice.
function redactCurlTrace(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/:\/\/[^/@\s]*@/g, '://***@')
    .replace(/(authorization:? *)((?:basic|bearer) +)?[A-Za-z0-9+/=_.-]{8,}/gi, '$1[REDACTED]')
    // Follow-up adversarial review (BRO-3213): the first cut of this pass only
    // matched Title-Case/lower-case header names ([Aa]uthorization etc.) — an
    // ALL-CAPS "AUTHORIZATION:"/"COOKIE:" line (a real curl trace never emits
    // this, but a hostile or unusual client/proxy could) survived untouched.
    // Case-insensitive now; \b (not ^) — real curl trace lines are prefixed
    // with a timestamp + source-file marker before "=> Send header: ", so
    // the header name is never at the actual start of the line (an earlier
    // draft anchored on ^ and silently failed to redact Cookie/Set-Cookie as
    // a result — caught by this file's own test suite before shipping).
    .replace(/\b((?:proxy-)?authorization:|cookie:|set-cookie:)[^\n]*/gi, '$1 [REDACTED]')
    // Substring match on the PARAM NAME (not `[?&]exact=`) — the first cut
    // missed compound names like api_key=, client_secret=, oauth_token=
    // because none of them are an exact "key"/"secret"/"token" match
    // immediately after ? or & (follow-up adversarial review).
    .replace(/([?&][a-z0-9_]*(?:token|key|secret|auth|password)[a-z0-9_]*=)[^&\s]+/gi, '$1[REDACTED]')
    // BRO-3358 (adversarial review, ship-check): a CLI-flag-shaped credential
    // passed as a bare argv to some child TOOL (not a URL, header, or `key=`
    // query param) is a shape none of the passes above cover — e.g. a
    // credential helper invoked as `some-tool --password SECRET`. Only
    // matches a LONG flag whose own NAME contains a credential keyword
    // (mirrors the query-param pass's substring-on-name approach), not bare
    // short flags like `-p`, which are too ambiguous with legitimate options
    // (port, path, ...) to redact on sight.
    .replace(/(--[a-z-]*(?:password|token|secret|api[-_]?key)[a-z-]*)([ =])(?!\[REDACTED\])\S+/gi, '$1$2[REDACTED]');
}

// Ordered, monotonically-increasing checkpoints a SINGLE git-over-HTTP
// request/response cycle passes through, from GIT_TRACE_CURL's own output —
// confirmed against a real captured trace (see file header).
const STAGES = [
  { name: 'pre-connect', test: /Trying \S+\.\.\.|was resolved\.$/m },
  { name: 'connect-tls', test: /Connected to \S+|SSL connection using|ALPN: server accepted/ },
  { name: 'sending-request', test: /=> Send header/ },
  { name: 'request-sent-awaiting-response', test: /Request completely sent off|upload completely sent off/ },
  { name: 'response-received-then-stalled', test: /<= Recv header: HTTP\// },
];

// A git push is (at least) TWO sequential HTTP exchanges over the same
// connection — an info/refs GET, then a git-receive-pack POST (verified
// live: both start with their own "=> Send header, N bytes (...)" byte-count
// line). Naively scanning the WHOLE trace for the furthest-reached marker
// (the first cut of this classifier) meant a completed first exchange's
// "<= Recv header: HTTP/" permanently forced response-received-then-stalled
// even when the SECOND exchange was the one that actually hung mid-connect
// — confidently wrong (adversarial review, BRO-3213). Splitting on this
// marker and classifying only the LAST segment fixes it.
const REQUEST_BOUNDARY = /^.*=> Send header, \d+ bytes.*$/m;

/**
 * @param {string} traceText GIT_TRACE_CURL_NO_DATA=1 output captured from a
 *   single push attempt (redacted or raw — caller's choice, this function
 *   only classifies, it never echoes its input).
 * @returns {string} one of: 'no-trace' | 'pre-connect' | 'connect-tls' |
 *   'sending-request' | 'request-sent-awaiting-response' |
 *   'response-received-then-stalled' | 'unrecognized'
 */
function classifyStallPhase(traceText) {
  if (typeof traceText !== 'string' || !traceText.trim()) return 'no-trace';

  // Isolate the LAST request cycle: everything from the last "=> Send
  // header, N bytes" line onward. A trace with no such line yet (killed
  // before any request was ever sent) has nothing to split — classify the
  // whole thing.
  const boundaries = traceText.match(new RegExp(REQUEST_BOUNDARY, 'gm'));
  let segment = traceText;
  if (boundaries && boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const idx = traceText.lastIndexOf(lastBoundary);
    segment = traceText.slice(idx);
  }

  let reached = null;
  for (const stage of STAGES) {
    if (stage.test.test(segment)) reached = stage.name;
  }
  // A non-empty trace that matched NONE of the known markers is a format we
  // don't recognize (different git/curl version, HTTP/1.1 wording, a
  // protocol this classifier was never taught) — NOT evidence the stall is
  // in the earliest phase. Conflating "unrecognized" with "pre-connect"
  // would assert a specific, unearned diagnosis (adversarial review,
  // BRO-3213).
  return reached || 'unrecognized';
}

// ---------------------------------------------------------------------------
// BRO-2839: classifyStallPhase above answers "how far did the LAST exchange
// get", which is all BRO-3213 needed. It cannot answer the question this card
// was filed for — WHERE the 90 seconds go — for a structural reason:
//
//   Measured on CI run 34852355418 (Process Feedback Submissions, 2026-09-14,
//   GIT_NET_TIMEOUT_SEC=30): the trace's LAST line is stamped 13:58:34.383856,
//   ~1.7s into an attempt that was killed at 13:59:02.69. The remaining ~28s
//   produced NO trace output at all. The stall is therefore not "inside" any
//   logged phase — it is the silence AFTER the last logged line, and a
//   classifier that only reports the furthest marker reached can never say so.
//   It will always answer "response-received-then-stalled", which is exactly
//   what 100% of ledger rows since 2026-09-13 say.
//
// So the terminal silence has to be a first-class interval, which means the
// extractor needs to know when the process was killed. That kill time is
// passed on the SAME clock as the trace's own lines (a wall-clock
// HH:MM:SS.frac stamp taken right after the timeout wrapper returns), NOT as
// an elapsed-since-fork duration: git writes its first trace line only once it
// starts connecting, so an elapsed measurement silently folds process startup
// into the first gap and puts the two endpoints in different coordinate
// systems (second-opinion review finding, BRO-2839).

// One trace line: "13:58:34.383790 http.c:941              <= Recv header, ..."
const TRACE_LINE_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+\S+\s+(.*)$/;

// Which git service an exchange belongs to. A push is receive-pack; a fetch is
// upload-pack. Both the request line (?service=git-receive-pack, or the
// /git-receive-pack POST path) and the response content-type carry it.
const SERVICE_RE = /(?:service=git-|\/git-|x-git-)(receive-pack|upload-pack)/;

const MS_PER_DAY = 86400000;

function parseTraceClock(stamp) {
  if (typeof stamp !== 'string') return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d+)$/.exec(stamp.trim());
  if (!m) return null;
  return clockToMs(m[1], m[2], m[3], m[4]);
}

function clockToMs(hh, mm, ss, frac) {
  // GIT_TRACE_CURL prints microseconds; `date +%H:%M:%S.%N` prints nanoseconds.
  // Normalize whatever precision we get to milliseconds rather than assuming.
  const fractionMs = Number(`0.${frac}`) * 1000;
  return (
    Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + fractionMs
  );
}

// The longest interval this module can legitimately be measuring is one push
// attempt, bounded by GIT_NET_TIMEOUT_SEC (90s by default, and callers set it
// lower). An hour is therefore an enormously generous ceiling on a real gap.
const MAX_PLAUSIBLE_GAP_MS = 3600000;

// Trace timestamps carry no date, so a run that crosses midnight produces a
// smaller "later" value and needs a day added.
//
// But NOT every backwards step is a midnight wrap, and treating them alike is
// actively dangerous here: a kill timestamp even a few milliseconds behind the
// last trace line (ordinary clock jitter, or NTP nudging the clock during the
// attempt) would wrap to ~86400000ms and be reported as "86400.0s of silence"
// — a fabricated 24-hour answer stated with total confidence. That is the
// exact failure mode this card exists to stop, so the two cases are
// distinguished by magnitude: a real wrap leaves a SMALL forward remainder
// (23:59:59 -> 00:00:29 is 30s), while jitter leaves a remainder just under a
// full day. Anything still implausible after wrapping is reported as 0 rather
// than guessed at.
// The clamp is SYMMETRIC. Bounding only the backwards case would leave the
// mirror-image hole open: a forward clock step, or a corrupt killedAt two
// hours ahead, yields "7200.0s of silence" from a 90s-bounded operation —
// stated with exactly the confidence the backwards clamp exists to prevent.
// Both directions are implausible inputs and both report 0 rather than a
// number a reader would act on (post-ship-check review finding).
// Returns null — NOT 0 — when the interval is implausible, because the two
// cases must stay distinguishable downstream. Collapsing them to 0 would make
// a trace with unusable timestamps render as "0.0s — SILENCE AFTER last trace
// line", i.e. "the push didn't stall", which is a confidently-wrong answer of
// exactly the family this card exists to eliminate (adversarial review of the
// clamp itself). Callers mark such gaps `implausible` and say so in the output.
function forwardDelta(fromMs, toMs) {
  const d = toMs - fromMs;
  // A genuine midnight wrap in a GIT_NET_TIMEOUT_SEC-bounded operation leaves a
  // SMALL forward remainder (23:59:59 -> 00:00:29 is 30s). A wrapped value past
  // the ceiling would mean the push ran over an hour, which it cannot.
  const candidate = d >= 0 ? d : d + MS_PER_DAY;
  return candidate >= 0 && candidate <= MAX_PLAUSIBLE_GAP_MS ? candidate : null;
}

/**
 * Split a trace into timestamped records, each tagged with the phase and git
 * service in effect at that point. Lines without a timestamp (a 2000-byte tail
 * that begins mid-line, blank lines) are skipped rather than guessed at.
 *
 * @param {string} traceText raw or redacted GIT_TRACE_CURL output
 * @returns {Array<{tsMs:number, stamp:string, phase:string, service:string, detail:string}>}
 */
function parseTraceRecords(traceText) {
  if (typeof traceText !== 'string' || !traceText) return [];
  // A trace killed by SIGTERM mid-write ends in a partial, newline-less line.
  // It is NOT dropped: the timestamp is written at the START of the line, so a
  // line truncated mid-message still carries a fully-valid timestamp, and that
  // is the single most useful record in a killed trace — it is the last thing
  // git did before the silence. TRACE_LINE_RE is the arbiter: a line cut
  // before its timestamp completes simply fails to match and is skipped, so
  // there is no bogus-record risk to protect against by discarding it.
  const lines = traceText.split('\n');

  const records = [];
  let phase = 'pre-connect';
  let service = 'unknown';
  let sawAnyPhase = false;

  for (const line of lines) {
    const m = TRACE_LINE_RE.exec(line);
    if (!m) continue;
    const [, hh, mm, ss, frac, detail] = m;

    // A new request cycle starts here. Reset the service so the next request
    // line re-derives it instead of inheriting the PREVIOUS exchange's value:
    // a push's trace can contain more than one exchange, and carrying a stale
    // marker forward would let one exchange's service be reported for another
    // — which is precisely the misattribution `attributedToPush` exists to
    // prevent. (Phase needs no explicit reset: this same line matches the
    // 'sending-request' marker below and so resets it naturally.)
    if (/=> Send header, \d+ bytes/.test(detail)) service = 'unknown';

    const svc = SERVICE_RE.exec(detail);
    if (svc) service = svc[1];

    for (const stage of STAGES) {
      if (stage.test.test(detail)) {
        phase = stage.name;
        sawAnyPhase = true;
      }
    }

    records.push({
      tsMs: clockToMs(hh, mm, ss, frac),
      stamp: `${hh}:${mm}:${ss}.${frac}`,
      phase: sawAnyPhase ? phase : 'unrecognized',
      service,
      detail,
    });
  }
  return records;
}

/**
 * Which git service the LAST exchange in the trace belongs to — reported
 * separately from the phase so a non-push exchange can never be silently
 * presented as the push's own stall (second-opinion review, BRO-2839). Uses
 * the same last-request-cycle isolation as classifyStallPhase so both describe
 * the same exchange.
 *
 * @returns {'receive-pack'|'upload-pack'|'unknown'}
 */
function classifyStallService(traceText) {
  if (typeof traceText !== 'string' || !traceText.trim()) return 'unknown';
  const records = parseTraceRecords(traceText);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].service !== 'unknown') return records[i].service;
  }
  // Fallback for a TRUNCATED capture. git_push_traced logs only the trace's
  // last 2000 bytes, which routinely begins mid-line — and the service marker
  // (a content-type header) is often on exactly that headless first line, so
  // it carries no timestamp and never becomes a record. Scanning the raw text
  // recovers it. Last match wins, matching the last-exchange rule above.
  let found = 'unknown';
  const re = new RegExp(SERVICE_RE, 'g');
  let m;
  while ((m = re.exec(traceText)) !== null) found = m[1];
  return found;
}

/**
 * Whole-file provenance census. classifyStallPhase reads the entire trace but
 * git_push_traced only ever LOGGED its last 2000 bytes, so a CI failure could
 * be inspected only through a keyhole: the two runs that prompted this card
 * showed nothing but upload-pack response headers, and there was no way to
 * tell whether receive-pack traffic existed earlier in the same file or not.
 * This reports the whole file's shape in a handful of lines so the next real
 * failure answers that directly instead of by inference.
 *
 * @returns {{bytes:number, records:number, receivePack:number, uploadPack:number,
 *            firstStamp:(string|null), lastStamp:(string|null), requests:string[]}}
 */
function censusTrace(traceText) {
  const text = typeof traceText === 'string' ? traceText : '';
  const records = parseTraceRecords(text);
  const requests = [];
  let receivePack = 0;
  let uploadPack = 0;

  for (const r of records) {
    const req = /=> Send header: ((?:GET|POST|PUT|HEAD) \S+)/.exec(r.detail);
    if (!req) continue;
    // Redact before collecting, not after. These strings go straight into CI
    // logs via the census line, bypassing redact-tail entirely — and this repo
    // pushes to data repos over URLs carrying an embedded access token, so a
    // request line is exactly the shape that can leak one. Defense in depth on
    // a credential path costs one call.
    requests.push(redactCurlTrace(req[1]));
    // One count per actual request line, so the totals mean "exchanges" and
    // stay equal to requests.length — not "lines mentioning a service", which
    // double-counts the byte-count line that precedes every request.
    if (r.service === 'receive-pack') receivePack++;
    else if (r.service === 'upload-pack') uploadPack++;
  }

  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    records: records.length,
    receivePack,
    uploadPack,
    firstStamp: records.length ? records[0].stamp : null,
    lastStamp: records.length ? records[records.length - 1].stamp : null,
    requests,
  };
}

/**
 * Break a stalled push's lifetime into named sub-phases and name the one that
 * actually consumed the time.
 *
 * The interval from the last trace record to the kill is a first-class
 * candidate — see the block comment above; without it the largest gap in a
 * real CI failure is the ~1s connect round trip and the 28s of silence that
 * actually killed the job is invisible.
 *
 * @param {object} opts
 * @param {string} opts.traceText GIT_TRACE_CURL output for ONE attempt.
 * @param {string} [opts.killedAt] wall clock "HH:MM:SS.frac" captured right
 *   after the timeout wrapper returned — same clock as the trace's own lines.
 * @param {number} [opts.elapsedMs] fallback when no killedAt is available;
 *   less precise (see block comment) but better than no terminal interval.
 * @returns {{records:number, gaps:Array, dominantGap:(object|null),
 *            service:string, attributedToPush:boolean, reason:(string|undefined)}}
 */
function extractPhaseTimeline({ traceText, killedAt, elapsedMs } = {}) {
  const records = parseTraceRecords(traceText);
  const service = classifyStallService(traceText);
  const base = {
    records: records.length,
    gaps: [],
    dominantGap: null,
    service,
    // The ONLY service a `git push` can produce is receive-pack (verified
    // locally against this repo's origin from both a full and a depth-1
    // shallow clone: every push trace contains receive-pack exchanges and zero
    // upload-pack lines). Anything else in a file that wrapped only a push is
    // unexplained, and must not be reported as the push's own stall.
    attributedToPush: service === 'receive-pack',
  };

  if (records.length === 0) {
    return { ...base, reason: 'no-trace' };
  }

  // An implausible interval keeps ms=0 for shape compatibility but is FLAGGED,
  // so "we measured no gap" and "we could not measure this gap" stay distinct.
  const mkGap = (raw, rest) => ({ ...rest, ms: raw === null ? 0 : raw, implausible: raw === null });

  const gaps = [];
  for (let i = 1; i < records.length; i++) {
    gaps.push(mkGap(forwardDelta(records[i - 1].tsMs, records[i].tsMs), {
      phase: records[i - 1].phase,
      service: records[i - 1].service,
      from: records[i - 1].stamp,
      to: records[i].stamp,
      terminal: false,
    }));
  }

  const last = records[records.length - 1];
  // On a truncated tail the timestamped records may carry no service marker at
  // all while the raw text does (see classifyStallService's fallback) — prefer
  // the resolved one so the terminal gap isn't labelled less precisely than
  // the timeline it belongs to.
  const lastService = last.service !== 'unknown' ? last.service : service;
  const killMs = parseTraceClock(killedAt);
  if (killMs !== null) {
    gaps.push(mkGap(forwardDelta(last.tsMs, killMs), {
      phase: last.phase,
      service: lastService,
      from: last.stamp,
      to: killedAt.trim(),
      terminal: true,
    }));
  } else if (Number.isFinite(elapsedMs) && elapsedMs > 0 && records.length > 0) {
    // Fallback: approximate the kill point as first-record + elapsed. Marked
    // approximate so a reader never mistakes it for a measured stamp.
    gaps.push(mkGap(forwardDelta(last.tsMs, records[0].tsMs + elapsedMs), {
      phase: last.phase,
      service: lastService,
      from: last.stamp,
      to: null,
      terminal: true,
      approximate: true,
    }));
  }

  // Rank only gaps we could actually measure. If every gap is implausible the
  // honest answer is "the timestamps are unusable", never "the largest gap was
  // 0.0s" — which a reader would take as "it did not stall".
  const measurable = gaps.filter((g) => !g.implausible);
  let dominantGap = null;
  for (const g of measurable) {
    if (!dominantGap || g.ms > dominantGap.ms) dominantGap = g;
  }
  if (!dominantGap && gaps.length > 0) {
    return { ...base, gaps, dominantGap: null, reason: 'timestamps-implausible' };
  }

  return { ...base, gaps, dominantGap };
}

/** One-line human summary of a timeline, for the CI log. */
function formatTimeline(timeline) {
  if (timeline && timeline.reason === 'timestamps-implausible') {
    // Distinct from both "no trace" and "0.0s of silence". Every interval in
    // this trace was outside any plausible range, so the honest report is that
    // the time CANNOT be located — not a number that reads as "it never
    // stalled" (adversarial review of the clamp).
    return `cannot locate the time — every interval in this trace is implausible (clock skew or corrupt timestamps); records=${timeline.records}`;
  }
  if (!timeline || !timeline.dominantGap) {
    return `no-timeline (records=${timeline ? timeline.records : 0})`;
  }
  const g = timeline.dominantGap;
  const secs = (g.ms / 1000).toFixed(1);
  const where = g.terminal
    ? `SILENCE AFTER last trace line (no further network activity${g.approximate ? ', approximate' : ''})`
    : 'between trace lines';
  // Only warn on a service we POSITIVELY identified as something other than
  // receive-pack. "unknown" means the marker was absent from the captured
  // range — most often because the capture is a truncated tail — NOT that the
  // exchange belonged to something else. Asserting the latter from the former
  // would be exactly the unearned diagnosis classifyStallPhase's own comment
  // warns about for unrecognized-vs-pre-connect, and "unknown" is the common
  // case, not the edge (stall-diagnostics.test.sh's real fixture hits it).
  const attribution =
    timeline.attributedToPush || timeline.service === 'unknown'
      ? ''
      : ` [service=${timeline.service} — NOT receive-pack, so this exchange is NOT the push's own and must not be reported as its stall]`;
  // PARTIAL implausibility. If the winning gap is an inter-record one while the
  // TERMINAL interval was unmeasurable, the number above is real but is not the
  // answer to "where did the timeout go" — the interval that consumed it is the
  // one we could not measure. Reporting "2.0s between trace lines" and stopping
  // there would read as "the push barely paused", which is the same
  // confidently-wrong shape this card exists to remove, just narrower
  // (adversarial review: the fix stopped one step short of its own goal).
  const terminalUnmeasurable =
    !g.terminal && (timeline.gaps || []).some((x) => x.terminal && x.implausible);
  const caveat = terminalUnmeasurable
    ? ' — NOTE: the terminal interval (last trace line -> kill) was IMPLAUSIBLE and could not be measured, so the time that actually consumed the timeout is NOT located by this number'
    : '';
  return `${secs}s in phase "${g.phase}" — ${where}${attribution}${caveat}`;
}

// ---------------------------------------------------------------------------
// BRO-3358: GIT_TRACE2_PERF diagnostics — extractPhaseTimeline above answers
// "how far did the CONNECT phase get" from GIT_TRACE_CURL, but GIT_TRACE_CURL
// is a WIRE trace: it logs handshake/header lines only, so it has nothing to
// say about what git itself is doing BETWEEN them — e.g. a blocking
// credential-helper child process. GIT_TRACE_PERFORMANCE (the more
// obvious-looking instrument) is worse than useless here: it logs a region
// only on LEAVE, so the one phase still running when a 90s kill hits is
// precisely the phase that NEVER PRINTS (verified: GIT_TRACE_PERFORMANCE=1 +
// a 3s kill on a real push produced rc=124 and ZERO performance lines, while
// GIT_TRACE2_PERF on the identical command produced 36 lines including
// region_enter/child_start naming the in-flight work). GIT_TRACE2_PERF logs
// child_start as it HAPPENS, so a child process still running at kill time
// shows up as a child_start with no matching child_exit — exactly the shape
// needed to test the credential-helper hypothesis (see push-with-retry.sh's
// PUSH_TRACE2_DIAGNOSTICS comment for the concrete lead this exists to
// chase).
//
// Line format verified against a real local capture (`GIT_TRACE2_PERF=1 git
// ls-remote https://...`): "HH:MM:SS.ffffff file:line | dN | thread | event |
// repo | t_abs | t_rel | category | data". Unlike GIT_TRACE_CURL, git's own
// trace2 output already redacts URL userinfo NATIVELY (prints "<REDACTED>"
// inline, verified live against a fake embedded token) and trace2 never logs
// HTTP headers/cookies/bodies the way GIT_TRACE_CURL does — the credential-
// leak surface here is structurally much smaller. Callers still route
// everything through redactCurlTrace's denylist as defense-in-depth (its
// patterns are generic string matches, not curl-specific) via the redactTrace2
// export below. This remains a denylist, not a formal allowlist parser — a
// credential passed as a bare positional argv to some OTHER child tool (not a
// URL, header, or key=value query param) would not be caught by either.
//
// These functions reuse clockToMs()/forwardDelta() directly (declared above,
// same file) rather than re-deriving HH:MM:SS.frac math — that math has three
// rounds of adversarial-review bug fixes baked into it (symmetric clamp,
// null-not-0, midnight-wrap-vs-jitter distinction) and a second copy would
// risk silently reintroducing a fixed bug.
const TRACE2_LINE_RE =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+\S+\s*\|\s*d(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

/**
 * @param {string} traceText raw or redacted GIT_TRACE2_PERF output
 * @returns {Array<{tsMs:number, stamp:string, depth:number, thread:string,
 *   event:string, tAbs:string, tRel:string, category:string, data:string}>}
 */
function parseTrace2Records(traceText) {
  if (typeof traceText !== 'string' || !traceText) return [];
  const records = [];
  for (const line of traceText.split('\n')) {
    const m = TRACE2_LINE_RE.exec(line);
    if (!m) continue;
    const [, hh, mm, ss, frac, depth, thread, event, , tAbs, tRel, category, data] = m;
    records.push({
      tsMs: clockToMs(hh, mm, ss, frac),
      stamp: `${hh}:${mm}:${ss}.${frac}`,
      depth: Number(depth),
      thread: thread.trim(),
      event: event.trim(),
      tAbs: tAbs.trim(),
      tRel: tRel.trim(),
      category: category.trim(),
      data: data.trim(),
    });
  }
  return records;
}

// A trace2 child is identified by its [chN] marker, scoped to the DEPTH it
// was started at — child ids are only unique within one process's own
// children, so a bare [ch0] legitimately recurs at multiple depths for
// unrelated children (verified in a live capture where d1 and d2 each had
// their own [ch0]).
const CHILD_ID_RE = /\[ch(\d+)\]/;

/**
 * Pairs child_start/child_exit trace2 records to answer "was any child
 * process still running when the capture stopped" — the signal that tells us
 * whether a blocking credential helper (or anything else) was in flight at
 * kill time. A child_start with NO matching child_exit anywhere in the file
 * is flagged inFlightAtEnd: true.
 *
 * @param {string} traceText
 * @returns {Array<{id:string, depth:number, argv:string, startMs:number,
 *   durationMs:(number|null), inFlightAtEnd:boolean}>}
 */
function summarizeTrace2Children(traceText) {
  const records = parseTrace2Records(traceText);
  const started = new Map(); // key: `${depth}:${chId}` -> entry
  const children = [];
  for (const r of records) {
    const m = CHILD_ID_RE.exec(r.data);
    if (!m) continue;
    const key = `${r.depth}:${m[1]}`;
    if (r.event === 'child_start') {
      const entry = {
        id: `ch${m[1]}`,
        depth: r.depth,
        argv: r.data,
        startMs: r.tsMs,
        durationMs: null,
        inFlightAtEnd: true,
      };
      started.set(key, entry);
      children.push(entry);
    } else if (r.event === 'child_exit') {
      const entry = started.get(key);
      if (!entry) continue;
      // Prefer trace2's OWN t_rel column (git's authoritative elapsed time
      // for the child, printed on its exit line) over re-deriving it from
      // two tsMs values — one fewer place for the day-wrap edge case to bite.
      const tRelSec = parseFloat(r.tRel);
      entry.durationMs = Number.isFinite(tRelSec)
        ? Math.round(tRelSec * 1000)
        : r.tsMs - entry.startMs;
      entry.inFlightAtEnd = false;
    }
  }
  return children;
}

/**
 * Same "terminal silence dominates" model as extractPhaseTimeline above (see
 * its header comment for why the interval from the last trace line to the
 * kill must be a first-class candidate), generalized to trace2 records:
 * trace2 has no fixed HTTP-phase vocabulary, so every record boundary is a
 * candidate gap, and the terminal gap's "phase" is just the last event's own
 * name + data rather than a curl-stage label.
 *
 * @param {object} opts
 * @param {string} opts.traceText GIT_TRACE2_PERF output for ONE attempt.
 * @param {string} [opts.killedAt] wall clock "HH:MM:SS.frac" — the SAME kill
 *   timestamp already captured for the curl trace (git_push_traced() takes
 *   exactly one `date` call per attempt and passes it to both diagnostics, so
 *   they can never disagree about when the process died).
 * @returns {{records:number, gaps:Array, dominantGap:(object|null), reason:(string|undefined)}}
 */
function extractTrace2Timeline({ traceText, killedAt } = {}) {
  const records = parseTrace2Records(traceText);
  if (records.length === 0) {
    return { records: 0, gaps: [], dominantGap: null, reason: 'no-trace' };
  }

  const mkGap = (raw, rest) => ({ ...rest, ms: raw === null ? 0 : raw, implausible: raw === null });
  const gaps = [];
  for (let i = 1; i < records.length; i++) {
    gaps.push(mkGap(forwardDelta(records[i - 1].tsMs, records[i].tsMs), {
      event: records[i - 1].event,
      data: records[i - 1].data,
      from: records[i - 1].stamp,
      to: records[i].stamp,
      terminal: false,
    }));
  }

  const last = records[records.length - 1];
  const killMs = parseTraceClock(killedAt);
  if (killMs !== null) {
    gaps.push(mkGap(forwardDelta(last.tsMs, killMs), {
      event: last.event,
      data: last.data,
      from: last.stamp,
      to: killedAt.trim(),
      terminal: true,
    }));
  }

  const measurable = gaps.filter((g) => !g.implausible);
  let dominantGap = null;
  for (const g of measurable) {
    if (!dominantGap || g.ms > dominantGap.ms) dominantGap = g;
  }
  if (!dominantGap && gaps.length > 0) {
    return { records: records.length, gaps, dominantGap: null, reason: 'timestamps-implausible' };
  }
  return { records: records.length, gaps, dominantGap };
}

/** One-line human summary of a trace2 timeline + child census, for the CI log. */
function formatTrace2Timeline(timeline, children) {
  if (timeline && timeline.reason === 'timestamps-implausible') {
    return `cannot locate the time — every interval in this trace2 capture is implausible (clock skew or corrupt timestamps); records=${timeline.records}`;
  }
  if (!timeline || !timeline.dominantGap) {
    return `no-timeline (records=${timeline ? timeline.records : 0})`;
  }
  const g = timeline.dominantGap;
  const secs = (g.ms / 1000).toFixed(1);
  const where = g.terminal
    ? `SILENCE AFTER last trace2 line (last event: "${g.event}" — ${g.data})`
    : `between trace2 lines (last event: "${g.event}")`;
  // "NO child_exit OBSERVED", not "still running" — a child that exited a
  // moment before the kill but whose child_exit line landed just past a
  // truncated capture would look identical to one genuinely still running.
  // Overclaiming certainty here would be the same failure mode
  // formatTimeline's "unrecognized vs pre-connect" comment already warns
  // against for the curl trace (adversarial review, BRO-3358 ship-check).
  const inFlight = (children || []).filter((c) => c.inFlightAtEnd);
  const inFlightNote = inFlight.length
    ? ` — NO child_exit OBSERVED FOR: ${inFlight.map((c) => c.argv).join('; ')}`
    : '';
  return `${secs}s ${where}${inFlightNote}`;
}

module.exports = {
  redactCurlTrace,
  classifyStallPhase,
  classifyStallService,
  censusTrace,
  extractPhaseTimeline,
  formatTimeline,
  parseTraceRecords,
  parseTraceClock,
  // BRO-3358 (GIT_TRACE2_PERF)
  redactTrace2: redactCurlTrace,
  parseTrace2Records,
  summarizeTrace2Children,
  extractTrace2Timeline,
  formatTrace2Timeline,
};
