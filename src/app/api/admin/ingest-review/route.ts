import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { detectFromReview } from '@/lib/admin-ingest-detect';
import { createRequire } from 'module';

// Import CommonJS helpers from scripts/lib/ — these are the same ones the CLI
// ingest-manual-review.js uses, so the on-disk semantics (protection fields,
// filename normalization) are identical. See memory/feedback_per_file_protected_fields_lock.md.
const cjsRequire = createRequire(import.meta.url);
const { generateReviewFilename, normalizeCritic } = cjsRequire('../../../../../scripts/lib/review-normalization') as {
  generateReviewFilename: (outlet: string, critic: string) => string;
  normalizeCritic: (name: string) => string;
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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PRIVATE_REPO_OWNER = 'thomaspryor';
const PRIVATE_REPO_NAME = 'broadway-review-texts';
const PUBLIC_REPO_OWNER = 'thomaspryor';
const PUBLIC_REPO_NAME = 'Broadwayscore';
const REBUILD_WORKFLOW = 'rebuild-fast.yml';

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

  const { url, fullText, humanReviewScore, originalScore, forceClearStale } = body;

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

  const criticName = (body.criticName?.trim()) || detected.criticName;
  if (!criticName) {
    return NextResponse.json(
      {
        success: false,
        error: 'Could not auto-detect critic from byline. Pass criticName explicitly.',
        detectionWarnings: detected.warnings,
      },
      { status: 400 },
    );
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

  const filename = generateReviewFilename(outletId, criticName);
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
  const coreFields = {
    showId,
    outletId,
    outlet: outletDisplayName,
    criticName: criticName.trim(),
    url,
    source: 'admin-ingest-ui',
    ingestedAt: new Date().toISOString(),
  };
  const manualFields = buildManualReviewFields({
    humanScore: humanReviewScore ?? null,
    fullText,
    originalScore: originalScore || null,
    originalScoreSource: originalScore ? 'manual-admin-ui' : null,
    publishDate,
  });

  const merged: Record<string, unknown> = {
    ...(existingData || {}),
    ...coreFields,
    ...manualFields,
  };

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

  // Dispatch rebuild-fast.yml in the PUBLIC repo.
  const dispatchResult = await githubDispatchWorkflow(
    token,
    PUBLIC_REPO_OWNER,
    PUBLIC_REPO_NAME,
    REBUILD_WORKFLOW,
    { reason: `admin-ingest-ui: ${showId} / ${outletId}` },
  );

  const workflowRunUrl = dispatchResult.ok
    ? `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${REBUILD_WORKFLOW}`
    : undefined;

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
    warning: dispatchResult.ok
      ? undefined
      : `Review committed but rebuild dispatch failed: ${dispatchResult.error}. Manually trigger via: gh workflow run "Rebuild Reviews (Fast)"`,
    detectionWarnings: detected.warnings.length > 0 ? detected.warnings : undefined,
  });
}

// ─── GitHub API helpers ─────────────────────────────────────────────

const GH_API_BASE = 'https://api.github.com';
const GH_HEADERS = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'broadwayscorecard-admin-ingest',
});

async function githubGetFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  const res = await fetch(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=main`, {
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

  const res = await fetch(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
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
  const res = await fetch(
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
