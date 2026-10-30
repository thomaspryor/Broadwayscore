/**
 * coordinator-registry.js — areas of the repo that have a coordinator card (BRO-6083).
 *
 * On 2026-10-22/23 several sessions changed opening-night code at once. The
 * coordinator posted "do not start a parallel fix" and a session that had
 * started two minutes earlier never re-read the card before landing. This
 * registry says which card coordinates which paths, so a session sees the
 * coordinator's latest notes when it starts on the area and again when it lands.
 *
 * Pure: no I/O. scripts/coordinator-check.js does the git and Linear reads.
 *
 * The land check (advisory, CLAUDE.md §19) wants a commit-message line
 *   COORDINATOR-ACK: BRO-5955@<first 8+ chars of the latest coordinator note's id>
 * naming the NEWEST coordinator note on the card, so an ack goes stale when the
 * coordinator posts a new one. A coordinator note is a comment whose body starts
 * with one of the area's markers (COORDINATOR-NOTE:, COORDINATION, OWNER DECISION, ...);
 * worker status comments never make an ack stale. Owner bypass:
 *   COORDINATOR-ACK-BYPASS: <reason, 15+ chars>
 *
 * To add an area: one entry below. To retire one: delete it.
 */

const { globToRegExp } = require('./test-yml-push-paths');

const DEFAULT_NOTE_MARKERS = ['COORDINATOR-NOTE', 'COORDINATION', 'OWNER DECISION', 'OWNER REQUIREMENT', 'CORRECTION'];

const REGISTRY = [
  {
    area: 'opening-night',
    card: 'BRO-5955',
    // Lane, poller, Express, text collection, press-night record and their workflows.
    globs: [
      'scripts/lib/opening-night-lane/**',
      'scripts/lib/opening-night-*/**',
      'scripts/opening-night-*/**',
      'scripts/*opening-night*',
      'scripts/lib/*opening-night*',
      'scripts/cli/*opening-night*',
      'scripts/*press-night*',
      'scripts/lib/*press-night*',
      'scripts/*poller*',
      'scripts/lib/*poller*',
      'scripts/*express*',
      'scripts/lib/*express*',
      'scripts/collect-review-texts*',
      '.github/workflows/*opening-night*.yml',
      '.github/workflows/*press-night*.yml',
      '.github/workflows/*collect-review-texts*.yml',
      '.github/workflows/*poller*.yml',
      '.github/workflows/lane-rehearsal.yml',
      '.github/actions/opening-night-*/**',
    ],
    // Phrases that mark a card's text as opening-night work (start reminder only).
    keywords: [/\bopening[- ]night\b/i, /\bpress[- ]night\b/i, /\bopening-night-lane\b/i, /\bexpress lane\b/i, /\bnight lease\b/i, /\bcollect-review-texts\b/i, /\bopening-night-poller\b/i],
    markers: DEFAULT_NOTE_MARKERS,
    // Owner decision 2026-10-30 (BRO-6585, option A): one session owns press night.
    rule: 'Owner rule: the coordinator session owns press night, both every review live on the site and the lane trial. Any other session reports what it finds to the coordinator and lands nothing for that show overnight without its go; a hand-added review is the coordinator\'s call and is recorded as manual.',
  },
];

const ACK_RE = /^\s*COORDINATOR-ACK:\s*(BRO-\d+)@([0-9a-f-]{8,})\s*$/gim;
const BYPASS_RE = /^\s*COORDINATOR-ACK-BYPASS:\s*(.{15,}?)\s*$/im;
const MIN_ACK_ID = 8;

function compiled(entry) {
  if (!entry._res) Object.defineProperty(entry, '_res', { value: entry.globs.map(globToRegExp) });
  return entry._res;
}

