import { NextResponse } from 'next/server';

const REVIEW_TEXTS_TOKEN = process.env.REVIEW_TEXTS_TOKEN || '';
const SUBMISSIONS_REPO = 'thomaspryor/broadway-scorecard-data';
const SUBMISSIONS_PATH = 'data/beat-the-critics-submissions.jsonl';
const CACHE_TTL_MS = 60 * 1000; // 60s in-memory cache

export interface PickStats {
  totalSubmissions: number;
  picks: Record<string, Record<string, number>>; // category → { nominee title: count }
}

let cache: { data: PickStats; fetchedAt: number } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  if (!REVIEW_TEXTS_TOKEN) {
    return NextResponse.json({ totalSubmissions: 0, picks: {} } satisfies PickStats);
  }

  try {
    const apiUrl = `https://api.github.com/repos/${SUBMISSIONS_REPO}/contents/${SUBMISSIONS_PATH}`;
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${REVIEW_TEXTS_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      if (res.status === 404) {
        const empty: PickStats = { totalSubmissions: 0, picks: {} };
        cache = { data: empty, fetchedAt: Date.now() };
        return NextResponse.json(empty);
      }
      throw new Error(`GitHub GET failed: ${res.status}`);
    }

    const json = await res.json() as { content: string };
    const decoded = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const lines = decoded.split('\n').filter(Boolean);

    const picks: Record<string, Record<string, number>> = {};
    let totalSubmissions = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { picks?: Record<string, string>; ceremonyYear?: number };
        if (!entry.picks) continue;
        totalSubmissions++;
        for (const [category, nominee] of Object.entries(entry.picks)) {
          if (!picks[category]) picks[category] = {};
          picks[category][nominee] = (picks[category][nominee] ?? 0) + 1;
        }
      } catch {
        // malformed line — skip
      }
    }

    const data: PickStats = { totalSubmissions, picks };
    cache = { data, fetchedAt: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    console.error('pick-stats error:', err);
    return NextResponse.json({ totalSubmissions: 0, picks: {} } satisfies PickStats);
  }
}
