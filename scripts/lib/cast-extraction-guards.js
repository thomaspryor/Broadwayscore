// Sanity checks for LLM-extracted cast data. Catches the contamination
// patterns seen in 12+ historical bad cast files (Met Opera singers as
// Kavalier-and-Clay cast, TV-show titles as Much-Ado roles, LASTNAME-FIRSTNAME
// names from BWW alphabetical listings). Used by:
//   - scripts/backfill-cast-web.js (pre-write gate)
//   - scripts/audit-cast-contamination.js (post-hoc sweep)
//
// If you extend the patterns here, also extend the audit script's signal list.

const OPERA_TITLES = [
  'cavalleria rusticana', 'pagliacci', 'nabucco', 'rigoletto', 'tristan', 'isolde',
  'madama butterfly', 'eugene onegin', 'la traviata', 'tosca', 'la boheme',
  'don giovanni', 'aida', 'carmen', 'turandot', 'la sonnambula', 'abigaille',
  'figaro', 'fidelio', 'lohengrin', 'parsifal',
];

const TV_PATTERNS = [
  'bridgerton', 'top boy', 'unforgotten', 'dumping ground',
  'in his first professional role', 'in her first professional role',
];

const COLUMN_HEADER_RE = /^(original|replacement|standby|alternate|swing|ensemble|covering)$/i;

const KNOWN_SWAP_SURNAMES = new Set([
  'jenkins', 'williams', 'smith', 'brown', 'jones', 'morgan',
  'lumsden', 'malpass', 'woodyatt', 'thompson', 'johnson',
]);

/**
 * Validate LLM-extracted cast for the wrong-show / corrupted-role patterns.
 *
 * @param {Array<{name:string, role?:string}>} cast - LLM output
 * @param {string} showTitle - Target show title (used to exempt opera shows)
 * @returns {{ok:boolean, reasons:string[], cleaned:Array}}
 *   - ok=false → caller should reject this extraction and try the next URL
 *   - cleaned=array → with column-header roles stripped (safe to use even
 *     when ok=true; only column-header roles are mutated)
 */
function validateCastExtraction(cast, showTitle) {
  if (!Array.isArray(cast) || cast.length === 0) {
    return { ok: false, reasons: ['empty'], cleaned: [] };
  }

  const reasons = [];
  const titleLower = String(showTitle || '').toLowerCase();
  const showIsOpera = /\bopera\b|the met\b/.test(titleLower);

  if (!showIsOpera) {
    const operaHits = cast.filter(m =>
      m.role && OPERA_TITLES.some(o => m.role.toLowerCase().includes(o))
    );
    if (operaHits.length >= 2) reasons.push(`opera-role-contamination:${operaHits.length}`);
  }

  const tvHits = cast.filter(m =>
    m.role && TV_PATTERNS.some(t => m.role.toLowerCase().includes(t))
  );
  if (tvHits.length >= 2) reasons.push(`tv-role-contamination:${tvHits.length}`);

  const swapped = cast.filter(m => {
    if (!m.name) return false;
    const parts = m.name.split(/\s+/);
    return parts.length === 2 && KNOWN_SWAP_SURNAMES.has(parts[0].toLowerCase());
  });
  if (swapped.length >= 2) reasons.push(`name-swap-pattern:${swapped.length}`);

  // Safe-to-strip: column-header roles ("Original", "Standby") — drop the role
  // field, keep the name. The LLM grabbed a table column header instead of a
  // character name; the name itself is usually correct.
  const cleaned = cast.map(m => {
    if (m.role && COLUMN_HEADER_RE.test(m.role.trim())) {
      const { role, ...rest } = m;
      return rest;
    }
    return m;
  });

  return { ok: reasons.length === 0, reasons, cleaned };
}

module.exports = {
  validateCastExtraction,
  OPERA_TITLES,
  TV_PATTERNS,
  COLUMN_HEADER_RE,
  KNOWN_SWAP_SURNAMES,
};