/** Areas whose globs match any of `files`, each with the files it matched. */
function areasForFiles(files, registry = REGISTRY) {
  const out = [];
  for (const entry of registry) {
    const matched = (files || []).filter((f) => compiled(entry).some((re) => re.test(f)));
    if (matched.length) out.push({ entry, files: matched });
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Areas whose keywords appear in free text (a card title and description). */
function areasForText(text, registry = REGISTRY) {
  const s = String(text || '');
  return registry.filter((e) => (e.keywords || []).some((re) => re.test(s)) || new RegExp(`\\b${escapeRe(e.card)}(?![0-9])`, 'i').test(s));
}

/** Every COORDINATOR-ACK line in `text`: [{ card, id }]. */
function parseAcks(text) {
  return [...String(text || '').matchAll(ACK_RE)].map((m) => ({ card: m[1].toUpperCase(), id: m[2].toLowerCase() }));
}

function parseBypass(text) {
  const m = String(text || '').match(BYPASS_RE);
  return m ? m[1].trim() : null;
}

/** Comments newest first. */
function newestFirst(comments) {
  return [...(comments || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function isCoordinatorNote(comment, markers = DEFAULT_NOTE_MARKERS) {
  // Markdown emphasis or a heading in front of the marker still counts (`**COORDINATION**`, `## COORDINATOR-NOTE`).
  const body = String((comment && comment.body) || '').replace(/^[\s*#>_]+/, '');
  return markers.some((m) => body.startsWith(m));
}

/** The newest comment that is a coordinator note, or null. */
function latestNote(comments, markers = DEFAULT_NOTE_MARKERS) {
  return newestFirst(comments).find((c) => isCoordinatorNote(c, markers)) || null;
}

function ackLine(card, note) {
  return `COORDINATOR-ACK: ${card}@${String(note.id).slice(0, MIN_ACK_ID)}`;
}

/** land/bro-5955-... is the coordinator's own land. */
function isOwnCardBranch(branch, card) {
  const n = card.split('-')[1];
  return new RegExp(`(^|/)bro-${n}(?![0-9])`, 'i').test(String(branch || ''));
}

/**
 * Judge one land.
 * @param files       changed paths (merge-base...tip)
 * @param commitText  every commit message on the branch, joined
 * @param branch      the land ref (exempts the coordinator card's own land)
 * @param notesByCard Map card -> { ok: true, comments, url, title } | { ok: false, error }
 * @returns { status: 'skip'|'ok'|'warn'|'unknown', findings }
 */
function judgeLand({ files, commitText, branch = '', notesByCard = new Map() }, registry = REGISTRY) {
  const areas = areasForFiles(files, registry);
  if (!areas.length) return { status: 'skip', findings: [] };
  const acks = parseAcks(commitText);
  const bypass = parseBypass(commitText);
  const findings = areas.map(({ entry, files: matched }) => {
    const base = { area: entry.area, card: entry.card, files: matched };
    if (isOwnCardBranch(branch, entry.card)) return { ...base, status: 'own-card' };
    if (bypass) return { ...base, status: 'bypass', bypass };
    const notes = notesByCard.get(entry.card);
    if (!notes || !notes.ok) return { ...base, status: 'unknown', error: (notes && notes.error) || 'not read' };
    const note = latestNote(notes.comments, entry.markers);
    const recent = newestFirst(notes.comments).slice(0, 3);
    const extra = { url: notes.url || null, note, recent };
    const mine = acks.filter((a) => a.card === entry.card);
    if (!note) return { ...base, ...extra, status: mine.length ? 'acked' : 'missing-ack' };
    const want = String(note.id).toLowerCase();
    if (mine.some((a) => a.id.length >= MIN_ACK_ID && want.startsWith(a.id))) return { ...base, ...extra, status: 'acked' };
    return { ...base, ...extra, status: mine.length ? 'stale-ack' : 'missing-ack' };
  });
  const warn = findings.some((f) => f.status === 'missing-ack' || f.status === 'stale-ack');
  const unknown = findings.some((f) => f.status === 'unknown');
  return { status: warn ? 'warn' : unknown ? 'unknown' : 'ok', findings };
}

function clip(s, n) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function stamp(c) {
  return `${String(c.id).slice(0, MIN_ACK_ID)}, ${String(c.createdAt || '').slice(0, 16).replace('T', ' ')}Z`;
}

/** Card + latest coordinator note + newest comments, as plain lines. */
function notesLines(card, url, note, recent) {
  const lines = [`Coordinator card: ${card}${url ? ` ${url}` : ''}`];
  if (note) lines.push(`Latest coordinator note (${stamp(note)}): ${clip(note.body, 700)}`);
  else lines.push('No coordinator note on the card yet (a comment starting COORDINATOR-NOTE:, COORDINATION, OWNER DECISION, OWNER REQUIREMENT or CORRECTION).');
  for (const c of recent || []) {
    if (note && c.id === note.id) continue;
    lines.push(`Newer comment (${stamp(c)}): ${clip(c.body, 300)}`);
  }
  return lines;
}

/** Advisory message for a land verdict; '' when there is nothing to say. */
function formatLandMessage(verdict) {
  if (verdict.status === 'skip' || verdict.status === 'ok') return '';
  const out = [];
  for (const f of verdict.findings) {
    const where = `${f.files.slice(0, 4).join(', ')}${f.files.length > 4 ? ` and ${f.files.length - 4} more` : ''}`;
    if (f.status === 'unknown') {
      out.push(`COORDINATOR CHECK (advisory): this land touches the ${f.area} area (${where}), coordinated on ${f.card}, but the card could not be read (${f.error}). Read ${f.card}'s newest comments yourself before landing.`);
      continue;
    }
    if (f.status !== 'missing-ack' && f.status !== 'stale-ack') continue;
    out.push(`COORDINATOR CHECK (advisory): this land touches the ${f.area} area (${where}), coordinated on ${f.card}. ${f.status === 'stale-ack' ? 'Your COORDINATOR-ACK names an older note; the coordinator has posted since.' : 'No commit acknowledges the coordinator\'s latest note.'}`);
    out.push(...notesLines(f.card, f.url, f.note, f.recent).map((l) => `  ${l}`));
    out.push(f.note
      ? `  Re-read it. If your change still fits, add this line to your commit message: ${ackLine(f.card, f.note)}`
      : `  Re-read it. If your change still fits, add: COORDINATOR-ACK: ${f.card}@<id of the comment you read>`);
  }
  return out.join('\n');
}

/** Start reminder for one area. */
function formatReminder(entry, notes) {
  const head = `COORDINATOR: ${entry.area} work is coordinated on ${entry.card}. Read its newest comments before you start and again before you land; do not start a parallel fix of something it already assigned.${entry.rule ? `\n  ${entry.rule}` : ''}`;
  if (!notes || !notes.ok) return `${head}\n  (Could not read ${entry.card}: ${(notes && notes.error) || 'not read'}.)`;
  const note = latestNote(notes.comments, entry.markers);
  const lines = notesLines(entry.card, notes.url, note, newestFirst(notes.comments).slice(0, 3));
  if (note) lines.push(`Landing changes here: add ${ackLine(entry.card, note)} to your commit message once you have read it.`);
  return [head, ...lines.map((l) => `  ${l}`)].join('\n');
}

module.exports = {
  REGISTRY,
  DEFAULT_NOTE_MARKERS,
  areasForFiles,
  areasForText,
  parseAcks,
  parseBypass,
  latestNote,
  isCoordinatorNote,
  ackLine,
  isOwnCardBranch,
  judgeLand,
  formatLandMessage,
  formatReminder,
};
