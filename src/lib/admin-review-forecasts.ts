import 'server-only';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fetchPrivateText, listPrivateDir } from './private-data-repo';
import { getShowById } from './data';

/**
 * Data for /admin/forecasts (BRO-7348). The pilot ledger lives in the PRIVATE core-data repo
 * (review-forecast-pilot/ledger/*.jsonl, grades/<showId>.json). It is read at request time with
 * REVIEW_TEXTS_TOKEN, exactly like /admin/finances, and only ever called from a page that has
 * already passed isAdmin(). There is deliberately no API route and nothing under public/.
 */
const cjsRequire = createRequire(import.meta.url);
const { buildBoard } = cjsRequire('../../scripts/lib/review-forecast-board') as {
  buildBoard: (o: { ledgerRows: LedgerRow[]; grades: GradeRow[]; titleOf: (id: string) => string | null; today: string }) => Board;
};

export interface LedgerRow { showId: string; recordedAt: string; openingDate: string; forecast: number; [k: string]: unknown }
export interface GradeRow { showId: string; openingDate: string; [k: string]: unknown }
export interface BoardEntry {
  showId: string; title: string; state: 'upcoming' | 'awaiting-grade' | 'graded'; openingDate: string;
  forecast: number | null; lo80: number | null; hi80: number | null; categoryMean: number | null;
  previewAudience: number | null; audienceCount: number | null; forecastRecordedAt: string | null; gradeDueOn: string;
  criticScore: number | null; missForecast: number | null; missCategoryMean: number | null; inRange80: boolean | null;
  confidence: 'High' | 'Medium' | 'Low' | null; confidenceBasis: string | null;
  group: 'soon' | 'later' | 'graded';
  forecastV2: number | null; lo80V2: number | null; hi80V2: number | null; v2UsedShowScore: boolean; missForecastV2: number | null;
}
export interface Board {
  summary: { gradedShows: number; ourMiss: number | null; categoryMiss: number | null; rangeHitRate: number | null; upcomingShows: number; awaitingGrade: number; early: boolean };
  entries: BoardEntry[];
}

// A frozen forecast is the last row before opening and grading happens 14 days after opening, so a
// show needs at most ~15 days of ledger files; graded shows carry their own forecast in the grade row.
const LEDGER_FILES_TO_READ = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; board: Board } | null = null;

const parseJsonl = (text: string): LedgerRow[] =>
  text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow);

async function readRemote(token: string): Promise<{ ledgerRows: LedgerRow[]; grades: GradeRow[] }> {
  const [ledgerNames, gradeNames] = await Promise.all([
    listPrivateDir('review-forecast-pilot/ledger', token),
    listPrivateDir('review-forecast-pilot/grades', token),
  ]);
  const newest = ledgerNames.filter((n) => n.endsWith('.jsonl')).sort().slice(-LEDGER_FILES_TO_READ);
  const [ledgerTexts, gradeTexts] = await Promise.all([
    Promise.all(newest.map((n) => fetchPrivateText(`review-forecast-pilot/ledger/${n}`, token, ''))),
    Promise.all(gradeNames.filter((n) => n.endsWith('.json')).map((n) => fetchPrivateText(`review-forecast-pilot/grades/${n}`, token, ''))),
  ]);
  return { ledgerRows: ledgerTexts.flatMap(parseJsonl), grades: gradeTexts.filter(Boolean).map((t) => JSON.parse(t) as GradeRow) };
}

/** Local screenshots only: a checkout of the private repo's review-forecast-pilot/ directory. Never honored in production builds. */
function readLocal(dir: string): { ledgerRows: LedgerRow[]; grades: GradeRow[] } {
  const ls = (sub: string) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).sort() : []);
  const ledgerRows = ls('ledger').filter((n) => n.endsWith('.jsonl')).slice(-LEDGER_FILES_TO_READ)
    .flatMap((n) => parseJsonl(fs.readFileSync(path.join(dir, 'ledger', n), 'utf8')));
  const grades = ls('grades').filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'grades', n), 'utf8')) as GradeRow);
  return { ledgerRows, grades };
}

export async function getReviewForecastBoard(): Promise<Board | { unavailable: true }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.board;
  try {
    const localDir = process.env.NODE_ENV !== 'production' ? process.env.FORECAST_PILOT_DIR : undefined;
    const token = process.env.REVIEW_TEXTS_TOKEN;
    if (!localDir && !token) return { unavailable: true };
    const { ledgerRows, grades } = localDir ? readLocal(localDir) : await readRemote(token as string);
    const board = buildBoard({
      ledgerRows, grades,
      titleOf: (id) => getShowById(id)?.title ?? null,
      today: new Date().toISOString().slice(0, 10),
    });
    cache = { at: Date.now(), board }; // failures above are never cached
    return board;
  } catch {
    return { unavailable: true };
  }
}
