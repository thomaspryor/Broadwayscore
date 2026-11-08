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
 * Files changed by the card's OWN commits (subject names the card), across
 * every landing of it (reverts excluded) plus local HEAD and origin/main.
 * Other cards' commits in the same range (rebases, trains) are left out.
 * Returns string[] or null when nothing could be read.
 */
function landedFilesForCard(identifier, { cwd = process.cwd(), landingsText = null, exec = null } = {}) {
  try {
    const { execFileSync } = require('child_process');
    const run = exec || ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }));
    const sc = require('./stuck-card-closer.js');
    let text = landingsText;
    if (text === null) {
      try { text = require('fs').readFileSync(require('path').join(cwd, 'data/audit/landings.jsonl'), 'utf8'); } catch { text = ''; }
    }
    const shas = sc.parseLandingRows(text)
      .filter((l) => !/revert/i.test(l.branch) && sc.branchIsForCard(l.branch, identifier))
      .map((l) => l.sha);
    const idRe = new RegExp(`(?<![A-Za-z0-9])${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
    const commits = new Set();
    const tips = [...shas];
    for (const sha of shas) {
      try { run(['cat-file', '-e', `${sha}^{commit}`]); } catch {
        try { run(['fetch', '-q', '--depth=30', 'origin', sha]); } catch { /* unreachable sha: skip */ }
      }
    }
    for (const ref of ['HEAD', 'origin/main']) tips.push(ref);
    for (const tip of tips) {
      let log = '';
      try { log = run(['log', '-60', '--format=%H%x09%s', tip]); } catch { continue; }
      for (const line of log.split('\n')) {
        const [h, subj] = line.split('\t');
        if (h && subj && idRe.test(subj) && !/^revert/i.test(subj)) commits.add(h);
      }
    }
    if (!commits.size) return null;
    const files = new Set();
    for (const c of commits) {
      for (const f of run(['show', '--name-only', '--format=', c]).split('\n')) if (f.trim()) files.add(f.trim());
    }
    return [...files].sort();
  } catch {
    return null;
  }
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
  landedFilesForCard,
};
