'use strict';
/**
 * Pure helpers for scripts/sweep-notion-migrated-duplicates.js (BRO-3576).
 *
 * Cards migrated from the Notion brain were copied from a point-in-time
 * snapshot, so some describe work that had already shipped under the old
 * Notion task number or an unrelated commit (BRO-2153, BRO-2352). These
 * helpers turn one card plus the main-branch commit history into evidence
 * that the card may already be done. They only FLAG: a false-positive close
 * is worse than a stale card, so nothing here closes anything.
 */

// Two migration formats exist: "[notion:<uuid>]" and
// "*Migrated from Notion — page *`<uuid>`" (BRO-2153 uses the second).
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const NOTION_ID_RES = [
  new RegExp(`\\[notion:${UUID}\\]`, 'i'),
  new RegExp(`Migrated from Notion[^\\n]*?${UUID}`, 'i'),
];
const MIGRATION_MARKERS = ['[notion:', 'Migrated from Notion'];

// Words that say nothing about WHAT a card is about.
const STOPWORDS = new Set((
  'a an the and or but of to in on for with from by at as is are was were be been it its this that these those '
  + 'into onto not no yes do does did done fix fixes fixed add adds added make makes use uses used via per when '
  + 'then than after before so if all any each every new old more less should must can could would will now '
  + 'p0 p1 p2 p3 bro task card script scripts lib test tests js mjs ts tsx json md yml'
).split(' '));

