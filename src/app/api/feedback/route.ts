import { NextRequest, NextResponse } from 'next/server';
import { getFirstInvalidField, isMalformedFeedbackPayload } from '@/lib/feedback-form-validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The real consumer: process-feedback.yml polls Formspree for the AI
// bug-diagnosis pipeline (auto-files GitHub issues). The old secondary Notion
// write was removed with the Notion board's retirement (BRO-4717). Same
// endpoint feedback/page.tsx used as its `endpoint` default before this route
// existed.
const FORMSPREE_ENDPOINT = process.env.NEXT_PUBLIC_FORMSPREE_ENDPOINT || 'https://formspree.io/f/mojdjwqo';

// In-memory rate limiting: 5 requests per minute per IP. Same shape as
// src/app/api/submit-review/route.ts — duplicated rather than shared because
// each route's Lambda gets its own module scope anyway, so a shared map
// would not actually coordinate across the two routes.
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

async function forwardToFormspree(formData: FormData): Promise<boolean> {
  try {
    const res = await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      body: formData,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`Formspree forward failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Formspree forward failed (network error):', (err as Error).message);
    return false;
  }
}

const DISPATCH_TIMEOUT_MS = 4000;

// Fire process-feedback.yml. Never throws and never blocks the reader's
// success response for long: the cron picks the submission up if this fails.
async function triggerProcessFeedback(): Promise<void> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token || process.env.FEEDBACK_PROPOSAL_DISABLED === 'true') return;
  try {
    const res = await fetch(
      'https://api.github.com/repos/thomaspryor/Broadwayscore/actions/workflows/process-feedback.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main' }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) console.error(`feedback dispatch failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('feedback dispatch error:', (err as Error).message);
  }
}

export async function POST(req: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { errors: [{ message: 'Malformed request body.' }] },
        { status: 400 }
      );
    }

    const honeypot = (formData.get('_gotcha') as string) || '';
    if (honeypot) {
      return NextResponse.json({ ok: true }); // Silent for bots
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { errors: [{ message: 'Too many submissions. Please wait a minute and try again.' }] },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    const fields = {
      name: ((formData.get('name') as string) || '').trim(),
      email: ((formData.get('email') as string) || '').trim(),
      category: ((formData.get('category') as string) || '').trim(),
      show: ((formData.get('show') as string) || '').trim(),
      message: ((formData.get('message') as string) || '').trim(),
    };

    if (isMalformedFeedbackPayload(fields)) {
      return NextResponse.json(
        { errors: [{ message: 'Malformed request body.' }] },
        { status: 400 }
      );
    }

    const invalidField = getFirstInvalidField(fields);
    if (invalidField) {
      return NextResponse.json(
        { errors: [{ field: invalidField.name, message: invalidField.message }] },
        { status: 400 }
      );
    }

    // Forward to Formspree FIRST — it's the real consumer (process-feedback.yml
    // polls it for the AI bug-diagnosis pipeline), so success is gated on its
    // actual response, not just the fetch resolving (BRO-3382).
    const formspreeOk = await forwardToFormspree(formData);

    if (!formspreeOk) {
      return NextResponse.json(
        { errors: [{ message: 'Something went wrong submitting your feedback. Please try again.' }] },
        { status: 502 }
      );
    }

    // BRO-7847: start the feedback workflow now instead of waiting for the
    // 10-minute cron, so the owner's proposal email lands within minutes. The
    // cron stays as the backstop, so a failed dispatch loses nothing.
    await triggerProcessFeedback();

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('feedback route error:', err);
    return NextResponse.json(
      { errors: [{ message: 'Something went wrong. Please try again.' }] },
      { status: 500 }
    );
  }
}
