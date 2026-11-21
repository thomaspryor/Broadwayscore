'use strict';
/**
 * BRO-6635: a paused session report that hands a doable step to "the next session" has to
 * name a real block, or the card sits Paused while the step waits for nobody (BRO-2263,
 * BRO-5436: the owner kept telling sessions to fix digest rows a worker had already scoped).
 * Pure decision function for `linear-session.js report`. Advisory first (CLAUDE.md §19):
 * the CLI warns and tags the comment; PAUSE_GUARD_MODE=block refuses before it posts.
 *
 *   node scripts/lib/pause-report-guard.js --measure [--days=30]
 * classifies the last N days of paused reports from Linear and prints the would-refuse count.
 */
const { stripCode } = require('./decision-card-parse.js');

const GUARDED_STATUSES = new Set(['paused', 'blocked']);

// Wording that hands the work to someone later. "next run" is left out: it is mostly cron
// prose ("should clear on its next run"), not a hand-off.
const HANDOFF_RES = [
  /\bnext[- ](?:session|worker|agent|pass)\b/i,
  // "the next firing" is often cron prose ("can idle the next firing"); count it only as an instruction.
  /\bnext firing(?::|\s+(?:should|must|can|will|needs?|to)\b)/i,
  /\b(?:a|the|another) (?:later|future|follow[- ]?up|fresh|new|separate|dedicated) (?:session|worker|pass)\b/i,
  /\b(?:leave|left|needs?|for) (?:it |this )?(?:for )?another (?:session|worker|pass)\b/i,
  /\bleft for (?:a |the )?(?:[\w-]+ ){0,3}(?:session|worker|pass|run)\b/i,
  /\bneeds? a mac session\b/i,
];

// A sentence that denies a hand-off ("no next session needed") is not one.
// Only the denial phrase is removed, so a hand-off later in the same sentence still counts.
const HANDOFF_DENIAL_RE = /\b(?:no|without|not)\s+(?:an?\s+|any\s+)?(?:next|later|follow[- ]?up|new)[- ](?:session|worker)\b(?:\s+(?:is\s+)?(?:needed|required))?/gi;
// "No access needed", "the 403 is fixed": an access word that is denied names no block.
const ACCESS_DENIAL_RE = /\b(?:no|without)\s+(?:[\w-]+\s+){0,2}(?:access|keys?|tokens?|credentials?)\s+(?:is\s+|was\s+)?(?:needed|required)\b|\b(?:401|402|403|paywall|login)\b[^.;\n]{0,25}\b(?:is |was )?(?:fixed|resolved|gone|cleared)\b/gi;

const BLOCK_RES = {
  // Missing key, token or access the cloud container cannot get.
  access: /\b(?:missing|no|lacks?|without)\s+(?:the\s+|an?\s+)?(?:[\w-]+\s+)?(?:api\s+)?(?:keys?|tokens?|credentials?|secrets?|access)\b|\bkeys?\b.{0,30}\b(?:lack|absent|not set|missing)\b|\b(?:401|402|403)\b|\bpaywall(?:ed)?\b|\bbot[- ]blocked\b|\b(?:behind|needs?|requires?)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+)?log[- ]?in\b|\blog[- ]?in[- ](?:only|wall|required)\b|\bauth(?:entication|orization)?\b|\bnot attached\b|\bnot workable from the cloud lane\b|\brefused from cloud\b/i,
  // Hands or files only the owner's Mac has.
  mac: /\bcookie(?:s|[- ]jar)?\b|\bkeychain\b|\blaunchd\b|\blocal[- ]only\b|~\/\.claude\b|\bonly on the (?:owner's )?mac\b|\bmac[- ]only\b|\bowner's (?:own )?hands\b|\bbrowser login\b|\binteractive(?:ly)? (?:login|log in|sign[- ]in)\b|\babsent here\b/i,
  // Session budget, spend cap, credits or quota; capacity pauses count here.
  spend: /\b(?:paused at|reached|hit|session|spend)\s+budget\b|\bbudget\s+(?:cap|reached|exhausted|hit|approval)\b|\bspend cap\b|\b(?:out of|no)\s+(?:[\w-]+\s+)?credits\b|\bcredits?\s+(?:exhausted|ran out|run out|used up)\b|\bquota\s+(?:exhausted|exceeded|hit|reached|used up)\b|\bover\s+(?:the\s+)?quota\b|\brate[- ]limit(?:ed)?\b|\ballowance\b|\bremaining time\b|\btoo (?:large|big|much) for (?:this|one|a single)\b/i,
};

