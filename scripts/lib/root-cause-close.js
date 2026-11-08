/**
 * Close-time root-cause check for fix cards (BRO-7103 item 8, owner request
 * 2026-11-07: "ensure most or all of our work is not just spot fixing").
 *
 * A fix card moving to Done should say, in its close comment or any earlier
 * comment:
 *   ROOT-CAUSE: why the defect was possible at all
 *   CLASS-GUARD: <path> - the test, lint rule, gate or type, in the landed
 *                diff, that catches the whole class (not just this case)
 *   RED-THEN-GREEN: the guard fails with the fix reverted and passes with it
 *   COUSINS: where else the pattern was searched, what was found and fixed
 * or opt out with one line:
 *   NO-ROOT-CAUSE: <reason>   (counted as a spot fix in the digest share)
 *
 * ADVISORY until ROOT_CAUSE_CLOSE_BLOCKING_FROM: linear-done-gate.js adds a
 * warning and never refuses. From that date it refuses, unless
 * ROOT_CAUSE_CLOSE_GATE=advisory (rollback switch, no deploy needed).
 *
 * Fix-card test: a title pattern. Measured on 30 days of titles (2,199
 * cards, 2026-11-08): 38% match; in a 30-title sample about 3 were not fix
 * work and about 5 fix cards were missed. Good enough for an advisory line
 * that a one-line NO-ROOT-CAUSE answers.
 *
 * Everything here is PURE except landedFilesForCard (reads git + the
 * landings ledger, fails soft to null = unknown).
 */
'use strict';

const ROOT_CAUSE_CLOSE_BLOCKING_FROM = '2026-12-22';
const MIN_FIELD_CHARS = 10;

const FIX_RE = /\b(fix(es|ed|ing)?|broken|break(s|ing)?|bug|fail(s|ed|ing|ure|ures)?|wrong|incorrect|missing|errors?|crash(es|ed)?|regress(ion|ed)?|stale|stuck|leak(s|ed)?|not (working|showing|loading|updating|running|firing)|doesn'?t|isn'?t|won'?t|can'?t|never|red|404|500|timed? ?out|flak(y|e)|duplicate[sd]?|mismatch|drift|(under|over)counts?|silently|dropped|blank|ignores|hides|dead|skips|misses|loses)\b/i;
// Titles that start with a build verb are new work even when they name a problem.
const NOT_FIX_RE = /^(add|build|create|new|design|research|explore|plan|draft|write|publish|post|launch|expand|backfill|migrate|document)\b/i;
// Who-filed-it prefixes and priority tags, so "P1: Fix x" reads as "Fix x".
const PREFIX_RE = /^(?:\s*(?:P[0-4]|BSC Daily|Daily digest|Auto-?fix|\[[^\]]{1,40}\])\s*[:\-–]\s*)+/i;

const FIELDS = ['ROOT-CAUSE', 'CLASS-GUARD', 'RED-THEN-GREEN', 'COUSINS'];
const FIELD_RE = /^[ \t>*_-]*(ROOT-CAUSE|CLASS-GUARD|RED-THEN-GREEN|COUSINS|NO-ROOT-CAUSE)[ \t]*:[ \t]*(.*)$/gim;
const PATH_RE = /(?:^|[\s`'"(])((?:\.?[\w@-]+\/)+[\w.@-]+\.[a-z0-9]{1,5})\b/gi;

/** PURE. Is this a fix card (a defect repaired), as opposed to new work? */
function isFixCard({ title } = {}) {
  const t = String(title || '').replace(PREFIX_RE, '').trim();
  if (!t || NOT_FIX_RE.test(t)) return false;
  if (/^root cause: /i.test(t)) return true; // recurrence-detector root cards
  return FIX_RE.test(t);
}

/**
 * PURE. The newest value of each field across the texts (oldest first, the
 * close comment last). Returns { fields: {ROOT-CAUSE: '...', ...}, noRootCause }.
 */
function parseRootCauseBlock(texts) {
  const fields = {};
  let noRootCause = null;
  for (const t of [].concat(texts || [])) {
    for (const m of String(t || '').matchAll(FIELD_RE)) {
      const name = m[1].toUpperCase();
      const val = m[2].trim();
      if (name === 'NO-ROOT-CAUSE') noRootCause = val;
      else fields[name] = val;
    }
  }
  return { fields, noRootCause };
}

/** PURE. Repo-relative file paths named in a CLASS-GUARD value. */
function guardPaths(value) {
  return [...String(value || '').matchAll(PATH_RE)].map((m) => m[1].replace(/^\.\//, ''));
}

/**
 * PURE. Judge a close.
 *   title, texts: card title; description + comments oldest first + close comment
 *   landedFiles:  string[] of files the card's own commits changed, or null (unknown)
 * Returns { applies, ok, kind: 'root-cause'|'spot'|'missing'|null, missing: [], notes: [] }
 */
function checkRootCauseClose({ title, texts, landedFiles = null } = {}) {
  if (!isFixCard({ title })) return { applies: false, ok: true, kind: null, missing: [], notes: [] };
  const { fields, noRootCause } = parseRootCauseBlock(texts);
  if (noRootCause !== null && noRootCause.length >= MIN_FIELD_CHARS) {
    return { applies: true, ok: true, kind: 'spot', missing: [], notes: [] };
  }
  const missing = FIELDS.filter((f) => !(fields[f] && fields[f].length >= MIN_FIELD_CHARS));
  const notes = [];
  if (!missing.includes('CLASS-GUARD')) {
    const paths = guardPaths(fields['CLASS-GUARD']);
    if (!paths.length) {
      missing.push('CLASS-GUARD');
      notes.push('CLASS-GUARD names no file path');
    } else if (Array.isArray(landedFiles) && landedFiles.length) {
      const landed = new Set(landedFiles);
      if (!paths.some((p) => landed.has(p))) {
        missing.push('CLASS-GUARD');
        notes.push(`CLASS-GUARD ${paths.join(', ')} is not in this card's landed diff`);
      }
    } else {
      notes.push('landed diff unknown here, so CLASS-GUARD was not checked against it');
    }
  }
  if (!missing.includes('RED-THEN-GREEN')) {
    const v = fields['RED-THEN-GREEN'];
    if (!(/\b(fail|fails|failed|red)\b/i.test(v) && /\b(pass|passes|passed|green)\b/i.test(v))) {
      missing.push('RED-THEN-GREEN');
      notes.push('RED-THEN-GREEN should say the guard failed without the fix and passed with it');
    }
  }
  return missing.length
    ? { applies: true, ok: false, kind: 'missing', missing, notes }
    : { applies: true, ok: true, kind: 'root-cause', missing: [], notes };
}

