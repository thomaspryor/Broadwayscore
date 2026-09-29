import { NextRequest, NextResponse } from 'next/server';
import { getFirstInvalidField } from '@/lib/feedback-form-validation';
import { createNotionPage } from '@/lib/notion-api';
import { isMalformedFeedbackPayload, buildFeedbackNotionProperties } from '@/lib/notion-feedback-integration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Best-effort secondary destination — keeps the existing process-feedback.yml
// AI bug-diagnosis pipeline (polls Formspree, auto-files GitHub issues) alive
// alongside the new direct Notion write. Same endpoint feedback/page.tsx used
// as its `endpoint` default before this route existed.
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

    // Notion is purely additive and best-effort: a missing key or a failed
    // write must never fail a request, and its success never substitutes for
    // Formspree's — the automated pipeline doesn't read Notion (BRO-3379).
    const notionKey = process.env.NOTION_API_KEY;
    if (notionKey) {
      const properties = buildFeedbackNotionProperties({
        ...fields,
        submittedAt: new Date().toISOString(),
      });
      try {
        await createNotionPage(properties, notionKey);
      } catch (err) {
        console.error('Notion feedback create failed (non-fatal):', (err as Error).message);
      }
    } else {
      console.error('NOTION_API_KEY not configured (non-fatal)');
    }

    if (!formspreeOk) {
      return NextResponse.json(
        { errors: [{ message: 'Something went wrong submitting your feedback. Please try again.' }] },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('feedback route error:', err);
    return NextResponse.json(
      { errors: [{ message: 'Something went wrong. Please try again.' }] },
      { status: 500 }
    );
  }
}
