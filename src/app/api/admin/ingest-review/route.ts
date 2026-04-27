import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { isAdmin } from '@/lib/admin-auth';
import { detectFromReview } from '@/lib/admin-ingest-detect';
import { parseScore } from '@/lib/admin-ingest-score';
import { createRequire } from 'module';

// Import CommonJS helpers from scripts/lib/ — these are the same ones the CLI
// ingest-manual-review.js uses, so the on-disk semantics (protection fields,
// filename normalization) are identical. See memory/feedback_per_file_protected_fields_lock.md.
const cjsRequire = createRequire(import.meta.url);
const { generateReviewFilename, normalizeCritic, normalizeOutlet } = cjsRequire('../../../../../scripts/lib/review-normalization') as {
  generateReviewFilename: (outlet: string, critic: string) => string;
  normalizeCritic: (name: string) => string;
  normalizeOutlet: (outlet: string) => string;
};
const { buildManualReviewFields } = cjsRequire('../../../../../scripts/lib/manual-review-fields') as {
  buildManualReviewFields: (opts: {
    humanScore?: number | null;
    fullText?: string | null;
    originalScore?: string | null;
    originalScoreSource?: string | null;
    publishDate?: string | null;
  }) => Record<string, unknown>;
};
// extractScore runs the per-outlet score extractor against fullText (no HTML).
// Used for the /ingest pre-rebuild pass (Issue #6): when the operator pastes
// "★★★/5" body text without entering a score in the form, we still want
// originalScore + originalScoreNormalized populated BEFORE rebuild touches the
// file, so rebuild's P0.5 path returns the explicit rating instead of falling
// through to the LLM ensemble's body-sentiment guess.
//
// scoreToBucket maps a 1-100 score to a bucket label (Rave/Positive/Mixed/
// Negative/Pan). Used by Issue #10's keyPhrase clear: when /ingest writes a
// humanReviewScore that crosses a tier boundary from any pre-existing
// llmScore.score, we clear llmScore.keyPhrases so rebuild's pullquote
// selection falls through to a non-mismatched source. Helen Shaw on Lost
// Boys 2026-04-26: LLM scored 68 (Mixed) → keyPhrases highlighted negative
// Act 2 critique. Operator overrode score to 78 (Positive) but didn't clear
// keyPhrases — pullquote stayed negative on a Positive review.
const { extractScore, scoreToBucket, OUTLET_VERIFIED_SOURCES } = cjsRequire(
  '../../../../../scripts/lib/score-extractors',
) as {
  extractScore: (
    html: string,
    text: string,
    outletId: string,
  ) => { originalScore: string; normalizedScore: number; source: string; outlet?: string } | null;
  scoreToBucket: (score: number) => string;
  OUTLET_VERIFIED_SOURCES: Set<string>;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PRIVATE_REPO_OWNER = 'thomaspryor';
const PRIVATE_REPO_NAME = 'broadway-review-texts';
const PUBLIC_REPO_OWNER = 'thomaspryor';
const PUBLIC_REPO_NAME = 'Broadwayscore';
const REBUILD_WORKFLOW = 'rebuild-fast.yml';
// LLM ensemble scoring workflow — dispatched when /ingest writes fullText
// without an explicit score AND no per-outlet score extractor matched the
// pasted text. Lost Boys 2026-04-26 Issue #5: the old flow committed
// fullText then dispatched rebuild only, so 16 of 23 reviews never got
// scored and never rendered on the live page.
const SCORING_WORKFLOW = 'llm-ensemble-score.yml';

interface IngestRequest {
  url: string;
  fullText: string;
  // Everything below is optional — auto-detected from URL + fullText if missing.
  showId?: string | null;
  criticName?: string | null;
  publishDate?: string | null;
  humanReviewScore?: number | null;
  originalScore?: string | null;
  forceClearStale?: boolean;
  // When true, commit the file but skip the workflow_dispatch step. The caller
  // (batch mode) will dispatch ONE rebuild via /api/admin/dispatch-rebuild after
  // committing all files, instead of N parallel rebuilds.
  skipDispatch?: boolean;
}

interface IngestResponse {
  success: boolean;
  path?: string;
  outletId?: string;
  criticName?: string;
  showId?: string;
  publishDate?: string | null;
  filename?: string;
  commitSha?: string;
  workflowRunUrl?: string;
  collisionDetail?: unknown;
  error?: string;
  warning?: string;
  detectionWarnings?: string[];
  // Set when byline detection fell back to criticName='Unknown'. Operator
  // should edit the file to set the real critic, then re-rebuild.
  pendingReason?: string;
  // Which workflow was dispatched (rebuild-fast.yml or llm-ensemble-score.yml).
  // Helps the UI show a more accurate "expected time to live" hint.
  dispatchedWorkflow?: string;
  // True when the committed file has neither humanReviewScore nor an
  // extractor-populated originalScore. The batch flow uses this to decide
  // whether the post-batch dispatch should target rebuild-fast.yml (no scoring
  // needed) or llm-ensemble-score.yml (must score before rebuild).
  needsScoring?: boolean;
  // Set when the committed file carries a humanReviewScore (operator-typed
  // OR strong-extractor pre-pass). UI surfaces this as a 🔒 Locked badge in
  // LogRow. Lost Boys 2026-04-27 Gap #6.
  lockedScore?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse<IngestResponse>> {
  if (!isAdmin()) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { success: false, error: 'REVIEW_TEXTS_TOKEN not configured on server' },
      { status: 500 },
    );
  }

  let body: IngestRequest;
  try {
    body = (await request.json()) as IngestRequest;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { url, fullText, originalScore, forceClearStale } = body;
  let humanReviewScore: number | null | undefined = body.humanReviewScore;

  // Only URL and fullText are strictly required on input. Everything else is
  // auto-detected (with caller overrides winning).
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ success: false, error: 'url is required' }, { status: 400 });
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ success: false, error: 'url must be a valid URL' }, { status: 400 });
  }
  if (!fullText || typeof fullText !== 'string' || fullText.trim().length < 50) {
    return NextResponse.json(
      { success: false, error: 'fullText is required (min 50 chars)' },
      { status: 400 },
    );
  }
  if (
    humanReviewScore !== null &&
    humanReviewScore !== undefined &&
    (typeof humanReviewScore !== 'number' || humanReviewScore < 1 || humanReviewScore > 100)
  ) {
    return NextResponse.json(
      { success: false, error: 'humanReviewScore must be a number between 1 and 100' },
      { status: 400 },
    );
  }

  // If the caller sent originalScore (e.g. "5/5 stars") but no explicit
  // humanReviewScore, parse the raw rating to derive the /100 value. The
  // raw string is what gets stored as originalScore; the parsed integer
  // becomes humanReviewScore (the value the rebuild pipeline reads).
  if (
    (humanReviewScore === null || humanReviewScore === undefined) &&
    typeof originalScore === 'string' &&
    originalScore.trim()
  ) {
    const parsed = parseScore(originalScore);
    if (parsed) {
      humanReviewScore = parsed.score;
    }
  }

  // Run auto-detection. Caller-provided values override detection.
  const detected = detectFromReview({ url, fullText });

  const outletId = detected.outletId;
  if (!outletId) {
    return NextResponse.json(
      {
        success: false,
        error: `Unregistered outlet domain for ${url}. Add it to data/outlet-registry.json before ingesting.`,
        detectionWarnings: detected.warnings,
      },
      { status: 400 },
    );
  }

  // Issue #2 (Lost Boys 2026-04-26): when byline detection fails, SAVE the
  // pasted content with criticName='Unknown' + pendingReason='no-byline'
  // instead of rejecting. The old flow discarded 4 of 11 reviews tonight when
  // theatrely / thewrap / nysun / slantmagazine bylines didn't match the
  // regex; the operator had to find and re-paste each one. Now: every paste
  // commits, the operator can fix the byline later.
  const explicitCritic = body.criticName?.trim();
  const detectedCritic = detected.criticName;
  let criticName: string = explicitCritic || detectedCritic || '';
  let bylineFallback = false;
  if (!criticName) {
    criticName = 'Unknown';
    bylineFallback = true;
  }

  const showId = (body.showId?.trim()) || detected.showId;
  if (!showId) {
    return NextResponse.json(
      {
        success: false,
        error: 'Could not auto-detect show from text. Pass showId explicitly.',
        detectionWarnings: detected.warnings,
      },
      { status: 400 },
    );
  }

  const publishDate = body.publishDate || detected.publishDate || null;
  if (publishDate && !/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) {
    return NextResponse.json(
      { success: false, error: 'publishDate must be YYYY-MM-DD' },
      { status: 400 },
    );
  }

  const outletDisplayName = detected.outletDisplayName || outletId;

  // Score-extractor pre-pass (Issue #6): when the operator pastes a review
  // with an explicit star rating in the body but didn't enter the score in
  // the form, run the per-outlet extractor against fullText so originalScore
  // is populated. Without this, rebuild's P0.5 path is empty and the LLM
  // ensemble's body-sentiment guess wins (NYSR Roma Torre ★★★/5 → 76 instead
  // of 60 on 2026-04-26). Skip when the operator already provided a score.
  // Seed values from operator-typed inputs. The extractor pre-pass below
  // (after existingData is loaded) will only run when no typed score and no
  // pre-existing manual score exists on disk, to avoid clobbering the
  // operator's prior manual entry on re-ingest (ship-check 2026-04-27 P1).
  let extractorOriginalScore: string | null = body.originalScore || null;
  let extractorOriginalScoreSource: string | null = body.originalScore
    ? deriveOriginalScoreSource(body.originalScore)
    : null;

  // When byline detection failed, embed a short URL hash in the filename so
  // multiple unknown-byline reviews from the same outlet don't collide on
  // `outlet--unknown.json`. Operator can rename later via the manual flow.
  let filename: string;
  if (bylineFallback) {
    const hash = crypto
      .createHash('sha1')
      .update(url)
      .digest('hex')
      .slice(0, 6);
    filename = `${normalizeOutlet(outletId)}--unknown-${hash}.json`;
  } else {
    filename = generateReviewFilename(outletId, criticName);
  }
  const repoPath = `${showId}/${filename}`;

  // GET existing file (to check for stale-flag collision + capture sha for update).
  let existingFile: { sha: string; content: string } | null = null;
  try {
    existingFile = await githubGetFile(token, PRIVATE_REPO_OWNER, PRIVATE_REPO_NAME, repoPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: `GitHub GET failed: ${msg}` },
      { status: 502 },
    );
  }
  let existingData: Record<string, unknown> | null = null;
  let existingSha: string | undefined;
  if (existingFile) {
    existingSha = existingFile.sha;
    try {
      const decoded = Buffer.from(existingFile.content, 'base64').toString('utf-8');
      existingData = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      existingData = null;
    }
  }

  // Score-extractor pre-pass (Issue #6 + ship-check 2026-04-27 P1). Runs
  // when:
  //   (a) operator did NOT type a score AND did NOT pre-set humanReviewScore,
  //   (b) existing file has no humanReviewScore AND no originalScore from
  //       a manual source — never clobber a prior manual entry on re-ingest.
  // Without (b) the second submission of the same review (e.g. operator
  // editing the byline post-ingest) would re-extract from fullText and could
  // overwrite a previously-correct score with a different extractor read,
  // OR null it out if the operator pasted a different excerpt that lacks
  // the rating. Gate is conservative: any pre-existing originalScore
  // (regardless of source) wins, since the operator can re-extract by
  // explicitly typing a new score.
  const existingHasManualScore = !!(
    existingData &&
    (
      (typeof existingData.humanReviewScore === 'number' &&
        existingData.humanReviewScore >= 1 &&
        existingData.humanReviewScore <= 100) ||
      (typeof existingData.originalScore === 'string' &&
        existingData.originalScore.trim().length > 0)
    )
  );
  if (
    !extractorOriginalScore &&
    humanReviewScore == null &&
    !existingHasManualScore
  ) {
    try {
      const extracted = extractScore('', fullText, outletId);
      // Only accept extractor hits when:
      //   (a) score is in the 1-100 range (matches the input validator above),
      //   (b) source is in OUTLET_VERIFIED_SOURCES — text-only generic
      //       fallthrough has no positional anchor and can FP on quoted
      //       critic mentions or pull-quotes. The canonical list lives in
      //       score-extractors.js; importing it here keeps the whitelist in
      //       sync as new outlet extractors are added (Codex ship-check
      //       2026-04-27 P1: previous local STRONG_EXTRACTOR_SOURCES list
      //       missed ~19 outlet-anchored sources).
      if (
        extracted &&
        Number.isFinite(extracted.normalizedScore) &&
        extracted.normalizedScore >= 1 &&
        extracted.normalizedScore <= 100 &&
        isTrustedExtractorSource(extracted.source)
      ) {
        extractorOriginalScore = extracted.originalScore;
        extractorOriginalScoreSource = extracted.source;
        humanReviewScore = extracted.normalizedScore;
      }
    } catch {
      // Extractor errors should never block ingest. Fall through; LLM
      // ensemble dispatch (below) will score from fullText instead.
    }
  }

  // Collision check — Beaches 2026-04-22 failure mode. Stale wrongProduction flag
  // on existing file + different URL means the new review will be silently dropped.
  if (existingData && !forceClearStale) {
    const hasStaleFlag =
      existingData.wrongProduction === true ||
      existingData.wrongShow === true ||
      existingData.wrongProductionAutoCleared === true;
    const existingUrl = typeof existingData.url === 'string' ? existingData.url : null;
    const urlsDiffer = existingUrl && normalizeUrl(existingUrl) !== normalizeUrl(url);
    if (hasStaleFlag && urlsDiffer) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Stale-flag collision: an existing review file for this outlet+critic has a wrongProduction/wrongShow flag on a DIFFERENT URL. Set forceClearStale=true to override (verify the existing file is actually for a different production first).',
          collisionDetail: {
            existingUrl,
            incomingUrl: url,
            existingFlags: {
              wrongProduction: existingData.wrongProduction === true,
              wrongShow: existingData.wrongShow === true,
              wrongProductionAutoCleared: existingData.wrongProductionAutoCleared === true,
            },
            existingPublishDate: existingData.publishDate || null,
          },
        },
        { status: 409 },
      );
    }
  }

  // Build the review JSON. Merge with existing (preserves bwwExcerpt, dtliExcerpt,
  // etc.) so we don't clobber aggregator-discovered fields.
  const coreFields: Record<string, unknown> = {
    showId,
    outletId,
    outlet: outletDisplayName,
    criticName: criticName.trim(),
    url,
    source: 'admin-ingest-ui',
    ingestedAt: new Date().toISOString(),
  };
  if (bylineFallback) {
    coreFields.pendingReason = 'no-byline';
  }
  const manualFields = buildManualReviewFields({
    humanScore: humanReviewScore ?? null,
    fullText,
    originalScore: extractorOriginalScore,
    originalScoreSource: extractorOriginalScoreSource,
    publishDate,
  });

  const merged: Record<string, unknown> = {
    ...(existingData || {}),
    ...coreFields,
    ...manualFields,
  };

  // Issue #10 (Lost Boys 2026-04-26) — clear stale keyPhrases on tier change.
  // When /ingest writes humanReviewScore and the existing file has
  // llmScore.score in a DIFFERENT bucket, the existing llmScore.keyPhrases
  // were selected to support the old bucket and now mismatch the new
  // sentiment. Drop them so rebuild's pullquote-selection chain falls through
  // to llmPullQuote / pullQuote / aggregator excerpts / fullText slice
  // instead of rendering a negative phrase on a now-positive review (Helen
  // Shaw NYT, locked at 78 with a Mixed-bucket pullquote). Same-bucket writes
  // keep keyPhrases — they're still relevant.
  if (
    typeof humanReviewScore === 'number' &&
    humanReviewScore >= 1 &&
    humanReviewScore <= 100 &&
    existingData &&
    typeof existingData.llmScore === 'object' &&
    existingData.llmScore !== null
  ) {
    const existingLlm = existingData.llmScore as Record<string, unknown>;
    const existingScore = typeof existingLlm.score === 'number' ? existingLlm.score : null;
    const existingKeyPhrases = existingLlm.keyPhrases;
    if (
      existingScore !== null &&
      Array.isArray(existingKeyPhrases) &&
      existingKeyPhrases.length > 0 &&
      scoreToBucket(existingScore) !== scoreToBucket(humanReviewScore)
    ) {
      const mergedLlm = { ...((merged.llmScore as Record<string, unknown>) || existingLlm) };
      delete mergedLlm.keyPhrases;
      merged.llmScore = mergedLlm;
      merged.keyPhrasesCleared = {
        clearedAt: new Date().toISOString(),
        reason: 'tier-change',
        oldBucket: scoreToBucket(existingScore),
        newBucket: scoreToBucket(humanReviewScore),
      };
    }
  }

  const content = JSON.stringify(merged, null, 2) + '\n';
  const base64Content = Buffer.from(content, 'utf-8').toString('base64');

  // PUT to private repo.
  const commitMessage = `data: Ingest ${outletId} / ${normalizeCritic(criticName)} for ${showId} (admin UI)`;
  const putResult = await githubPutFile(
    token,
    PRIVATE_REPO_OWNER,
    PRIVATE_REPO_NAME,
    repoPath,
    base64Content,
    commitMessage,
    existingSha,
  );
  if (!putResult.ok) {
    return NextResponse.json(
      { success: false, error: `GitHub PUT failed: ${putResult.error}` },
      { status: 502 },
    );
  }

  // Dispatch decision (Lost Boys 2026-04-26 Issue #5) — UNLESS the caller
  // asked us to skip (batch mode commits N files then dispatches once at the
  // end via /api/admin/dispatch-rebuild).
  //
  // Two paths:
  //   - File has a score on disk (humanReviewScore set OR extractor pre-pass
  //     populated originalScore) → dispatch rebuild-fast.yml. ~5 min to live.
  //   - File has fullText but no score → dispatch llm-ensemble-score.yml with
  //     show_id + fast_rebuild=true. The scoring workflow writes
  //     llmScore.score then chains rebuild-fast.yml. ~15-20 min to live, but
  //     the live page won't render the review at all if we skip this step.
  //     Pre-fix, /ingest dispatched rebuild-fast only and 16 of 23 reviews
  //     stayed unscored across the wave.
  const fileHasScore =
    (typeof humanReviewScore === 'number' && humanReviewScore >= 1 && humanReviewScore <= 100) ||
    !!extractorOriginalScore;

  let workflowRunUrl: string | undefined;
  let dispatchWarning: string | undefined;
  let dispatchedWorkflow: string | undefined;
  if (!body.skipDispatch) {
    if (fileHasScore) {
      const dispatchResult = await githubDispatchWorkflow(
        token,
        PUBLIC_REPO_OWNER,
        PUBLIC_REPO_NAME,
        REBUILD_WORKFLOW,
        { reason: `admin-ingest-ui: ${showId} / ${outletId}` },
      );
      dispatchedWorkflow = REBUILD_WORKFLOW;
      workflowRunUrl = dispatchResult.ok
        ? `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${REBUILD_WORKFLOW}`
        : undefined;
      dispatchWarning = dispatchResult.ok
        ? undefined
        : `Review committed but rebuild dispatch failed: ${dispatchResult.error}. Manually trigger via: gh workflow run "Rebuild Reviews (Fast)"`;
    } else {
      const dispatchResult = await githubDispatchWorkflow(
        token,
        PUBLIC_REPO_OWNER,
        PUBLIC_REPO_NAME,
        SCORING_WORKFLOW,
        {
          show_id: showId,
          fast_rebuild: 'true',
          run_calibration: 'false',
          run_validation: 'false',
          // Per-show concurrency lane (ship-check 2026-04-27 P0). The
          // workflow's group is `scoring-reviews${rescore_reason}` —
          // without a per-show suffix every /ingest dispatch queues into
          // the same default group and serializes. Two operators ingesting
          // different shows in parallel would block each other up to the
          // 350-min job timeout, defeating the <20-min fast-path SLA.
          rescore_reason: `admin-ingest-${showId}`,
        },
      );
      dispatchedWorkflow = SCORING_WORKFLOW;
      workflowRunUrl = dispatchResult.ok
        ? `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${SCORING_WORKFLOW}`
        : undefined;
      dispatchWarning = dispatchResult.ok
        ? undefined
        : `Review committed but LLM scoring dispatch failed: ${dispatchResult.error}. Manually trigger via: gh workflow run "LLM Ensemble Score Reviews" -f show_id=${showId} -f fast_rebuild=true`;
    }
  }

  return NextResponse.json({
    success: true,
    path: `data/review-texts/${repoPath}`,
    outletId,
    criticName: criticName.trim(),
    showId,
    publishDate,
    filename,
    commitSha: putResult.commitSha,
    workflowRunUrl,
    warning:
      dispatchWarning ||
      (bylineFallback
        ? `Saved with criticName='Unknown' (no byline detected). Edit the file at data/review-texts/${repoPath} to set criticName, then re-rebuild.`
        : undefined),
    detectionWarnings: detected.warnings.length > 0 ? detected.warnings : undefined,
    pendingReason: bylineFallback ? 'no-byline' : undefined,
    dispatchedWorkflow,
    needsScoring: !fileHasScore,
    lockedScore:
      typeof humanReviewScore === 'number' && humanReviewScore >= 1 && humanReviewScore <= 100
        ? humanReviewScore
        : undefined,
  });
}

