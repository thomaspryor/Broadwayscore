/**
 * Minimal Notion REST client shared by API routes that write to the BWSC
 * Roadmap database (src/app/api/feedback, src/app/api/submit-review).
 * Deliberately dependency-free (no @notionhq/client) — API routes run in
 * the Vercel serverless bundle, and a raw fetch keeps that bundle small.
 */

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

// Must match scripts/lib/notion-constants.js's BRAIN_DATABASE_ID — duplicated
// here rather than imported because API routes can't require a CommonJS file
// under scripts/ (same convention as src/app/api/autonomous-action/route.ts).
export const BRAIN_DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';

export interface NotionApiResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

export async function notionApi(
  path: string,
  method: string,
  apiKey: string,
  body?: object
): Promise<NotionApiResult> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    // non-JSON body; leave empty
  }
  return { ok: res.ok, status: res.status, json };
}

export async function createNotionPage(
  properties: object,
  apiKey: string
): Promise<{ id: string; url: string }> {
  const res = await notionApi('/pages', 'POST', apiKey, {
    parent: { type: 'data_source_id', data_source_id: BRAIN_DATABASE_ID },
    properties,
  });
  if (!res.ok) {
    throw new Error(`Notion create failed: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  }
  return { id: String(res.json.id), url: String(res.json.url || '') };
}
