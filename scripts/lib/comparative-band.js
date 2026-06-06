/**
 * Comparative within-band scoring.
 *
 * Problem this solves: the anchored scorer (scripts/llm-scoring, scoreSource
 * 'anchored-v6') scores each review in ISOLATION. For a band like 5★ [91,100],
 * almost every genuine strong rave snaps to the q3≈97 anchor in
 * buildAnchoredBandBlock — so a show with four 5★ raves shows 97/97/97/97 even
 * though the prose warmth genuinely differs (War Horse WE 2026, 2026-06-05).
 *
 * Validated finding (2026-06-05): when the SAME four reviews are scored
 * COMPARATIVELY — all of a show's same-band reviews in one prompt, told to
 * assign distinct within-band positions by RELATIVE warmth — GPT-4o and Gemini
 * both spread them 92-99 and AGREE on the ordering. The warmth signal is real
 * and detectable; isolation is what flattens it.
 *
 * This module holds the PURE pieces (prompt builder, response parser, combine
 * + guardrail) so they're unit-testable via require() with no API key or data.
 * The orchestration (model calls + file write-back) lives in
 * scripts/llm-scoring/comparative-rescore.ts.
 *
 * GUARDRAIL (critical): spread by GENUINE warmth only. Distinctness is a SOFT
 * goal; real warmth is the hard one. We must NOT force-spread reviews that are
 * truly equivalent. combineComparative() enforces this: if the models disagree
 * on the warmth ORDERING (no real signal), it falls back toward the isolated
 * scores instead of inventing differences.
 */

'use strict';

/**
 * Build the comparative within-band prompt for a group of same-band reviews.
 *
 * @param {Array<{id: string, outlet?: string, text: string}>} reviews
 *        Reviews that all share the same star band. `id` must be unique and
 *        stable (the orchestration uses the review filename).
 * @param {{floor: number, ceiling: number}} band  Hard score bounds.
 * @param {{starsRaw?: string, marketLabel?: string}} [opts]
 * @returns {string} A complete prompt (system + task). The caller sends it as
 *          a single message; output is a JSON array, one entry per review.
 */
function buildComparativeBandPrompt(reviews, band, opts = {}) {
  if (!Array.isArray(reviews) || reviews.length < 2) {
    throw new Error('buildComparativeBandPrompt requires 2+ reviews');
  }
  const { floor, ceiling } = band;
  const starsLine = opts.starsRaw
    ? `All ${reviews.length} critics awarded the SAME rating (**${opts.starsRaw}**), so every review sits in the band **[${floor}, ${ceiling}]**.`
    : `All ${reviews.length} critics awarded the same star rating, so every review sits in the band **[${floor}, ${ceiling}]**.`;

  const reviewBlocks = reviews
    .map((r, i) => {
      const label = r.outlet ? `${r.outlet}` : `Review ${i + 1}`;
      // Cap each review so a large group stays within the model's context and
      // the verdict-bearing prose (which leads) is always included.
      const body = String(r.text || '').slice(0, 4000);
      return `### id: ${r.id}\nOutlet: ${label}\n"""\n${body}\n"""`;
    })
    .join('\n\n');

  return `You are a theater critic review scorer for ${opts.marketLabel || 'West End'} shows.

You are given ${reviews.length} reviews of the SAME production. ${starsLine}

The star rating is fixed — it sets the band. Your ONLY job is to position each review WITHIN [${floor}, ${ceiling}] by its RELATIVE prose warmth, by comparing the reviews directly against EACH OTHER.

## How to rank
- The warmest, most rapturous, most reservation-free prose → top of the band. Use the **ceiling (${ceiling})** for genuinely career-best, "see it twice", standing-ovation, no-caveats raves. Do NOT avoid the ceiling.
- Measured, qualified, or biographical/context-heavy prose, or prose that names real reservations (even ones the critic dismisses) → **lower** in the band.
- Judge the WHOLE review's evaluative warmth, not isolated adjectives.

## Distinctness is a SOFT goal — warmth is the HARD one
- If two reviews are genuinely equal in warmth, give them EQUAL or near-equal scores. That is correct, not a failure.
- DO NOT invent differences to make the numbers look distinct. Spread the scores ONLY where the prose genuinely differs in warmth.
- Every score MUST be an integer in [${floor}, ${ceiling}]. Never go outside the band.

## Output
Respond with ONLY a JSON array — one object per review, in any order — and nothing else:
[
  { "id": "<exact id from above>", "score": <integer in [${floor}, ${ceiling}]>, "warmthRank": <1 = warmest>, "reasoning": "<one phrase: why this position vs the others>" }
]

The reviews:

${reviewBlocks}
`;
}

/**
 * Parse a comparative response into a map of id → { score, warmthRank, reasoning }.
 *
 * Tolerates: markdown code fences, a top-level array or an object wrapping the
 * array under common keys, string scores, and extra/missing ids. Returns an
 * empty object if no array can be recovered. Clamping to band is the caller's
 * job (combineComparative).
 *
 * @param {string} text       Raw model output.
 * @param {string[]} expectedIds  Ids we asked the model to score.
 * @returns {Record<string, {score: number, warmthRank: number|null, reasoning: string}>}
 */