// A dated wait counts only with wording that says what event it waits on: both refused
// real reports carried a RECHECK-AFTER stamp next to a doable step.
const RECHECK_RE = /\bRECHECK-AFTER:\s*\d{4}-\d{2}-\d{2}\b/;
const WAIT_EVENT_RE = /\b(?:wait(?:s|ing)?\s+(?:on|for|until)|until|once|after|clears? (?:only )?on|only on)\s+(?:the\s+|its\s+|a\s+)?(?:next\s+)?(?:[\w-]+\s+){0,3}(?:run|snapshot|cron|deploy(?:ment)?|opening|press night|reviews?\s+(?:drop|land)|nominations?|announcement)\b/i;

// A land run parked in the queue resumes on its own; re-pushing loses its place (BRO-6015).
const LAND_PARKED_RE = /\bparked in the landing (?:queue|line)\b/i;

function hasOwnerBlock(text) {
  const { namesOwnerHold } = require('./cloud-worker-pick.js');
  return namesOwnerHold(text) || /\bDECISION NEEDED\b|\bowner[- ]judg(?:e)?ment\b/i.test(text);
}

/**
 * @param {{status: string, summary?: string, verification?: string, description?: string}} p
 * @returns {{wouldRefuse: boolean, handoff: string|null, blocks: string[], reason?: string}}
 */
function classifyPauseReport({ status, summary, verification, description } = {}) {
  const none = { wouldRefuse: false, handoff: null, blocks: [] };
  if (process.env.PAUSE_GUARD_DISABLED === '1') return none; // kill switch
  if (!GUARDED_STATUSES.has(status)) return none;
  const raw = [summary, verification].filter(Boolean).join('\n');
  // Hand-offs are read without code spans (quotes of the rule); blocks are read with them,
  // since a backticked ~/.claude path or a cookie-jar command names the block.
  const text = stripCode(raw).join('\n').replace(HANDOFF_DENIAL_RE, '');
  const blockText = raw.replace(ACCESS_DENIAL_RE, '');
  let handoff = null;
  for (const re of HANDOFF_RES) {
    const m = re.exec(text);
    if (m) { handoff = m[0]; break; }
  }
  const blocks = [];
  // The card's own DECISION NEEDED block counts, as in report-owner-question-guard.js.
  if (hasOwnerBlock(blockText) || /\bDECISION NEEDED\b/.test(String(description || ''))) blocks.push('owner');
  for (const [name, re] of Object.entries(BLOCK_RES)) if (re.test(blockText)) blocks.push(name);
  if ((RECHECK_RE.test(blockText) && WAIT_EVENT_RE.test(blockText)) || LAND_PARKED_RE.test(blockText)) blocks.push('wait');
  if (!handoff || blocks.length) return { wouldRefuse: false, handoff, blocks };
  return {
    wouldRefuse: true,
    handoff,
    blocks,
    reason:
      `This paused report hands work on ("${handoff}") without naming a block, so the card waits for a ` +
      'session that is never scheduled. Do the step now, in this session. Pause only for a real block, and name it:\n' +
      '  - an owner decision (a DECISION NEEDED: block)\n' +
      '  - a missing key, token or access the cloud cannot get (say which)\n' +
      '  - Mac-only hands or files: name the thing (cookie jar, keychain, launchd, ~/.claude); "a Mac session" alone is not a block\n' +
      '  - a wait on a dated event (RECHECK-AFTER: YYYY-MM-DD and what it waits on: the next cron run, an opening)\n' +
      '  - the session budget or a spend cap',
  };
}

// Fixed token: the matched phrase stays out, so pause-history parsers never re-read it as a hand-off.
const ADVISORY_MARKER = 'PAUSE-GUARD: advisory would-refuse (handoff)';

async function measure(days) {
  const linear = require('./linear-client.js');
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = await linear.listRecentCommentsContaining({ sinceIso, text: 'Session report (paused)', max: 5000 });
  const seen = new Set();
  const refused = [];
  let total = 0;
  for (const c of rows) {
    const key = `${c.issue && c.issue.identifier}|${c.createdAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;
    const r = classifyPauseReport({ status: 'paused', summary: c.body });
    if (r.wouldRefuse) refused.push({ issue: c.issue && c.issue.identifier, createdAt: c.createdAt, handoff: r.handoff });
  }
  console.log(`Paused reports in the last ${days} days: ${total} (fetched ${rows.length})`);
  console.log(`Would refuse: ${refused.length}`);
  for (const r of refused) console.log(`  ${r.issue} ${r.createdAt.slice(0, 10)}  "${r.handoff}"`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.includes('--measure')) {
    console.error('Usage: node scripts/lib/pause-report-guard.js --measure [--days=30]');
    process.exit(2);
  }
  const daysArg = args.find((a) => a.startsWith('--days='));
  measure(daysArg ? Number(daysArg.slice(7)) || 30 : 30).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { classifyPauseReport, ADVISORY_MARKER, GUARDED_STATUSES, HANDOFF_RES, BLOCK_RES };
