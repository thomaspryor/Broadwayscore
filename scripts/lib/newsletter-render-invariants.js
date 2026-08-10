'use strict';
/**
 * Render invariants for the weekly newsletter.
 *
 * WHY THIS EXISTS (2026-08-09): the coverage-gap swap dropped featured
 * openings from the rendered West End email while meta.openingShows still
 * listed them. Nothing noticed. A session then "verified" the draft by
 * grepping the HTML for a show title, saw the title in the lede, and
 * reported success — while the show was absent from the openings block a
 * reader actually looks at. The owner found it by eye, twice.
 *
 * The lesson is not "grep more carefully". A substring test cannot answer
 * the question that matters ("is this show RENDERED AS AN OPENING?"), so it
 * must stop being the thing anyone relies on. These are the assertions the
 * pipeline runs itself, every send, so no human or agent eyeball is load-
 * bearing.
 *
 * Deliberately template-agnostic: it compares the rendered HTML against the
 * generator's OWN manifest (meta.openingShows) rather than against a
 * hardcoded section heading. The West End edition renders its openings as an
 * unheaded lead block while Broadway uses an "Opened ..." <h2>; an assertion
 * keyed on headings would be a false alarm on one edition and would have to
 * be loosened until it caught nothing. Comparing to the manifest works for
 * both and survives redesigns.
 */

/** Strip tags so text assertions aren't defeated by inline markup. */
function textOf(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Normalise for comparison: lowercase, straighten curly quotes, collapse space.
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-title containment — NOT a substring test.
 *
 * data/shows.json carries 448 single-word titles, many of them ordinary
 * English: "Art", "Home", "Elf", "Bug", "Chess", "Job", "English". A plain
 * `includes()` breaks in BOTH directions, and a reviewer caught both with real
 * data before this shipped:
 *   - false POSITIVE: an editorial subject containing "smart" matches the show
 *     "Art", hard-failing the gate and blocking a correct Sunday send. A gate
 *     that blocks good sends gets deleted, and then protects nothing.
 *   - false NEGATIVE: "Art" genuinely dropped from the body still "matches"
 *     the word "smart" elsewhere in the copy, so the gate stays silent on the
 *     exact incident class it exists to catch.
 *
 * \b is not usable here: titles end in punctuation and apostrophes
 * ("Schmigadoon!", "I'm Every Woman", "Rosie O'Donnell: Common Knowledge"), and
 * \b after "!" behaves the opposite of what you want. This repo has already
 * paid for that lesson (memory: feedback_word_boundary_punct_titles). Use
 * explicit non-alphanumeric boundary checks on the raw normalised strings.
 */
function containsTitle(haystack, title) {
  const hay = norm(haystack);
  const needle = norm(title);
  if (!hay || !needle) return false;
  const isWordChar = (ch) => !!ch && /[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? hay[idx - 1] : '';
    const after = idx + needle.length < hay.length ? hay[idx + needle.length] : '';
    // A match is real unless it is glued to a word character on a side where
    // the title itself starts/ends with a word character. "Art" inside "smart"
    // fails (word char before); "Art," or "(Art)" or "Art." all pass.
    const leftOK = !isWordChar(before) || !isWordChar(needle[0]);
    const rightOK = !isWordChar(after) || !isWordChar(needle[needle.length - 1]);
    if (leftOK && rightOK) return true;
    from = idx + 1;
  }
}

/** Section headings with their byte offsets, in document order. */
function sectionsOf(html) {
  const src = String(html || '');
  const out = [];
  const re = /<h[1-3][^>]*>([\s\S]{2,120}?)<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ index: m.index, heading: textOf(m[1]).trim() });
  }
  return out;
}

/**
 * Where does `needle` actually appear? Returns one entry per occurrence with
 * the enclosing section heading (null = before any heading, i.e. subject /
 * preheader / lede / unheaded lead block).
 *
 * This is the replacement for `html.includes(title)`. It answers "where",
 * which is the only useful form of the question.
 */
function placementsOf(html, needle) {
  const src = String(html || '');
  const target = String(needle || '');
  if (!target) return [];
  const sections = sectionsOf(src);
  const out = [];
  let from = 0;
  for (;;) {
    const idx = src.indexOf(target, from);
    if (idx === -1) break;
    let enclosing = null;
    for (const s of sections) {
      if (s.index < idx) enclosing = s.heading;
      else break;
    }
    out.push({ index: idx, section: enclosing });
    from = idx + target.length;
  }
  return out;
}

/**
 * THE invariant tonight's bug violated: every show the generator selected as
 * a featured opening must actually be rendered in the email body.
 *
 * `meta.openingShows` is the generator's own answer to "what is this week's
 * openings block", so a show present there but absent from the HTML means
 * something downstream (the coverage-gap swap, a section drop, a template
 * regression) deleted it after selection — silently, every time so far.
 *
 * Matching is on title, tag-stripped, case-insensitive, apostrophe-normalised
 * — show titles carry curly quotes and accents that survive JSON but get
 * entity-encoded in the HTML ("I'm Every Woman" is exactly such a title, and
 * was the show that went missing).
 */
function findUnrenderedOpenings(html, openingShows) {
  const text = textOf(html);
  const list = Array.isArray(openingShows) ? openingShows : [];
  const missing = [];
  for (const s of list) {
    const title = String((s && s.title) || '').trim();
    if (!title) continue;
    if (!containsTitle(text, title)) {
      missing.push({ id: (s && s.id) || null, title });
    }
  }
  return missing;
}

/**
 * The subject line names a show; that show must be in the body. Tonight the
 * West End subject announced "Now You See Me Live opens to decent reviews"
 * while the body had no openings block at all — the single most reader-
 * visible symptom, and nothing checked it.
 *
 * Conservative by design: only asserts when a title from openingShows is
 * actually found in the subject, so a purely editorial subject (or an
 * override) never trips it.
 */
function subjectShowMissingFromBody(subject, html, openingShows) {
  if (!String(subject || '').trim()) return null;
  const text = textOf(html);
  const list = Array.isArray(openingShows) ? openingShows : [];
  // Longest title first: "The Comedy About Spies" must win over a shorter
  // title that happens to be a substring of it.
  const titles = list
    .map((s) => String((s && s.title) || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const t of titles) {
    // containsTitle, NOT includes: a subject reading "a smart pick this week"
    // must not match the show "Art" and hard-fail a perfectly good send.
    if (containsTitle(subject, t)) {
      return containsTitle(text, t) ? null : t;
    }
  }
  return null;
}

/**
 * One call for the pre-send path. Returns hard-failure strings (empty = OK).
 */
function renderInvariantFailures({ html, meta }) {
  const failures = [];
  const openings = (meta && meta.openingShows) || [];
  const unrendered = findUnrenderedOpenings(html, openings);
  for (const s of unrendered) {
    failures.push(
      `Featured opening "${s.title}"${s.id ? ` (${s.id})` : ''} is in meta.openingShows but does NOT appear in the rendered email. ` +
        `Something dropped it after selection (coverage-gap swap, section drop, or template regression). ` +
        `Do NOT verify this by grepping the HTML for the title — check where it renders.`
    );
  }
  const subjShow = subjectShowMissingFromBody(meta && meta.subject, html, openings);
  if (subjShow) {
    failures.push(
      `Subject line announces "${subjShow}" but that show does not appear in the email body. ` +
        `Subscribers would open an email promising a show it never covers.`
    );
  }
  return failures;
}

module.exports = {
  textOf,
  sectionsOf,
  placementsOf,
  findUnrenderedOpenings,
  subjectShowMissingFromBody,
  renderInvariantFailures,
};
