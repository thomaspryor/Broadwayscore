/**
 * Provenance stamp for shows.json `synopsis` (BRO-4856). BRO-4853 found 76 bad
 * synopses and could not trace where Fela! and The Great Society's came from
 * because nothing recorded the writer. Every script that writes
 * `show.synopsis` calls setSynopsis() so `synopsisSource` always travels with
 * the text.
 */
const SYNOPSIS_SOURCES = ['show-score', 'todaytix', 'wikipedia', 'llm', 'manual', 'discovery'];

function setSynopsis(show, text, source) {
  if (!SYNOPSIS_SOURCES.includes(source)) {
    throw new Error(`setSynopsis: unknown synopsis source "${source}" (expected one of ${SYNOPSIS_SOURCES.join(', ')})`);
  }
  show.synopsis = text;
  if (text) show.synopsisSource = source;
  else delete show.synopsisSource;
  return show;
}

/** Clears the synopsis and its stamp together (never leave an orphan stamp). */
function clearSynopsis(show, value = '') {
  show.synopsis = value;
  delete show.synopsisSource;
  return show;
}

/**
 * Returns a problem string for an invalid stamp, else null. Unstamped rows are
 * allowed (legacy). A free-text note naming a BRO card ("hand-written ... (BRO-4884)")
 * is also allowed: 12 hand-written rows already carry one.
 */
function synopsisSourceProblem(show) {
  if (show.synopsisSource === undefined) return null;
  const v = show.synopsisSource;
  if (!SYNOPSIS_SOURCES.includes(v) && !(typeof v === 'string' && /\bBRO-\d+/.test(v))) {
    return `synopsisSource "${v}" is not one of ${SYNOPSIS_SOURCES.join(', ')} or a note citing a BRO card`;
  }
  if (!show.synopsis) return 'synopsisSource is set but synopsis is empty';
  return null;
}

module.exports = { SYNOPSIS_SOURCES, setSynopsis, clearSynopsis, synopsisSourceProblem };
