import { notFound } from 'next/navigation';
import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { isAdmin } from '@/lib/admin-auth';
import LocksTable, { LockRecord } from './LocksTable';

export const dynamic = 'force-dynamic';

interface LocksPayload {
  generatedAt: string;
  count: number;
  withRationale: number;
  withoutRationale: number;
  locks: LockRecord[];
}

function readLocksJson(): LocksPayload {
  // public/data/admin/locks.json is generated at build/rebuild time. On the
  // dev server we read it from disk directly; on Vercel the file is bundled
  // with the static export under /public.
  const filePath = path.join(process.cwd(), 'public', 'data', 'admin', 'locks.json');
  if (!fs.existsSync(filePath)) {
    return { generatedAt: new Date().toISOString(), count: 0, withRationale: 0, withoutRationale: 0, locks: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as LocksPayload;
}

export default function AdminLocksPage() {
  if (!isAdmin()) {
    notFound();
  }

  const payload = readLocksJson();

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6 flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Score locks</h1>
            <p className="text-sm text-gray-400 mt-1">
              Every review whose score was overridden by a human. Edit or unlock with rationale.
            </p>
            <p className="text-[11px] text-gray-500 mt-1">
              Index generated{' '}
              <time dateTime={payload.generatedAt}>{new Date(payload.generatedAt).toLocaleString()}</time> ·{' '}
              {payload.count} locks · {payload.withRationale} with rationale ·{' '}
              <span className={payload.withoutRationale > 0 ? 'text-score-tepid' : ''}>
                {payload.withoutRationale} pending
              </span>
            </p>
          </div>
          <Link
            href="/admin/locks/new"
            className="px-4 py-2 rounded-lg bg-brand text-black font-semibold text-sm hover:bg-brand/90"
          >
            + Lock a score
          </Link>
        </header>

        <LocksTable locks={payload.locks} />
      </div>
    </div>
  );
}
