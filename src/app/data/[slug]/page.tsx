import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getShowBySlug, shows } from '@/data/shows';

export function generateStaticParams() {
  return shows.map((show) => ({
    slug: show.metadata.slug,
  }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  return {
    title: `${show.metadata.title} Data - Broadway Metascore`,
    description: `Raw data for ${show.metadata.title}`,
  };
}

function JsonBlock({ data, title }: { data: unknown; title: string }) {
  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="bg-gray-900 px-4 py-2 font-medium text-white">{title}</div>
      <pre className="p-4 text-sm text-gray-300 overflow-x-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

export default function ShowDataPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const { metadata, criticScore, audienceScore, buzzScore, metascore, summary, confidence } = show;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <div className="flex gap-4 text-sm mb-4">
          <Link href="/data" className="text-green-400 hover:text-green-300">
            ← Back to data explorer
          </Link>
          <span className="text-gray-600">|</span>
          <Link href={`/show/${metadata.slug}`} className="text-green-400 hover:text-green-300">
            View show page →
          </Link>
        </div>
        <h1 className="text-3xl font-bold text-white">{metadata.title}</h1>
        <p className="text-gray-400 mt-2">Raw data for this show</p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-white">{metascore?.score ?? '—'}</div>
          <div className="text-sm text-gray-400">Overall</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-blue-400">{criticScore?.score ?? '—'}</div>
          <div className="text-sm text-gray-400">Critic ({criticScore?.reviewCount ?? 0})</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-purple-400">{audienceScore?.score ?? '—'}</div>
          <div className="text-sm text-gray-400">Audience ({audienceScore?.platforms.length ?? 0})</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-yellow-400">{buzzScore?.score ?? '—'}</div>
          <div className="text-sm text-gray-400">Buzz ({buzzScore?.threads.length ?? 0})</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className={`text-xl font-bold capitalize ${
            confidence?.level === 'high' ? 'text-green-400' :
            confidence?.level === 'medium' ? 'text-yellow-400' :
            'text-red-400'
          }`}>
            {confidence?.level ?? '—'}
          </div>
          <div className="text-sm text-gray-400">Confidence</div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Metadata */}
        <JsonBlock data={metadata} title="Metadata" />

        {/* Critic Reviews Table */}
        {criticScore && (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="bg-gray-900 px-4 py-2 flex justify-between items-center">
              <span className="font-medium text-white">Critic Reviews ({criticScore.reviewCount})</span>
              <span className="text-blue-400 font-bold">Score: {criticScore.score}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-700/50 text-gray-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Outlet</th>
                    <th className="px-3 py-2 text-center">Tier</th>
                    <th className="px-3 py-2 text-left">Critic</th>
                    <th className="px-3 py-2 text-left">Original</th>
                    <th className="px-3 py-2 text-center">Mapped</th>
                    <th className="px-3 py-2 text-center">Inferred</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">URL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {criticScore.reviews.map((review, i) => (
                    <tr key={i} className="hover:bg-gray-750">
                      <td className="px-3 py-2 text-gray-300 font-medium">{review.outlet}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          review.tier === 1 ? 'bg-green-500/20 text-green-400' :
                          review.tier === 2 ? 'bg-blue-500/20 text-blue-400' :
                          'bg-gray-500/20 text-gray-400'
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
                        {review.isInferred ? '✓' : '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-400">{review.publishDate}</td>
                      <td className="px-3 py-2">
                        <a href={review.url} target="_blank" rel="noopener noreferrer"
                           className="text-blue-400 hover:underline text-xs truncate block max-w-[150px]">
                          Link
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Audience Platforms Table */}
        {audienceScore && (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="bg-gray-900 px-4 py-2 flex justify-between items-center">
              <span className="font-medium text-white">Audience Platforms ({audienceScore.platforms.length})</span>
              <span className="text-purple-400 font-bold">Score: {audienceScore.score}</span>
            </div>
            {audienceScore.divergenceWarning && (
              <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-300 text-sm">
                {audienceScore.divergenceWarning}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-700/50 text-gray-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Platform</th>
                    <th className="px-3 py-2 text-center">Avg Rating</th>
                    <th className="px-3 py-2 text-center">Max</th>
                    <th className="px-3 py-2 text-center">Mapped Score</th>
                    <th className="px-3 py-2 text-center">Review Count</th>
                    <th className="px-3 py-2 text-left">Last Updated</th>
                    <th className="px-3 py-2 text-left">URL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {audienceScore.platforms.map((platform, i) => (
                    <tr key={i} className="hover:bg-gray-750">
                      <td className="px-3 py-2 text-gray-300 font-medium">{platform.platformName}</td>
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
                      <td className="px-3 py-2 text-gray-400">{platform.lastUpdated.split('T')[0]}</td>
                      <td className="px-3 py-2">
                        {platform.url ? (
                          <a href={platform.url} target="_blank" rel="noopener noreferrer"
                             className="text-blue-400 hover:underline text-xs">
                            Link
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Buzz Threads Table */}
        {buzzScore && (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="bg-gray-900 px-4 py-2 flex justify-between items-center">
              <span className="font-medium text-white">Buzz Threads ({buzzScore.threads.length})</span>
              <div className="flex gap-4 text-sm">
                <span className="text-gray-400">Volume: <span className="text-yellow-400">{buzzScore.volumeScore}/50</span></span>
                <span className="text-gray-400">Sentiment: <span className="text-yellow-400">{buzzScore.sentimentScore}/50</span></span>
                <span className="text-yellow-400 font-bold">Score: {buzzScore.score}</span>
              </div>
            </div>
            {buzzScore.stalenessPenalty && (
              <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-300 text-sm">
                -{buzzScore.stalenessPenalty} staleness penalty applied
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-700/50 text-gray-400">
                  <tr>
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
                  {buzzScore.threads.map((thread, i) => (
                    <tr key={i} className="hover:bg-gray-750">
                      <td className="px-3 py-2 text-gray-300">{thread.platform}</td>
                      <td className="px-3 py-2 text-gray-400">{thread.subreddit || '—'}</td>
                      <td className="px-3 py-2 text-gray-300 max-w-[200px] truncate">{thread.title}</td>
                      <td className="px-3 py-2 text-center text-gray-300">{thread.upvotes}</td>
                      <td className="px-3 py-2 text-center text-gray-300">{thread.commentCount}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={
                          thread.sentiment === 'positive' ? 'text-green-400' :
                          thread.sentiment === 'negative' ? 'text-red-400' :
                          'text-yellow-400'
                        }>
                          {thread.sentiment}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{thread.date}</td>
                      <td className="px-3 py-2">
                        <a href={thread.url} target="_blank" rel="noopener noreferrer"
                           className="text-blue-400 hover:underline text-xs">
                          Link
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Metascore Breakdown */}
        {metascore && (
          <JsonBlock data={metascore} title="Metascore Calculation" />
        )}

        {/* Summary */}
        {summary && (
          <JsonBlock data={summary} title="Summary" />
        )}

        {/* Confidence */}
        {confidence && (
          <JsonBlock data={confidence} title="Confidence" />
        )}

        {/* Full Raw JSON */}
        <details className="bg-gray-800 rounded-lg overflow-hidden">
          <summary className="bg-gray-900 px-4 py-2 font-medium text-white cursor-pointer hover:bg-gray-800">
            Full Raw JSON
          </summary>
          <pre className="p-4 text-xs text-gray-300 overflow-x-auto max-h-[500px]">
            {JSON.stringify(show, null, 2)}
          </pre>
        </details>
      </div>

      {/* Record Info */}
      <div className="mt-8 text-sm text-gray-500 border-t border-gray-700 pt-4">
        <div className="flex flex-wrap gap-4">
          <span>Created: {show.createdAt.split('T')[0]}</span>
          <span>•</span>
          <span>Last updated: {show.lastUpdated.split('T')[0]}</span>
          <span>•</span>
          <span>ID: <code className="text-xs bg-gray-800 px-1 rounded">{metadata.id}</code></span>
        </div>
      </div>
    </div>
  );
}