/** PURE. Blocking from the date unless the rollback switch says advisory. */
function rootCauseCloseBlocking(nowMs = Date.now(), env = process.env) {
  if (String(env.ROOT_CAUSE_CLOSE_GATE || '').toLowerCase() === 'advisory') return false;
  return nowMs >= Date.parse(`${ROOT_CAUSE_CLOSE_BLOCKING_FROM}T00:00:00Z`);
}

/** PURE. The message a closer sees. */
function rootCauseCloseMessage(identifier, result, blocking) {
  if (!result || !result.applies || result.ok) return null;
  return [
    `${identifier || 'This card'} looks like a fix card but its close does not show the root cause was fixed. Missing: ${result.missing.join(', ')}.`,
    ...result.notes.map((n) => `  - ${n}`),
    '  Add these lines to the close comment (BRO-7103):',
    '    ROOT-CAUSE: why the defect was possible',
    '    CLASS-GUARD: <path> (the test, lint rule, gate or type in this diff that catches the whole class)',
    '    RED-THEN-GREEN: the guard failed with the fix reverted and passed with it',
    '    COUSINS: where else you searched for the pattern, what you found and fixed',
    '  Or one line: NO-ROOT-CAUSE: <reason> (counts as a spot fix).',
    blocking
      ? `  Blocking since ${ROOT_CAUSE_CLOSE_BLOCKING_FROM}. Rollback: ROOT_CAUSE_CLOSE_GATE=advisory.`
      : `  Advisory now; blocking from ${ROOT_CAUSE_CLOSE_BLOCKING_FROM}.`,
  ].join('\n');
}

/**
 * The card's OWN commits (subject names the card), across every landing of
 * it (reverts excluded) plus local HEAD and origin/main. Other cards' commits
 * in the same range (rebases, trains) are left out. Returns
 * { commits: string[], run } or null when git could not be read.
 */