function parseComparativeResponse(text, expectedIds) {
  if (typeof text !== 'string' || !text.trim()) return {};
  const expected = new Set(expectedIds || []);

  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  let arr = null;
  // Prefer a clean parse; fall back to extracting the first [...] block.
  try {
    const parsed = JSON.parse(cleaned);
    arr = pickArray(parsed);
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
      try { arr = pickArray(JSON.parse(m[0])); } catch { arr = null; }
    }
  }
  if (!Array.isArray(arr)) return {};

  const out = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id != null ? entry.id : '').trim();
    if (!id) continue;
    // Only keep ids we actually asked about (drop hallucinated extras).
    if (expected.size > 0 && !expected.has(id)) continue;
    let score = typeof entry.score === 'number' ? entry.score : parseFloat(entry.score);
    if (!Number.isFinite(score)) continue;
    score = Math.round(score);
    const warmthRank = Number.isFinite(Number(entry.warmthRank)) ? Number(entry.warmthRank) : null;
    out[id] = { score, warmthRank, reasoning: String(entry.reasoning || '') };
  }
  return out;
}

function pickArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of ['reviews', 'scores', 'results', 'data', 'items']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  return null;
}

/**
 * Spearman-style ordering agreement between two score maps over shared ids.
 * Returns a value in [-1, 1] (1 = identical ordering). Ties are handled by
 * average rank. Returns null when fewer than 2 shared ids.
 */
function orderingAgreement(scoresA, scoresB, ids) {
  const shared = ids.filter((id) => id in scoresA && id in scoresB);
  if (shared.length < 2) return null;
  const ra = rank(shared.map((id) => scoresA[id]));
  const rb = rank(shared.map((id) => scoresB[id]));
  const n = shared.length;
  const mean = (n - 1) / 2; // ranks are 0-based here
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ra[i] - mean;
    const xb = rb[i] - mean;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 1; // all tied on one side → no contradiction
  return num / Math.sqrt(da * db);
}

function rank(values) {
  // Average-rank for ties; ascending (lowest value → rank 0).
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Combine per-model comparative scores into a final per-review score, with the
 * anti-invention guardrail.
 *
 * @param {Array<Record<string, number>>} modelScoreMaps  One id→score map per model.
 * @param {Record<string, number>} isolatedScores         id→current isolated score.
 * @param {{floor: number, ceiling: number}} band
 * @param {{minModels?: number, agreementFloor?: number}} [opts]
 * @returns {Record<string, {score: number, isolated: number, models: number[], agreement: number|null, applied: boolean, note: string}>}
 *
 * Rules:
 *   - Each model score is clamped to band before averaging.
 *   - An id needs >= minModels (default 2) model scores to be eligible; otherwise
 *     it keeps its isolated score (applied=false).
 *   - GUARDRAIL: if 2 models are present and their warmth ORDERING disagrees
 *     (agreement < agreementFloor, default 0), the warmth signal isn't real —
 *     fall back to isolated scores for the whole group rather than invent
 *     spread. With 3+ models we trust the consensus (outliers wash out).
 */
function combineComparative(modelScoreMaps, isolatedScores, band, opts = {}) {
  const minModels = opts.minModels ?? 2;
  const agreementFloor = opts.agreementFloor ?? 0;
  const clamp = (s) => Math.max(band.floor, Math.min(band.ceiling, Math.round(s)));
  const ids = Object.keys(isolatedScores);
  const maps = (modelScoreMaps || []).filter((m) => m && typeof m === 'object');

  // Group-level ordering agreement (only defined for exactly the 2-model case;
  // for 3+ we average pairwise and still trust consensus).
  let agreement = null;
  if (maps.length >= 2) {
    const pair = [];
    for (let a = 0; a < maps.length; a++)
      for (let b = a + 1; b < maps.length; b++) {
        const ag = orderingAgreement(maps[a], maps[b], ids);
        if (ag != null) pair.push(ag);
      }
    if (pair.length) agreement = pair.reduce((x, y) => x + y, 0) / pair.length;
  }

  const twoModelDisagrees =
    maps.length === 2 && agreement != null && agreement < agreementFloor;

  const out = {};
  for (const id of ids) {
    const isolated = isolatedScores[id];
    const present = maps
      .map((m) => m[id])
      .filter((s) => Number.isFinite(s))
      .map(clamp);

    if (present.length < minModels || twoModelDisagrees) {
      out[id] = {
        score: isolated,
        isolated,
        models: present,
        agreement,
        applied: false,
        note: present.length < minModels
          ? `kept isolated (only ${present.length} model score${present.length === 1 ? '' : 's'})`
          : `kept isolated (models disagree on ordering, agreement=${agreement?.toFixed(2)})`,
      };
      continue;
    }
    const mean = present.reduce((x, y) => x + y, 0) / present.length;
    out[id] = {
      score: clamp(mean),
      isolated,
      models: present,
      agreement,
      applied: true,
      note: 'comparative',
    };
  }
  return out;
}

module.exports = {
  buildComparativeBandPrompt,
  parseComparativeResponse,
  combineComparative,
  orderingAgreement,
};
