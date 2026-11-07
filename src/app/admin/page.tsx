import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import { getAdminMoneySignups } from '@/lib/admin-money-signups';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminPage() {
  if (!(await isAdmin())) notFound();

  const data = await getAdminMoneySignups();
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <Link href="/admin/accounts" className="text-sm text-brand hover:underline">Accounts dashboard</Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold mt-3">Money Scorecard sign-ups</h1>
          <p className="text-sm text-gray-400 mt-1">
            Live on each visit. Owner test addresses excluded. Dates and times are UTC.
          </p>
        </header>
        {'unavailable' in data ? (
          <p role="alert" className="card p-5 text-score-tepid">
            Sign-ups are temporarily unavailable. Reload this page to try again.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-4 mb-6">
              <div className="card p-4 sm:p-5">
                <dt className="text-sm text-gray-400">Total sign-ups</dt>
                <dd className="text-3xl font-bold mt-1 tabular-nums">{data.total.toLocaleString('en-US')}</dd>
              </div>
              <div className="card p-4 sm:p-5">
                <dt className="text-sm text-gray-400">Last 7 days</dt>
                <dd className="text-3xl font-bold mt-1 tabular-nums">{data.last7Days.toLocaleString('en-US')}</dd>
              </div>
            </dl>
            {data.days.length === 0 ? (
              <p className="card p-5 text-gray-400">No sign-ups yet.</p>
            ) : data.days.map((day) => (
              <section key={day.date} aria-label={`Sign-ups on ${day.date}`} className="card p-4 sm:p-5 mb-4">
                <h2 className="font-bold mb-3">
                  <time dateTime={day.date}>{day.date}</time>
                  <span className="text-sm text-gray-400 font-normal ml-2">({day.signups.length})</span>
                </h2>
                <ul className="divide-y divide-white/10">
                  {day.signups.map((signup) => (
                    <li key={signup.email} className="py-3 first:pt-0 last:pb-0 text-sm">
                      <p className="font-medium break-words [overflow-wrap:anywhere]">{signup.email}</p>
                      <dl className="grid sm:grid-cols-[5rem_1fr] gap-x-3 gap-y-1 mt-2">
                        <dt className="text-gray-400">Time</dt>
                        <dd><time dateTime={signup.createdAt}>{signup.createdAt.slice(11, 16)} UTC</time></dd>
                        <dt className="text-gray-400">Role</dt>
                        <dd className="break-words [overflow-wrap:anywhere]">{signup.role}</dd>
                        <dt className="text-gray-400">First page</dt>
                        <dd className="break-words [overflow-wrap:anywhere]">{signup.firstPage}</dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