function ownCommitsForCard(identifier, { cwd = process.cwd(), landingsText = null, exec = null } = {}) {
  const { execFileSync } = require('child_process');
  const run = exec || ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 }));
  const sc = require('./stuck-card-closer.js');
  let text = landingsText;
  if (text === null) {
    try { text = require('fs').readFileSync(require('path').join(cwd, 'data/audit/landings.jsonl'), 'utf8'); } catch { text = ''; }
  }
  const shas = sc.parseLandingRows(text)
    .filter((l) => !/revert/i.test(l.branch) && sc.branchIsForCard(l.branch, identifier))
    .map((l) => l.sha);
  const idRe = new RegExp(`(?<![A-Za-z0-9])${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
  for (const sha of shas) {
    try { run(['cat-file', '-e', `${sha}^{commit}`]); } catch {
      try { run(['fetch', '-q', '--depth=30', 'origin', sha]); } catch { /* unreachable sha: skip */ }
    }
  }
  const commits = [];
  for (const tip of [...shas, 'HEAD', 'origin/main']) {
    let log = '';
    try { log = run(['log', '-60', '--format=%H%x09%s', tip]); } catch { continue; }
    for (const line of log.split('\n')) {
      const [h, subj] = line.split('\t');
      if (h && subj && idRe.test(subj) && !/^revert/i.test(subj) && !commits.includes(h)) commits.push(h);
    }
  }
  return { commits, run };
}

/** Files the card's own commits changed: string[], or null when unknown. */
function landedFilesForCard(identifier, opts = {}) {
  try {
    const own = ownCommitsForCard(identifier, opts);
    if (!own || !own.commits.length) return null;
    const files = new Set();
    for (const c of own.commits) {
      for (const f of own.run(['show', '--name-only', '--format=', c]).split('\n')) if (f.trim()) files.add(f.trim());
    }
    return [...files].sort();
  } catch {
    return null;
  }
}

/**
 * The card's own diff, data files left out (they drown the code), capped at
 * maxBytes. { diff, files, truncated } or null when no own commit is found.
 */
function cardDiff(identifier, { maxBytes = 20000, ...opts } = {}) {
  try {
    const own = ownCommitsForCard(identifier, opts);
    if (!own || !own.commits.length) return null;
    const exclude = [':(exclude)data/**', ':(exclude)*.json', ':(exclude)*.jsonl', ':(exclude)package-lock.json'];
    let diff = '';
    const files = new Set();
    for (const c of own.commits) {
      diff += own.run(['show', '--format=commit %h %s', c, '--', '.', ...exclude]);
      for (const f of own.run(['show', '--name-only', '--format=', c]).split('\n')) if (f.trim()) files.add(f.trim());
    }
    // No file-list header: tried 2026-11-08, it flipped the hand-graded spot fix BRO-7066
    // to root-cause (a test file in the list read as a guard). The grader sees the diff alone.
    return { diff: diff.slice(0, maxBytes), files: [...files].sort(), truncated: diff.length > maxBytes };
  } catch {
    return null;
  }
}

// ---------- weekly independent sample (item 9) ----------

// The grader sees the diff only, never the card text: the card says what the
// closer claims, the diff says what landed. Hand-checked 2026-11-08: BRO-7066
// (fixture date bumped) graded spot-fix 0.97, BRO-7098 (safe-check list
// tightened) graded root-cause 0.95.
const GRADER_SYSTEM = 'You grade a software fix by its diff only. root-cause = the change makes the whole class of defect ' +
  'impossible or caught (a guard, a test that would fail for any case of the class, a type, a lint rule, removing the source ' +
  'of the bug). spot-fix = it repairs this one case only (changes a value, patches one call site, edits data, bumps a date). ' +
  'Reply JSON {"grade":"root-cause"|"spot-fix"|"unclear","confidence":0-1,"reason":"one sentence","guard_file":"path or null"}.';

/** PURE. Parse the grader's reply; anything malformed is "unclear". */
function parseGrade(text) {
  try {
    const j = JSON.parse(String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const grade = ['root-cause', 'spot-fix', 'unclear'].includes(j.grade) ? j.grade : 'unclear';
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    return { grade, confidence, reason: String(j.reason || '').slice(0, 300), guardFile: j.guard_file || null };
  } catch {
    return { grade: 'unclear', confidence: 0, reason: 'unparseable grader reply', guardFile: null };
  }
}

/**
 * PURE. Majority of several grades of the same diff. A single grade is not
 * stable (2026-11-08: the same BRO-7066 diff graded spot-fix 0.98 and then
 * root-cause in one run), so each diff is graded GRADE_VOTES times. No
 * majority means "unclear"; votes are kept so a split stays visible.
 */
const GRADE_VOTES = 3;
function majorityGrade(grades) {
  const count = {};
  for (const g of grades) count[g.grade] = (count[g.grade] || 0) + 1;
  const [top, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0] || ['unclear', 0];
  const grade = n * 2 > grades.length ? top : 'unclear';
  const agree = grades.filter((g) => g.grade === grade);
  const confidence = agree.length ? Math.round((agree.reduce((t, g) => t + g.confidence, 0) / agree.length) * 100) / 100 : 0;
  const first = agree[0] || grades[0] || {};
  return { grade, confidence, reason: first.reason || '', guardFile: first.guardFile || null, votes: grades.map((g) => g.grade) };
}

/** PURE. Share of graded cards that fixed the cause (unclear left out). */
function summarizeSample(items) {
  const rootCause = items.filter((i) => i.grade === 'root-cause').length;
  const spot = items.filter((i) => i.grade === 'spot-fix').length;
  const unclear = items.length - rootCause - spot;
  const decided = rootCause + spot;
  return { graded: items.length, rootCause, spot, unclear, share: decided ? Math.round((rootCause / decided) * 1000) / 10 : null };
}

/** PURE. Deterministic pick for a week: same seed, same cards. */
function seededPick(ids, n, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const score = (id) => { let x = h; for (const ch of id) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return x; };
  return [...ids].sort((a, b) => score(a) - score(b)).slice(0, n);
}

module.exports = {
  ROOT_CAUSE_CLOSE_BLOCKING_FROM,
  FIX_RE,
  isFixCard,
  parseRootCauseBlock,
  guardPaths,
  checkRootCauseClose,
  rootCauseCloseBlocking,
  rootCauseCloseMessage,
  ownCommitsForCard,
  landedFilesForCard,
  cardDiff,
  GRADER_SYSTEM,
  parseGrade,
  GRADE_VOTES,
  majorityGrade,
  summarizeSample,
  seededPick,
};
