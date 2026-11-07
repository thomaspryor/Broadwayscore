import { NextRequest } from 'next/server';

// Shared by the owner-decision confirm page and the list page (BRO-6147, BRO-6235).

const LINEAR_URL = 'https://api.linear.app/graphql';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://raw.githubusercontent.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function page(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(title)} - Broadway Scorecard</title>
<style>
body{margin:0;padding:20px 16px 40px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5}
main{max-width:480px;margin:0 auto}
h1{font-size:22px;margin:0 0 12px}
p{color:rgba(255,255,255,.78);font-size:16px;margin:0 0 14px}
.q{font-size:18px;color:#fff;font-weight:600}
.box{background:#1a1a22;border:1px solid #2c2c38;border-radius:12px;padding:14px;margin:0 0 14px}
.small{font-size:14px;color:rgba(255,255,255,.6)}
button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-size:17px;font-weight:700;padding:14px 16px;border-radius:10px;border:0;margin:0 0 10px;background:#d4a574;color:#1a1208;cursor:pointer}
a.btn.alt{background:#2c2c38;color:#fff}
textarea{width:100%;box-sizing:border-box;min-height:140px;font-size:16px;padding:12px;border-radius:10px;border:1px solid #444;background:#15151c;color:#fff;margin:0 0 12px}
a{color:#d4a574}
pre{white-space:pre-wrap;word-wrap:break-word;font:inherit;margin:0}
.shot{margin:0 0 12px}
.shot img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid #2c2c38;background:#fff}
.shot figcaption{font-size:13px;color:rgba(255,255,255,.6);margin:4px 0 0}
.opt{margin:0 0 4px;font-weight:700}
.up{color:#7bd88f;font-size:14px;margin:0 0 2px}
.down{color:#ff8f8f;font-size:14px;margin:0 0 8px}
h2{font-size:17px;margin:0 0 6px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

/** Screenshots a visual-approval card carries (BRO-6241). The parser only keeps raw.githubusercontent.com URLs of this repo; esc() covers the rest. */
export function evidenceHtml(evidence: { label: string; url: string }[] | undefined): string {
  if (!evidence || !evidence.length) return '';
  return evidence.slice(0, 8).map((e) => `<figure class="shot"><a href="${esc(e.url)}" rel="noreferrer"><img src="${esc(e.url)}" alt="${esc(e.label)}" loading="lazy"></a><figcaption>${esc(e.label)}</figcaption></figure>`).join('');
}

export function notice(title: string, text: string, status = 200): Response {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, status);
}

export async function linearGraphql(query: string, variables: Record<string, unknown>) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is not set in this deployment');
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Linear: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data;
}

// Best effort only: instances are per-process on Vercel, so the signed token
// is the real control. This just blunts a loop hammering one warm instance.
const hits = new Map<string, number[]>();
export function rateLimited(req: NextRequest): boolean {
  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > 30;
}

