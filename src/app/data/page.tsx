'use client';

import { useState } from 'react';
import Link from 'next/link';
import { shows } from '@/data/shows';

type DataView = 'overview' | 'critics' | 'audience' | 'buzz';

export default function DataPage() {
  const [view, setView] = useState<DataView>('overview');

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <Link href="/" className="text-green-400 hover:text-green-300 text-sm mb-4 inline-block">
          ← Back to shows
        </Link>
        <h1 className="text-3xl font-bold text-white">Data Explorer</h1>
        <p className="text-gray-400 mt-2">
          View and explore the raw data behind all show scores. Click on a show to see its full data.
        </p>
      </div>

      {/* View Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-700 pb-4">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'critics', label: 'Critic Reviews' },
          { id: 'audience', label: 'Audience Data' },
          { id: 'buzz', label: 'Buzz Data' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id as DataView)}
            className={`px-4 py-2 rounded-lg transition ${
              view === tab.id
                ? 'bg-green-500 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview Table */}
      {view === 'overview' && (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-900">Show</th>
                  <th className="px-3 py-2 text-left">ID</th>
                  <th className="px-3 py-2 text-left">Venue</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Opening</th>
                  <th className="px-3 py-2 text-center">Critic Score</th>
                  <th className="px-3 py-2 text-center">Critic</th>
                  <th className="px-3 py-2 text-center"># Reviews</th>
                  <th className="px-3 py-2 text-center">Audience</th>
                  <th className="px-3 py-2 text-center"># Platforms</th>
                  <th className="px-3 py-2 text-center">Buzz</th>
                  <th className="px-3 py-2 text-center"># Threads</th>
                  <th className="px-3 py-2 text-center">Confidence</th>
                  <th className="px-3 py-2 text-left">Last Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {shows.map((show) => (
                  <tr key={show.metadata.id} className="hover:bg-gray-750">
                    <td className="px-3 py-2 sticky left-0 bg-gray-800">
                      <Link
                        href={`/data/${show.metadata.slug}`}
                        className="text-green-400 hover:underline font-medium"
                      >
                        {show.metadata.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-gray-400 font-mono text-xs">{show.metadata.id}</td>
                    <td className="px-3 py-2 text-gray-300">{show.metadata.venue}</td>
                    <td className="px-3 py-2">
                      <span className={`status-chip status-${show.metadata.status}`}>
                        {show.metadata.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-300">{show.metadata.openingDate}</td>
                    <td className="px-3 py-2 text-center font-bold text-white">
                      {show.metascore?.score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-blue-400">
                      {show.criticScore?.score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-400">
                      {show.criticScore?.reviewCount ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center text-purple-400">
                      {show.audienceScore?.score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-400">
                      {show.audienceScore?.platforms.length ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center text-yellow-400">
                      {show.buzzScore?.score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-400">
                      {show.buzzScore?.threads.length ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`confidence-badge confidence-${show.confidence?.level ?? 'low'}`}>
                        {show.confidence?.level ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-400 text-xs">
                      {new Date(show.lastUpdated).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Critics Table */}
      {view === 'critics' && (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-900">Show</th>
                  <th className="px-3 py-2 text-left">Outlet</th>
                  <th className="px-3 py-2 text-center">Tier</th>
                  <th className="px-3 py-2 text-left">Critic</th>
                  <th className="px-3 py-2 text-left">Original Rating</th>
                  <th className="px-3 py-2 text-center">Mapped Score</th>
                  <th className="px-3 py-2 text-center">Inferred?</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {shows.flatMap((show) =>
                  (show.criticScore?.reviews || []).map((review, i) => (
                    <tr key={`${show.metadata.id}-${i}`} className="hover:bg-gray-750">
                      <td className="px-3 py-2 sticky left-0 bg-gray-800">
                        <Link
                          href={`/data/${show.metadata.slug}`}
                          className="text-green-400 hover:underline"
                        >
                          {show.metadata.title}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-300">{review.outlet}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          review.tier === 1
                            ? 'bg-green-500/20 text-green-400'
                            : review.tier === 2
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}>
                          T{review.tier}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{review.criticName || '—'}</td>
                      <td className="px-3 py-2 text-gray-300">{review.originalRating}</td>
                      <td className="px-3 py-2 text-center font-bold" style={{
                        color: review.mappedScore >= 70 ? '#22c55e' : review.mappedScore >= 50 ? '#eab308' : '#ef4444'
                      }}>
                        {review.mappedScore}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {review.isInferred ? (
                          <span className="text-yellow-400">Yes</span>
                        ) : (
                          <span className="text-gray-500">No</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-400">{review.publishDate}</td>
                      <td className="px-3 py-2">
                        <a
                          href={review.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:underline text-xs truncate block max-w-[200px]"
                        >
                          {review.url}
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="p-3 bg-gray-900 text-gray-400 text-sm">
            Total: {shows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0)} reviews across {shows.length} shows
          </div>
        </div>
      )}

      {/* Audience Table */}
      {view === 'audience' && (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-900">Show</th>
                  <th className="px-3 py-2 text-left">Platform</th>
                  <th className="px-3 py-2 text-center">Avg Rating</th>
                  <th className="px-3 py-2 text-center">Max Rating</th>
                  <th className="px-3 py-2 text-center">Mapped Score</th>
                  <th className="px-3 py-2 text-center">Review Count</th>
                  <th className="px-3 py-2 text-left">Last Updated</th>
                  <th className="px-3 py-2 text-left">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {shows.flatMap((show) =>
                  (show.audienceScore?.platforms || []).map((platform, i) => (
                    <tr key={`${show.metadata.id}-${i}`} className="hover:bg-gray-750">
                      <td className="px-3 py-2 sticky left-0 bg-gray-800">
                        <Link
                          href={`/data/${show.metadata.slug}`}
                          className="text-green-400 hover:underline"
                        >
                          {show.metadata.title}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-300">{platform.platformName}</td>
                      <td className="px-3 py-2 text-center text-gray-300">{platform.averageRating}</td>
                      <td className="px-3 py-2 text-center text-gray-400">{platform.maxRating}</td>
                      <td className="px-3 py-2 text-center font-bold" style={{
                        color: platform.mappedScore >= 70 ? '#22c55e' : platform.mappedScore >= 50 ? '#eab308' : '#ef4444'
                      }}>
                        {platform.mappedScore}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-300">
                        {platform.reviewCount?.toLocaleString() ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-400 text-xs">
                        {new Date(platform.lastUpdated).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        {platform.url ? (
                          <a
                            href={platform.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline text-xs truncate block max-w-[200px]"
                          >
                            {platform.url}
                          </a>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Buzz Table */}
      {view === 'buzz' && (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-900">Show</th>
                  <th className="px-3 py-2 text-left">Platform</th>
                  <th className="px-3 py-2 text-left">Subreddit</th>
                  <th className="px-3 py-2 text-left">Title</th>
                  <th className="px-3 py-2 text-center">Upvotes</th>
                  <th className="px-3 py-2 text-center">Comments</th>
                  <th className="px-3 py-2 text-center">Sentiment</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {shows.flatMap((show) =>
                  (show.buzzScore?.threads || []).map((thread, i) => (
                    <tr key={`${show.metadata.id}-${i}`} className="hover:bg-gray-750">
                      <td className="px-3 py-2 sticky left-0 bg-gray-800">
                        <Link
                          href={`/data/${show.metadata.slug}`}
                          className="text-green-400 hover:underline"
                        >
                          {show.metadata.title}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-300">{thread.platform}</td>
                      <td className="px-3 py-2 text-gray-400">{thread.subreddit || '—'}</td>
                      <td className="px-3 py-2 text-gray-300 max-w-[300px] truncate">
                        {thread.title}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-300">{thread.upvotes}</td>
                      <td className="px-3 py-2 text-center text-gray-300">{thread.commentCount}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={
                          thread.sentiment === 'positive'
                            ? 'text-green-400'
                            : thread.sentiment === 'negative'
                            ? 'text-red-400'
                            : 'text-yellow-400'
                        }>
                          {thread.sentiment}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{thread.date}</td>
                      <td className="px-3 py-2">
                        <a
                          href={thread.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:underline text-xs truncate block max-w-[200px]"
                        >
                          {thread.url}
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Data Format Info */}
      <div className="mt-8 bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-4">Data Format</h2>
        <p className="text-gray-300 mb-4">
          Show data is stored in TypeScript files at <code className="bg-gray-700 px-2 py-1 rounded text-sm">src/data/shows.ts</code>.
          To add or edit shows, modify this file directly.
        </p>
        <p className="text-gray-400 text-sm">
          Future updates will include a more streamlined data entry system, potentially with agent-assisted data collection
          for critic reviews, audience scores, and buzz metrics.
        </p>
      </div>
    </div>
  );
}