// ─── GitHub API helpers (with retry) ────────────────────────────────

const GH_API_BASE = 'https://api.github.com';
const GH_HEADERS = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'broadwayscorecard-admin-ingest',
});

// fetchWithRetry — 3 attempts (200ms / 500ms / 1s backoff) on transient failures.
//
// Retried: 5xx, 429, network errors (fetch throws).
// NOT retried: 4xx user errors (auth, conflict, validation) — surface immediately.
//   404 specifically is returned as-is so callers (githubGetFile) can treat
//   "missing file" as a normal case.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [200, 500, 1000];
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry on 5xx and 429 (rate limit). Everything else is final.
      if (res.status >= 500 || res.status === 429) {
        if (attempt < delays.length) {
          await sleep(delays[attempt]);
          continue;
        }
      }
      return res;
    } catch (err) {
      // Network-level failure (DNS, socket, abort). Retryable.
      lastError = err;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw err;
    }
  }
  // Exhausted retries — re-throw last network error if we got here from catch.
  if (lastError) throw lastError;
  throw new Error('fetchWithRetry exhausted attempts');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function githubGetFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  const res = await fetchWithRetry(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=main`, {
    headers: GH_HEADERS(token),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { sha: string; content: string };
  return data;
}

async function githubPutFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  base64Content: string,
  message: string,
  sha?: string,
): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    message,
    content: base64Content,
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const res = await fetchWithRetry(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...GH_HEADERS(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${await res.text()}` };
  }
  const json = (await res.json()) as { commit?: { sha?: string } };
  return { ok: true, commitSha: json.commit?.sha || '' };
}

