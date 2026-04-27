import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { createRequire } from 'module';

// Imported the same way ingest-review/route.ts imports CommonJS helpers — keeps
// score-bucket logic in lockstep with the canonical extractor module.
const cjsRequire = createRequire(import.meta.url);
const { scoreToBucket } = cjsRequire('../../../../../scripts/lib/score-extractors') as {
  scoreToBucket: (score: number) => string;
};
const { normalizeOutlet, normalizeCritic, generateReviewFilename } = cjsRequire(
  '../../../../../scripts/lib/review-normalization',
) as {
  normalizeOutlet: (outlet: string) => string;
  normalizeCritic: (name: string) => string;
  generateReviewFilename: (outlet: string, critic: string) => string;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PRIVATE_REPO_OWNER = 'thomaspryor';
const PRIVATE_REPO_NAME = 'broadway-review-texts';
const PUBLIC_REPO_OWNER = 'thomaspryor';
const PUBLIC_REPO_NAME = 'Broadwayscore';
const REBUILD_WORKFLOW = 'rebuild-fast.yml';

// Default lock-protection union. The operator-supplied protectedFields[] (if
// any) extends this; nothing here is dropped.
const DEFAULT_LOCK_PROTECTED_FIELDS = [
  'humanReviewScore',
  'humanReviewScoreProvisional',
  'assignedScore',
  'llmScore',
  'lockedReason',
  'lockedAt',
  'lockedBy',
  'lockedAcrossTier',
  'priorScoreAtLock',
];

const MIN_REASON_LENGTH = 20;

interface LockRequestBody {
  showId: string;
  outletId: string;
  criticName: string;
  // Required for action='lock' and 'edit-reason'. Ignored for 'unlock'.
  score?: number;
  // Required for action='lock' and 'edit-reason'. Min 20 chars (forces real
  // rationale, not "see slack" or "ok").
  reason?: string;
  // Optional: extra fields to add to the file's protectedFields[] beyond the
  // default lock list. Useful when the lock is paired with a custom flag.
  protectedFields?: string[];
  // Default 'lock'. 'unlock' removes lock fields + rebuild. 'edit-reason' updates
  // lockedReason without changing the score (lockedAt stays the same; we add
  // lockedReasonUpdatedAt so audit trail shows the edit).
  action?: 'lock' | 'unlock' | 'edit-reason';
  // Optional override for the on-disk filename. /admin/locks passes the
  // filename from locks.json directly so UI edit/unlock works for files
  // whose filename doesn't round-trip through generateReviewFilename
  // (criticName edits, slug typos, year-suffixed slugs). 4/217 locks in
  // the catalog as of 2026-04-27. Validated: must match the
  // outletId--*.json convention so a malicious caller can't traverse.
  filename?: string;
}

interface LockResponseBody {
  success: boolean;
  showId?: string;
  outletId?: string;
  criticName?: string;
  filename?: string;
  lockedScore?: number;
  priorScore?: number | null;
  lockedReason?: string | null;
  lockedAt?: string | null;
  lockedBy?: string | null;
  lockedAcrossTier?: boolean | null;
  // True when the lock crossed a tier boundary AND we cleared
  // llmScore.keyPhrases + pullQuote so rebuild's pullquote chain doesn't
  // render a stale-tier excerpt (Lost Boys Helen Shaw case).
  pullquoteCleared?: boolean;
  workflowRunUrl?: string;
  commitSha?: string;
  warning?: string;
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<LockResponseBody>> {
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

  let body: LockRequestBody;
  try {
    body = (await request.json()) as LockRequestBody;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const action: 'lock' | 'unlock' | 'edit-reason' = body.action || 'lock';

  // Common required fields.
  const showId = (body.showId || '').trim();
  const outletId = (body.outletId || '').trim();
  const criticName = (body.criticName || '').trim();
  if (!showId) return NextResponse.json({ success: false, error: 'showId is required' }, { status: 400 });
  if (!outletId) return NextResponse.json({ success: false, error: 'outletId is required' }, { status: 400 });
  if (!criticName) {
    return NextResponse.json({ success: false, error: 'criticName is required' }, { status: 400 });
  }

  if (action === 'lock' || action === 'edit-reason') {
    if (
      typeof body.score !== 'number' ||
      !Number.isFinite(body.score) ||
      body.score < 1 ||
      body.score > 100
    ) {
      return NextResponse.json(
        { success: false, error: 'score must be a number between 1 and 100' },
        { status: 400 },
      );
    }
    const reason = (body.reason || '').trim();
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: `reason is required (min ${MIN_REASON_LENGTH} chars). Capture WHY this score is locked so the audit trail makes sense in 30 days.`,
        },
        { status: 400 },
      );
    }
  }

  // Filename override (validated): caller can pass the canonical filename
  // from locks.json for files whose criticName -> filename round-trip is
  // lossy. Constraints:
  //   - must match /^[a-z0-9-]+--[a-z0-9-]+\.json$/ (no path traversal)
  //   - the outletId prefix segment must equal the body's outletId (after
  //     normalizeOutlet) so a UI bug can't accidentally retarget to a
  //     different outlet's file
  //   - the critic suffix segment must equal normalizeCritic(criticName) for
  //     a regenerated filename — a malicious payload like
  //     {filename: 'nytimes--jesse-green.json', criticName: 'Helen Shaw'}
  //     would otherwise commit to Jesse Green's file with a Helen Shaw
  //     commit message (ship-check 2026-04-27 P1 #2).
  let filename: string;
  if (typeof body.filename === 'string' && body.filename.trim()) {
    const candidate = body.filename.trim();
    if (!/^[a-z0-9][a-z0-9-]*--[a-z0-9-]+\.json$/.test(candidate)) {
      return NextResponse.json(
        { success: false, error: 'filename must match outlet-slug--critic-slug.json' },
        { status: 400 },
      );
    }
    const candidateOutletPrefix = candidate.split('--')[0];
    if (candidateOutletPrefix !== normalizeOutlet(outletId)) {
      return NextResponse.json(
        {
          success: false,
          error: `filename outlet prefix "${candidateOutletPrefix}" does not match body outletId "${normalizeOutlet(outletId)}"`,
        },
        { status: 400 },
      );
    }
    // The expected filename for the body's criticName via the canonical
    // helper. If `candidate` differs, that's allowed (lossy round-trips
    // exist for ~4/217 catalog files), but we record the expected slug for
    // diagnostics and require the candidate's critic suffix start with the
    // expected prefix OR end with it (handles 'scott-lipton' filename for
    // 'Brian Scott Lipton' criticName, the proof-2026 case).
    const expectedSlug = generateReviewFilename(outletId, criticName).replace('.json', '');
    const expectedCriticSuffix = expectedSlug.split('--')[1] || '';
    const candidateCriticSuffix = candidate.replace('.json', '').split('--')[1] || '';
    // Allowed: exact match (213/217 catalog files), startsWith (year-suffix
    // filenames like matthew-wexler-2026), endsWith (filename omits a leading
    // name like brian-scott-lipton). Rejected: totally different critic
    // (e.g. nydailynews--fintan-otoole.json with criticName 'Rebecca Paller'
    // — pre-existing corruption that this UI shouldn't help re-write).
    // Initials-style abbreviations (p-l-rose vs paul-lawrence-rose, 1
    // catalog case) are also rejected — operator must edit those files
    // directly via gh api PUT.
    const isAcceptableMatch =
      candidateCriticSuffix.length > 0 &&
      expectedCriticSuffix.length > 0 &&
      (
        candidateCriticSuffix === expectedCriticSuffix ||
        candidateCriticSuffix.startsWith(expectedCriticSuffix + '-') ||
        expectedCriticSuffix.startsWith(candidateCriticSuffix + '-') ||
        candidateCriticSuffix.endsWith('-' + expectedCriticSuffix) ||
        expectedCriticSuffix.endsWith('-' + candidateCriticSuffix)
      );
    if (!isAcceptableMatch) {
      return NextResponse.json(
        {
          success: false,
          error: `filename critic suffix "${candidateCriticSuffix}" does not match body criticName "${criticName}" (expected "${expectedCriticSuffix}"). Refusing to write to a file whose critic doesn't match.`,
        },
        { status: 400 },
      );
    }
    filename = candidate;
  } else {
    filename = generateReviewFilename(outletId, criticName);
  }
  const repoPath = `${showId}/${filename}`;

  // GET existing file (must exist for lock/unlock/edit-reason — we never create
  // a fresh file here; that's /api/admin/ingest-review's job).
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
  if (!existingFile) {
    return NextResponse.json(
      {
        success: false,
        error: `Review file not found: data/review-texts/${repoPath}. Ingest the review via /admin/ingest first, then lock the score.`,
      },
      { status: 404 },
    );
  }

  let existingData: Record<string, unknown>;
  try {
    const decoded = Buffer.from(existingFile.content, 'base64').toString('utf-8');
    existingData = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Existing file is not valid JSON; manual cleanup required.' },
      { status: 500 },
    );
  }

  const operatorEmail = process.env.ADMIN_OPERATOR_EMAIL || 'admin@broadwayscorecard.com';
  const nowIso = new Date().toISOString();

  let pullquoteCleared = false;
  let lockedAcrossTier: boolean | null = null;
  let priorScore: number | null = null;
  let merged: Record<string, unknown>;
  let commitMessage: string;

  if (action === 'unlock') {
    merged = { ...existingData };
    delete merged.humanReviewScore;
    delete merged.humanReviewScoreProvisional;
    delete merged.lockedReason;
    delete merged.lockedAt;
    delete merged.lockedBy;
    delete merged.lockedAcrossTier;
    delete merged.priorScoreAtLock;
    // Edit-trail keys (set by edit-reason action) become orphaned without
    // their parent lock — drop them too. Ship-check 2026-04-27 P2.
    delete merged.lockedReasonUpdatedAt;
    delete merged.lockedReasonUpdatedBy;
    // Drop lock-only entries from protectedFields. Anything else the operator
    // pinned (pullQuote, allowEarlyDate, etc.) stays.
    if (Array.isArray(existingData.protectedFields)) {
      merged.protectedFields = (existingData.protectedFields as string[]).filter(
        (f) => !DEFAULT_LOCK_PROTECTED_FIELDS.includes(f),
      );
      if ((merged.protectedFields as string[]).length === 0) delete merged.protectedFields;
    }
    commitMessage = `data: Unlock score for ${outletId} / ${normalizeCritic(criticName)} on ${showId}`;
  } else {
    // action === 'lock' OR 'edit-reason'.
    const score = body.score as number;
    const reason = (body.reason as string).trim();

    const existingLlm =
      existingData.llmScore && typeof existingData.llmScore === 'object'
        ? (existingData.llmScore as Record<string, unknown>)
        : null;
    const existingLlmScore =
      existingLlm && typeof existingLlm.score === 'number' ? (existingLlm.score as number) : null;

    // edit-reason MUST NOT mutate the score. Form disables the score input
    // in edit mode but a malicious or misconfigured caller could submit a
    // score that differs from the on-disk humanReviewScore. Rejecting here
    // forces the caller through unlock→lock for an actual score change,
    // which keeps the audit trail honest (separate lockedAt for the score
    // change vs the rationale revision). Ship-check 2026-04-27 P0 #2.
    if (action === 'edit-reason') {
      const existingHumanScore =
        typeof existingData.humanReviewScore === 'number'
          ? (existingData.humanReviewScore as number)
          : null;
      if (existingHumanScore === null || existingHumanScore !== score) {
        return NextResponse.json(
          {
            success: false,
            error: `edit-reason cannot change the score. existing=${existingHumanScore}, requested=${score}. Unlock and re-lock for a score change.`,
          },
          { status: 400 },
        );
      }
    }

    // Sticky priorScoreAtLock — capture the MODEL's score on the FIRST lock
    // and never overwrite it on subsequent re-locks. Without sticky semantics,
    // the second lock would record the previous lock's value as `priorScore`
    // (because rebuild's getBestScore returns humanReviewScore at P0 and
    // llm-ensemble-score skips human-locked files, so existingLlm.score IS
    // the prior locked score on every re-lock). The audit trail loses "what
    // did the model think before any human touched this" the moment anyone
    // re-locks. Ship-check 2026-04-27 P0 #3.
    const stickyPriorScore =
      typeof existingData.priorScoreAtLock === 'number'
        ? (existingData.priorScoreAtLock as number)
        : existingLlmScore;
    priorScore = stickyPriorScore;

    if (action === 'lock') {
      // Tier-cross detection compares against the sticky prior (the model's
      // original read), not the prior-lock value, so re-locks across the
      // same tier boundary still flip lockedAcrossTier correctly.
      const priorForBucket =
        stickyPriorScore !== null
          ? stickyPriorScore
          : typeof existingData.assignedScore === 'number'
            ? (existingData.assignedScore as number)
            : null;
      lockedAcrossTier =
        priorForBucket !== null ? scoreToBucket(priorForBucket) !== scoreToBucket(score) : false;
    } else {
      // edit-reason: keep the prior lockedAcrossTier on disk; we're not
      // changing the score, only the rationale.
      lockedAcrossTier =
        typeof existingData.lockedAcrossTier === 'boolean'
          ? (existingData.lockedAcrossTier as boolean)
          : null;
    }

    const mergedLlm: Record<string, unknown> = existingLlm ? { ...existingLlm } : {};
    if (action === 'lock') {
      mergedLlm.score = score;
      // When the lock crosses a tier, drop the keyPhrases that were selected
      // for the old bucket — they'll mismatch the new sentiment. Same fix
      // pattern as ingest-review/route.ts Issue #10. pullQuote follows for
      // the same reason: a Mixed-bucket pull-quote on a now-Positive review
      // misleads readers (Helen Shaw 2026-04-26).
      if (lockedAcrossTier === true && Array.isArray(mergedLlm.keyPhrases) && mergedLlm.keyPhrases.length > 0) {
        delete mergedLlm.keyPhrases;
        pullquoteCleared = true;
      }
    }

    merged = {
      ...existingData,
      humanReviewScore: score,
      humanReviewScoreProvisional: false,
      assignedScore: score,
      llmScore: mergedLlm,
    };

    if (action === 'lock') {
      merged.lockedReason = reason;
      merged.lockedAt = nowIso;
      merged.lockedBy = operatorEmail;
      merged.lockedAcrossTier = lockedAcrossTier === true;
      // Sticky-once: only set priorScoreAtLock if not already on disk.
      // Subsequent re-locks preserve the original-model-score signal.
      if (stickyPriorScore !== null && typeof existingData.priorScoreAtLock !== 'number') {
        merged.priorScoreAtLock = stickyPriorScore;
      }
    } else {
      // edit-reason — preserve original lockedAt + lockedBy but stamp an edit.
      merged.lockedReason = reason;
      merged.lockedReasonUpdatedAt = nowIso;
      merged.lockedReasonUpdatedBy = operatorEmail;
    }

    if (action === 'lock' && pullquoteCleared) {
      merged.pullQuote = '';
      merged.pullQuoteSource = null;
    }

    // Merge protectedFields: prior + default lock list + caller extras.
    const priorPF = Array.isArray(existingData.protectedFields)
      ? (existingData.protectedFields as string[])
      : [];
    const callerPF =
      Array.isArray(body.protectedFields) && body.protectedFields.every((f) => typeof f === 'string')
        ? (body.protectedFields as string[])
        : [];
    merged.protectedFields = Array.from(
      new Set([...priorPF, ...DEFAULT_LOCK_PROTECTED_FIELDS, ...callerPF]),
    );

    commitMessage =
      action === 'lock'
        ? `data: Lock score ${score} for ${outletId} / ${normalizeCritic(criticName)} on ${showId}`
        : `data: Edit lock reason for ${outletId} / ${normalizeCritic(criticName)} on ${showId}`;
  }

  const content = JSON.stringify(merged, null, 2) + '\n';
  const base64Content = Buffer.from(content, 'utf-8').toString('base64');

  const putResult = await githubPutFile(
    token,
    PRIVATE_REPO_OWNER,
    PRIVATE_REPO_NAME,
    repoPath,
    base64Content,
    commitMessage,
    existingFile.sha,
  );
  if (!putResult.ok) {
    return NextResponse.json(
      { success: false, error: `GitHub PUT failed: ${putResult.error}` },
      { status: 502 },
    );
  }

  // Always dispatch rebuild — score change OR pullquote-clear OR unlock all
  // produce a different reviews.json entry that needs to ship.
  const dispatchResult = await githubDispatchWorkflow(
    token,
    PUBLIC_REPO_OWNER,
    PUBLIC_REPO_NAME,
    REBUILD_WORKFLOW,
    { reason: `admin-lock-score: ${action} ${showId} / ${outletId} / ${normalizeCritic(criticName)}` },
  );
  const workflowRunUrl = dispatchResult.ok
    ? `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${REBUILD_WORKFLOW}`
    : undefined;
  const dispatchWarning = dispatchResult.ok
    ? undefined
    : `${action} committed but rebuild dispatch failed: ${dispatchResult.error}. Manually trigger via: gh workflow run "Rebuild Reviews (Fast)"`;

  if (action === 'unlock') {
    return NextResponse.json({
      success: true,
      showId,
      outletId: normalizeOutlet(outletId),
      criticName,
      filename,
      commitSha: putResult.commitSha,
      workflowRunUrl,
      warning: dispatchWarning,
    });
  }

  return NextResponse.json({
    success: true,
    showId,
    outletId: normalizeOutlet(outletId),
    criticName,
    filename,
    lockedScore: body.score as number,
    priorScore,
    lockedReason: (body.reason as string).trim(),
    lockedAt: action === 'lock' ? nowIso : (typeof existingData.lockedAt === 'string' ? existingData.lockedAt : null),
    lockedBy: action === 'lock' ? operatorEmail : (typeof existingData.lockedBy === 'string' ? existingData.lockedBy : null),
    lockedAcrossTier,
    pullquoteCleared,
    workflowRunUrl,
    commitSha: putResult.commitSha,
    warning: dispatchWarning,
  });
}

// ─── GitHub helpers (mirror ingest-review/route.ts) ─────────────────

const GH_API_BASE = 'https://api.github.com';
const GH_HEADERS = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'broadwayscorecard-admin-lock',
});

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [200, 500, 1000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        if (attempt < delays.length) {
          await sleep(delays[attempt]);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw lastError;
  throw new Error('fetchWithRetry exhausted attempts');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubGetFile(
  token: string,
  owner: string,
  repo: string,
  pathSegment: string,
): Promise<{ sha: string; content: string } | null> {
  const res = await fetchWithRetry(
    `${GH_API_BASE}/repos/${owner}/${repo}/contents/${pathSegment}?ref=main`,
    { headers: GH_HEADERS(token), cache: 'no-store' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ${pathSegment} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { sha: string; content: string };
}

async function githubPutFile(
  token: string,
  owner: string,
  repo: string,
  pathSegment: string,
  base64Content: string,
  message: string,
  sha: string,
): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  const res = await fetchWithRetry(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${pathSegment}`, {
    method: 'PUT',
    headers: { ...GH_HEADERS(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: base64Content, branch: 'main', sha }),
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