function extractNotionId(description) {
  for (const re of NOTION_ID_RES) {
    const m = re.exec(String(description || ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Old pre-Linear task numbers the card names ("#1709", "task #1184"). */
function extractTaskNumbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[^\w&/])#(\d{3,4})\b/g)) out.add(m[1]);
  return [...out];
}

/**
 * Repo-relative paths named in the card, e.g. scripts/lib/show-images.js.
 * Only top-level dirs that exist in this repo count, so URLs and prose
 * fragments don't turn into fake paths.
 */
function extractPaths(text) {
  const out = new Set();
  const re = /(?:^|[\s`'"(\[])((?:scripts|src|tests|\.github|\.claude|data|supabase|memory|cloud-memory)\/[\w./\-[\]]+\.\w{1,5})(?::\d+(?:-\d+)?)?/g;
  for (const m of String(text || '').matchAll(re)) out.add(m[1].replace(/[.,;:)]+$/, ''));
  return [...out];
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
      // Crude plural fold so "worktrees" meets "worktree".
      .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
  );
}

/**
 * How rare each word is across human commit subjects. "show" or "audit"
 * appears in hundreds of subjects and says little; "liveness" or "yield"
 * appears in a handful and says a lot. Unknown words get the top weight.
 */
function buildIdf(subjects) {
  const df = new Map();
  let n = 0;
  for (const s of subjects) {
    n++;
    for (const w of tokens(s)) df.set(w, (df.get(w) || 0) + 1);
  }
  return (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1));
}

/**
 * Shared significant words between a card title and a commit subject.
 * `ratio` is the IDF-weighted share of the title's words the subject carries
 * (plain share when no idf is given).
 */
function titleOverlap(title, subject, idf = () => 1) {
  const a = tokens(title);
  const b = tokens(subject);
  if (a.size === 0 || b.size === 0) return { shared: [], ratio: 0 };
  const shared = [...a].filter((w) => b.has(w));
  const total = [...a].reduce((sum, w) => sum + idf(w), 0);
  const hit = shared.reduce((sum, w) => sum + idf(w), 0);
  return { shared, ratio: total > 0 ? hit / total : 0 };
}

/**
 * Parse `git log --format=%H%x1f%cI%x1f%s%x1f%b%x1e` output (records end in \x1e).
 */
function parseGitLog(raw) {
  const commits = [];
  for (const chunk of String(raw || '').split('\x1e')) {
    const trimmed = chunk.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const [sha, date, subject, rest = ''] = trimmed.split('\x1f');
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha.trim())) continue;
    commits.push({ sha: sha.trim(), date, subject: subject || '', body: rest.trim() });
  }
  return commits;
}

// Bot commits (data refreshes, checkpoints, audits) outnumber human ones about
// 50 to 1 on main and share vocabulary with every card title. Measured
// 2026-10-12 over the history since 2026-06-01.
// Calibrated 2026-10-12 on the two known duplicates. BRO-2352's original fix
// (0719419938) scores 0.36 on title alone. BRO-2153's (afddebfb0b) scores only
// 0.29, inside the noise band of the 45 open cards (0.22-0.39), but it changed
// scripts/gc-merged-worktrees.sh, which the card names. So a title match
// alone needs 0.3, and one backed by a named file needs 0.2.
const MEDIUM_MIN_SHARED = 3;
const MEDIUM_MIN_RATIO = 0.3;
const PATH_BACKED_MIN_RATIO = 0.2;

const AUTOMATED_SUBJECT_RE = new RegExp([
  '^(data|health|audit|checkpoint|fix\\(data\\)|chore\\(data\\))(\\([^)]*\\))?:',
  '^chore: (checkpoint|update|record|opening|auto|sync|fetch|push)',
  '^feat: (ensemble|collect|wayback)',
  '^(merge |auto-|update (shows|reviews|data))',
].join('|'), 'i');

/**
 * Score one card against main's history.
 *
 *   strong  a commit subject (or a Fixes/Closes/Refs line) names the card's
 *           own id, any commit names its Notion page id, or a commit names an
 *           old task number the card itself carries in its title
 *   medium  a human commit subject shares >= 3 of the card title's words
 *           and >= 30% of their rarity weight, or >= 20% when the commit also
 *           changed a file the card names
 *   weak    a path the card names was changed after the card was created,
 *           or no longer exists (the code it describes may be gone)
 *
 * Flagged = any strong or medium signal. Weak alone is context, not a flag.
 */
function scoreCard(card, commits, { pathExists = () => true, pathHistory = () => [], idf } = {}) {
  const text = `${card.title}\n${card.description || ''}`;
  const notionId = extractNotionId(card.description);
  const notionCompact = notionId ? notionId.replace(/-/g, '') : null;
  const titleTasks = extractTaskNumbers(card.title);
  const createdAt = card.createdAt ? Date.parse(card.createdAt) : 0;
  const idRe = new RegExp(`\\b${card.identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const namedPaths = extractPaths(text);
  // sha -> a path the card names that this commit changed.
  const touchedNamedPath = new Map();
  for (const p of namedPaths) {
    for (const c of pathHistory(p)) if (!touchedNamedPath.has(c.sha)) touchedNamedPath.set(c.sha, p);
  }

  const strong = [];
  const medium = [];
  for (const c of commits) {
    const msg = `${c.subject}\n${c.body}`;
    const why = [];
    // Commit bodies name other cards as examples all the time ("that is how
    // BRO-2356 surfaced"), so a body mention only counts on a reference line.
    if (idRe.test(c.subject)) why.push(`subject names ${card.identifier}`);
    else if (c.body.split('\n').some((l) => REF_LINE_RE.test(l) && idRe.test(l))) {
      why.push(`references ${card.identifier}`);
    }
    if (notionId && (msg.toLowerCase().includes(notionId) || msg.toLowerCase().includes(notionCompact))) {
      why.push('names its Notion page id');
    }
    for (const n of titleTasks) {
      if (new RegExp(`#${n}\\b`).test(msg)) why.push(`names old task #${n}`);
    }
    if (why.length) {
      strong.push({ sha: c.sha, date: c.date, subject: c.subject, why: why.join(', ') });
      continue;
    }
    if (AUTOMATED_SUBJECT_RE.test(c.subject)) continue;
    const { shared, ratio } = titleOverlap(card.title, c.subject, idf);
    if (shared.length < MEDIUM_MIN_SHARED) continue;
    const touched = touchedNamedPath.get(c.sha);
    if (ratio >= MEDIUM_MIN_RATIO || (touched && ratio >= PATH_BACKED_MIN_RATIO)) {
      const why = `title words: ${shared.join(', ')}${touched ? `; changed ${touched}` : ''}`;
      medium.push({ sha: c.sha, date: c.date, subject: c.subject, ratio, why });
    }
  }

  const weak = [];
  for (const p of namedPaths) {
    if (!pathExists(p)) {
      weak.push({ path: p, why: 'path no longer exists' });
      continue;
    }
    // pathHistory(p) returns main's commits touching p, newest first.
    const touching = pathHistory(p).filter(
      (c) => !AUTOMATED_SUBJECT_RE.test(c.subject) && Date.parse(c.date) > createdAt,
    );
    if (touching.length) {
      weak.push({
        path: p,
        why: `changed ${touching.length}x since the card was created`,
        latest: { sha: touching[0].sha, subject: touching[0].subject },
      });
    }
  }

  const level = strong.length ? 'strong' : medium.length ? 'medium' : weak.length ? 'weak' : 'none';
  return {
    identifier: card.identifier,
    title: card.title,
    state: card.state,
    url: card.url,
    notionId,
    level,
    flagged: level === 'strong' || level === 'medium',
    strong: strong.slice(0, 5),
    medium: medium.sort((x, y) => y.ratio - x.ratio).slice(0, 5),
    weak: weak.slice(0, 8),
  };
}

// "Fixes: BRO-12", "Closes BRO-12", "Linear: BRO-12" and friends.
const REF_LINE_RE = /^\s*[-*]?\s*(closes|fixes|fixed|resolves|resolved|refs?|linear|card|task|issue)\b\s*:?/i;

const COMMENT_MARKER = '[notion-migrated-sweep]';

function short(sha) {
  return String(sha).slice(0, 10);
}

/** Comment body for a flagged card. Carries the marker so reruns skip it. */
function buildComment(result) {
  const lines = [
    `${COMMENT_MARKER} This card was migrated from Notion, and main already has commits that may cover it. `
      + 'Check them before working it; close it as a duplicate if they do. Nothing was closed automatically.',
    '',
  ];
  for (const s of result.strong) lines.push(`- ${short(s.sha)} ${s.subject} (${s.why})`);
  for (const m of result.medium) lines.push(`- ${short(m.sha)} ${m.subject} (${m.why})`);
  for (const w of result.weak) {
    lines.push(`- ${w.path}: ${w.why}${w.latest ? `, latest ${short(w.latest.sha)} ${w.latest.subject}` : ''}`);
  }
  lines.push('', 'Generated by scripts/sweep-notion-migrated-duplicates.js (BRO-3576).');
  return lines.join('\n');
}

function buildReport(results, { historySince, shallow } = {}) {
  const flagged = results.filter((r) => r.flagged);
  const order = { strong: 0, medium: 1 };
  flagged.sort((a, b) => order[a.level] - order[b.level] || a.identifier.localeCompare(b.identifier));
  const out = [
    '# Notion-migrated cards that may already be done',
    '',
    `Open migrated cards checked: ${results.length}. Flagged: ${flagged.length} `
      + `(${flagged.filter((r) => r.level === 'strong').length} strong, ${flagged.filter((r) => r.level === 'medium').length} medium).`,
  ];
  if (historySince) out.push(`Commit history searched from ${historySince}.`);
  if (shallow) {
    out.push('Shallow clone: fixes older than the date above are invisible. To search further back: '
      + 'git fetch --filter=blob:none --shallow-since=<date> origin main');
  }
  out.push('');
  for (const r of flagged) {
    out.push(`## ${r.identifier} (${r.level}, ${r.state}) ${r.title}`, r.url || '', '');
    out.push(buildComment(r).split('\n').filter((l) => l.startsWith('- ')).join('\n'), '');
  }
  return out.join('\n');
}

module.exports = {
  COMMENT_MARKER,
  MIGRATION_MARKERS,
  extractNotionId,
  extractTaskNumbers,
  extractPaths,
  titleOverlap,
  buildIdf,
  parseGitLog,
  isAutomatedSubject: (subject) => AUTOMATED_SUBJECT_RE.test(String(subject || '')),
  scoreCard,
  buildComment,
  buildReport,
};