async function githubDispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetchWithRetry(
    `${GH_API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: { ...GH_HEADERS(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs }),
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${await res.text()}` };
  }
  return { ok: true };
}

function deriveOriginalScoreSource(raw: string): string {
  const parsed = parseScore(raw);
  if (!parsed) return 'manual-admin-ui';
  return `manual-${parsed.type}`; // 'manual-stars' | 'manual-letter' | 'manual-numeric'
}

// Trust gate for extractor pre-pass at /ingest time. Delegates to the
// canonical OUTLET_VERIFIED_SOURCES set in scripts/lib/score-extractors.js,
// which is the same set used elsewhere in the codebase to label scores as
// "outlet-verified" (see rebuild-helpers.js getBestScore P0.5). Importing
// keeps this in sync as new outlet-anchored extractors are added — the
// previous local STRONG_EXTRACTOR_SOURCES list missed ~19 trustworthy
// outlet-specific sources (Codex ship-check 2026-04-27 P1).
//
// We also keep `unicode-stars-fallthrough` even though it's not in
// OUTLET_VERIFIED_SOURCES — it's the KNOWN_STAR_OUTLETS anchored fallback
// in extractScore() and is positionally safe (first/last 15% only). All
// other generic text-pattern / og-description / wp-api-title sources ARE
// excluded because they have no positional anchor when /ingest passes
// html='' and can FP on quoted critic mentions or page chrome.
function isTrustedExtractorSource(source: string | undefined | null): boolean {
  if (!source) return false;
  if (OUTLET_VERIFIED_SOURCES.has(source)) return true;
  // KNOWN_STAR_OUTLETS anchored fallthrough emits this source — anchored
  // to first/last 15% of text, safe.
  if (source === 'unicode-stars-fallthrough') return true;
  return false;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    const paramKeys = Array.from(u.searchParams.keys());
    for (const k of paramKeys) {
      if (/^utm_|^fbclid$|^triedRedirect$|^ref$|^mc_eid$/.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).toLowerCase().replace(/\/$/, '');
  }
}
